//! The control-plane client: everything `crates/core` says to `api.nport.link`.
//!
//! Five endpoints, one lifecycle (`docs/API.md`): take a challenge, solve it, claim a subdomain,
//! heartbeat every 30 seconds, release on shutdown. **The types are not written here.** They come
//! from `crates/contract`, generated from `packages/contract` (invariant 7), so a field that drifts
//! is a compile error rather than a runtime surprise — which is exactly the bug class v2 shipped.
//!
//! ## Why this speaks HTTP itself
//!
//! ADR-0029. Everything below is built on `tokio-rustls`, `rustls-native-certs`, `aws-lc-rs`, and
//! `serde_json` — all of which the binary already links for the connector. Five JSON endpoints
//! against our own server, with `connection: close` so end-of-socket delimits every response, need
//! roughly a hundred lines that `crates/core` already had in [`crate::proxy`].
//!
//! ## The rules that are not this module's to bend
//!
//! - **The server is authoritative for expiry** (invariant 3). `expiresAt` is displayed and never
//!   enforced locally; v2 enforced its four-hour limit with a client-side `setTimeout`, which meant
//!   the limit was advisory (defect R6).
//! - **`POST /v1/tunnels` is never retried automatically** (`docs/API.md`). It is the one endpoint
//!   that is not idempotent, and a retry that quietly creates a second tunnel spends the caller's
//!   concurrency cap on a tunnel nobody knows about.
//! - **Errors are codes, not prose.** Every failure carries an [`ErrorCode`]; the `message` is kept
//!   only so a bug report can quote it, and matching on it is what ADR-0018 exists to forbid.
//! - **The tunnel token never leaves this module except into a [`TunnelToken`].** It arrives in a
//!   response body, and the only thing done with it is parsing.

use std::sync::Arc;
use std::time::Duration;

use nport_contract::{
    ChallengeResponse, ClientKind, CreateTunnelRequest, CreateTunnelResponse, DeleteTunnelRequest,
    ErrorCode, ErrorEnvelope, HeartbeatRequest, HeartbeatResponse, MetaResponse,
};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _};
use tokio::net::TcpStream;

use crate::proxy::{OriginError, ResponseHead, decode_chunked};

/// How long any single request may take.
///
/// Generous for `POST /v1/tunnels`, which makes about four Cloudflare API calls behind the scenes,
/// and short enough that a wedged network does not look like a hung client.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The production control plane.
pub const DEFAULT_BACKEND: &str = "https://api.nport.link";

/// Ceiling on a response body. The largest of these is a few hundred bytes.
const MAX_RESPONSE_BODY: usize = 256 * 1024;

/// What went wrong talking to the control plane.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// The backend URL could not be understood.
    #[error("the backend address could not be parsed")]
    Backend,
    /// The connection failed, timed out, or died mid-request.
    #[error("could not reach the control plane")]
    Unreachable(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The server answered, and said no.
    ///
    /// **Branch on `code`.** `message` is the server's own English or the caller's language, and it
    /// may change freely (ADR-0018).
    #[error("the control plane refused the request: {code:?}")]
    Refused {
        code: ErrorCode,
        status: u16,
        /// Human-readable, for a bug report. Never match on it.
        message: String,
        /// From `Retry-After`, on a `429` or `503`. Honour it rather than inventing a tighter loop.
        retry_after: Option<Duration>,
    },
    /// The response arrived but was not what the contract describes.
    #[error("the control plane's response could not be understood")]
    Malformed(#[source] Box<dyn std::error::Error + Send + Sync>),
}

impl ApiError {
    /// The code a user should see. Codes, never prose — only `crates/cli` knows the language.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Refused { code, .. } => *code,
            // Everything else is "we could not talk to the control plane", which is what
            // PROVISION_FAILED describes from the client's side.
            Self::Backend | Self::Unreachable(_) | Self::Malformed(_) => ErrorCode::ProvisionFailed,
        }
    }

    /// Whether the caller may try the *same* request again.
    ///
    /// Never consult this for `POST /v1/tunnels`: it is not idempotent, and [`Api::create_tunnel`]
    /// deliberately does not retry.
    #[must_use]
    pub fn retryable(&self) -> bool {
        match self {
            Self::Refused { status, .. } => matches!(status, 429 | 500..=599),
            Self::Unreachable(_) => true,
            Self::Backend | Self::Malformed(_) => false,
        }
    }

    /// How long the server asked us to wait, if it did.
    #[must_use]
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Refused { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

/// Where the control plane lives, taken apart once so every request does not re-parse it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Backend {
    tls: bool,
    host: String,
    port: u16,
    /// Any path the base URL carried, without a trailing slash. Usually empty.
    prefix: String,
}

impl Backend {
    /// Parses `https://api.nport.link` or `http://localhost:8787`.
    ///
    /// Plaintext is supported on purpose: `pnpm dev:api` serves over HTTP, and `--backend` points at
    /// it (`docs/SELF_HOSTING.md`). It is opt-in through the URL and never a fallback — a scheme
    /// that silently downgraded would put a tunnel token on the wire in the clear.
    fn parse(base: &str) -> Result<Self, ApiError> {
        let (scheme, rest) = base.split_once("://").ok_or(ApiError::Backend)?;
        let tls = match scheme {
            "https" => true,
            "http" => false,
            _ => return Err(ApiError::Backend),
        };

        let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
        if authority.is_empty() {
            return Err(ApiError::Backend);
        }

        let (host, port) = match authority.rsplit_once(':') {
            // An IPv6 literal's colons are inside brackets; a port comes after them.
            Some((host, port)) if !host.ends_with(']') => (
                host.to_owned(),
                port.parse().map_err(|_| ApiError::Backend)?,
            ),
            _ => (authority.to_owned(), if tls { 443 } else { 80 }),
        };

        Ok(Self {
            tls,
            host,
            port,
            prefix: format!("/{path}").trim_end_matches('/').to_owned(),
        })
    }
}

/// A client for the NPort control plane.
#[derive(Debug, Clone)]
pub struct Api {
    backend: Backend,
    version: String,
}

impl Api {
    /// A client against `base`, e.g. [`DEFAULT_BACKEND`].
    ///
    /// # Errors
    ///
    /// [`ApiError::Backend`] if the URL is not an `http`/`https` address.
    pub fn new(base: &str) -> Result<Self, ApiError> {
        Ok(Self {
            backend: Backend::parse(base)?,
            version: env!("CARGO_PKG_VERSION").to_owned(),
        })
    }

    /// A challenge to solve. Free and stateless server-side — issuing them cannot be exhausted.
    ///
    /// # Errors
    ///
    /// See [`ApiError`].
    pub async fn challenge(&self) -> Result<ChallengeResponse, ApiError> {
        self.send("GET", "/v1/challenge", None::<&()>).await
    }

    /// The server's current limits, so nothing here has to hardcode them.
    ///
    /// # Errors
    ///
    /// See [`ApiError`].
    pub async fn meta(&self) -> Result<MetaResponse, ApiError> {
        self.send("GET", "/v1/meta", None::<&()>).await
    }

    /// Takes a challenge, solves it, and claims `subdomain` — or a generated name if `None`.
    ///
    /// **Not retried, at any level.** `POST /v1/tunnels` is the one endpoint in the API that is not
    /// idempotent (`docs/API.md`), so a retry can leave a provisioned tunnel nobody holds the tokens
    /// for — which also spends a slot against the caller's concurrency cap until it expires. A
    /// caller that decides to try again must take a **fresh challenge**, which is what calling this
    /// method again does.
    ///
    /// # Errors
    ///
    /// See [`ApiError`]. `POW_REQUIRED` or `CHALLENGE_EXPIRED` means the solve took too long to
    /// arrive — retrying is safe, because no lease was claimed.
    pub async fn create_tunnel(
        &self,
        subdomain: Option<String>,
        client: ClientKind,
    ) -> Result<CreateTunnelResponse, ApiError> {
        let challenge = self.challenge().await?;
        let difficulty = u32::try_from(challenge.difficulty)
            .map_err(|error| ApiError::Malformed(Box::new(error)))?;

        // Blocking work — a 20-bit solve is ~100 ms of hashing — so it goes to a blocking thread
        // rather than stalling the runtime that is also serving a tunnel. `docs/conventions/rust.md`
        // forbids blocking inside an `async fn`, and this is what it means in practice.
        let solving = challenge.challenge.clone();
        let nonce = tokio::task::spawn_blocking(move || solve(&solving, difficulty))
            .await
            .map_err(|error| ApiError::Unreachable(Box::new(error)))?;

        self.send(
            "POST",
            "/v1/tunnels",
            Some(&CreateTunnelRequest {
                challenge: challenge.challenge,
                client,
                nonce,
                subdomain,
            }),
        )
        .await
    }

    /// Renews the lease. Idempotent, cheap, and the only thing keeping the tunnel alive.
    ///
    /// # Errors
    ///
    /// See [`ApiError`]. `TUNNEL_NOT_FOUND` means the lease is gone and the tunnel is over — the
    /// caller should stop rather than keep beating.
    pub async fn heartbeat(
        &self,
        subdomain: &str,
        owner_token: &str,
    ) -> Result<HeartbeatResponse, ApiError> {
        self.send(
            "POST",
            &format!("/v1/tunnels/{subdomain}/heartbeat"),
            Some(&HeartbeatRequest {
                owner_token: owner_token.to_owned(),
            }),
        )
        .await
    }

    /// Releases the lease and tears the tunnel down. Idempotent — a second delete is not an error.
    ///
    /// Skipping this is safe; the lease expires on its own (`docs/API.md`). That is what makes it
    /// correct for a shutdown path to give up on this after one try rather than delaying an exit.
    ///
    /// # Errors
    ///
    /// See [`ApiError`].
    pub async fn delete_tunnel(&self, subdomain: &str, owner_token: &str) -> Result<(), ApiError> {
        let _: Empty = self
            .send(
                "DELETE",
                &format!("/v1/tunnels/{subdomain}"),
                Some(&DeleteTunnelRequest {
                    owner_token: owner_token.to_owned(),
                }),
            )
            .await?;
        Ok(())
    }

    /// One request, start to finish.
    async fn send<B: serde::Serialize, T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, ApiError> {
        let request = self.request_bytes(method, path, body)?;

        let answer = tokio::time::timeout(REQUEST_TIMEOUT, self.round_trip(&request))
            .await
            .map_err(|error| ApiError::Unreachable(Box::new(error)))??;

        let (head, body) = answer;
        if head.status >= 400 {
            return Err(refusal(&head, &body));
        }

        // `204 No Content` is a real answer with nothing in it, which `serde_json` cannot parse as a
        // struct — so an empty body becomes `null`, which deserializes into a unit-like type.
        let body = if body.is_empty() {
            b"null".to_vec()
        } else {
            body
        };
        serde_json::from_slice(&body).map_err(|error| ApiError::Malformed(Box::new(error)))
    }

    /// Builds the request head and body.
    fn request_bytes<B: serde::Serialize>(
        &self,
        method: &str,
        path: &str,
        body: Option<&B>,
    ) -> Result<Vec<u8>, ApiError> {
        let payload = match body {
            Some(body) => {
                serde_json::to_vec(body).map_err(|error| ApiError::Malformed(Box::new(error)))?
            }
            None => Vec::new(),
        };

        let mut head = format!(
            "{method} {}{path} HTTP/1.1\r\n\
             host: {}\r\n\
             user-agent: nport/{}\r\n\
             accept: application/json\r\n\
             connection: close\r\n",
            self.backend.prefix, self.backend.host, self.version
        );
        if !payload.is_empty() {
            head.push_str("content-type: application/json\r\n");
            head.push_str(&format!("content-length: {}\r\n", payload.len()));
        }
        head.push_str("\r\n");

        let mut request = head.into_bytes();
        request.extend_from_slice(&payload);
        Ok(request)
    }

    /// Connects, writes the request, reads the whole answer.
    async fn round_trip(&self, request: &[u8]) -> Result<(ResponseHead, Vec<u8>), ApiError> {
        let socket = TcpStream::connect((self.backend.host.as_str(), self.backend.port))
            .await
            .map_err(|error| ApiError::Unreachable(Box::new(error)))?;
        // Nagle would hold a small request back waiting for more; there is no more.
        let _ = socket.set_nodelay(true);

        if self.backend.tls {
            let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config()?));
            let name = rustls::pki_types::ServerName::try_from(self.backend.host.clone())
                .map_err(|error| ApiError::Unreachable(Box::new(error)))?;
            let stream = connector
                .connect(name, socket)
                .await
                .map_err(|error| ApiError::Unreachable(Box::new(error)))?;
            exchange(stream, request).await
        } else {
            exchange(socket, request).await
        }
    }
}

/// A response with no body. `DELETE` answers `204`.
#[derive(Debug, serde::Deserialize)]
struct Empty;

/// Writes the request and reads the response off one stream.
async fn exchange<S>(mut stream: S, request: &[u8]) -> Result<(ResponseHead, Vec<u8>), ApiError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stream
        .write_all(request)
        .await
        .map_err(|error| ApiError::Unreachable(Box::new(error)))?;
    stream
        .flush()
        .await
        .map_err(|error| ApiError::Unreachable(Box::new(error)))?;

    let head = ResponseHead::read(&mut stream)
        .await
        .map_err(|error| ApiError::Unreachable(Box::new(error)))?;

    // `connection: close` was sent, so end-of-socket delimits the body and no length is needed to
    // know where it stops. Bounded anyway: a control plane that answers with a gigabyte is one this
    // client should refuse rather than follow.
    let mut raw = head.leftover.clone();
    let mut scratch = vec![0u8; 8 * 1024];
    loop {
        use tokio::io::AsyncReadExt as _;
        let read = stream
            .read(&mut scratch)
            .await
            .map_err(|error| ApiError::Unreachable(Box::new(error)))?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&scratch[..read]);
        if raw.len() > MAX_RESPONSE_BODY {
            return Err(ApiError::Malformed(Box::new(OriginError::HeadTooLarge)));
        }
    }

    // Workers answer chunked when they stream a response, which they do for anything not built from
    // a fixed string. Buffered rather than streamed here — these bodies are a few hundred bytes.
    let body = if head.chunked {
        decode_chunked(&raw).map_err(|error| ApiError::Malformed(Box::new(error)))?
    } else {
        raw
    };

    Ok((head, body))
}

/// Turns a 4xx/5xx into a typed refusal.
///
/// A response that is not the documented envelope still becomes a refusal rather than a parse
/// error: the status is real, and reporting "malformed" would hide a `503` from a proxy or a
/// Cloudflare error page in front of the API.
fn refusal(head: &ResponseHead, body: &[u8]) -> ApiError {
    let retry_after = head
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
        .and_then(|(_, value)| value.trim().parse().ok())
        .map(Duration::from_secs);

    if let Ok(envelope) = serde_json::from_slice::<ErrorEnvelope>(body) {
        return ApiError::Refused {
            code: envelope.error.code,
            status: head.status,
            message: envelope.error.message,
            retry_after,
        };
    }

    // The full envelope requires `requestId` and `docsUrl`, and the code is the only field anything
    // branches on. Losing `SUBDOMAIN_IN_USE` because a proxy stripped a documentation link would be
    // precisely the brittleness ADR-0018 exists to remove, so the code is read on its own before
    // the body is given up on.
    if let Ok(minimal) = serde_json::from_slice::<MinimalEnvelope>(body) {
        return ApiError::Refused {
            code: minimal.error.code,
            status: head.status,
            message: minimal.error.message.unwrap_or_default(),
            retry_after,
        };
    }

    ApiError::Refused {
        code: match head.status {
            429 => ErrorCode::RateLimited,
            // Not `UPSTREAM_CLOUDFLARE_ERROR`: that code means *the API* had trouble talking to
            // Cloudflare, which is a claim this client cannot make about a body it could not read.
            _ => ErrorCode::ProvisionFailed,
        },
        status: head.status,
        message: String::new(),
        retry_after,
    }
}

/// Just the code, for a body that is nearly the envelope. See [`refusal`].
#[derive(Debug, serde::Deserialize)]
struct MinimalEnvelope {
    error: MinimalError,
}

#[derive(Debug, serde::Deserialize)]
struct MinimalError {
    code: ErrorCode,
    #[serde(default)]
    message: Option<String>,
}

/// TLS against the public root store. No pinning: `api.nport.link` uses an ordinary public
/// certificate, unlike the QUIC edge (`docs/PROTOCOL.md` §5).
fn tls_config() -> Result<rustls::ClientConfig, ApiError> {
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        // Platform stores routinely hold oddities; one unparseable root is not a reason to fail.
        let _ = roots.add(cert);
    }
    if roots.is_empty() {
        return Err(ApiError::Unreachable(Box::new(std::io::Error::other(
            "no system certificate roots are available",
        ))));
    }

    Ok(rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| ApiError::Unreachable(Box::new(error)))?
    .with_root_certificates(roots)
    .with_no_client_auth())
}

/// Finds a nonce whose `SHA-256("<challenge>.<nonce>")` starts with `bits` zero bits.
///
/// **Bit-level, not "N leading hex zeros"**, and the two are not interchangeable: hex digits can
/// only express multiples of four, which turns the difficulty dial into a 16x jump between 16 and 20
/// bits. The server raises this gradually under load (ADR-0028), so the granularity is the point.
///
/// Blocking, deliberately: it is a hash loop with no I/O in it. [`Api::create_tunnel`] runs it on a
/// blocking thread.
#[must_use]
pub fn solve(challenge: &str, bits: u32) -> String {
    let mut nonce = 0u64;
    loop {
        let candidate = nonce.to_string();
        if satisfies(challenge, &candidate, bits) {
            return candidate;
        }
        nonce += 1;
    }
}

/// Whether `SHA-256("<challenge>.<nonce>")` starts with at least `bits` zero bits.
#[must_use]
pub fn satisfies(challenge: &str, nonce: &str, bits: u32) -> bool {
    let digest = aws_lc_rs::digest::digest(
        &aws_lc_rs::digest::SHA256,
        format!("{challenge}.{nonce}").as_bytes(),
    );

    let mut remaining = bits;
    for byte in digest.as_ref() {
        if remaining == 0 {
            return true;
        }
        if remaining >= 8 {
            if *byte != 0 {
                return false;
            }
            remaining -= 8;
            continue;
        }
        // The final partial byte: its top `remaining` bits must be zero.
        return byte >> (8 - remaining) == 0;
    }
    remaining == 0
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt as _;
    use tokio::net::TcpListener;

    use super::*;

    /// A one-shot HTTP server that records the request and answers with `response`.
    async fn server(response: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let seen = read_request(&mut socket).await;
            socket
                .write_all(response.as_bytes())
                .await
                .expect("respond");
            socket.shutdown().await.expect("shutdown");
            seen
        });

        (format!("http://{addr}"), served)
    }

    /// Reads exactly one request: the head, then as many body bytes as it declared.
    ///
    /// **Not `read_to_end`.** The client keeps its half of the connection open while it waits for an
    /// answer — as any HTTP client does — so reading to end here would wait for a close that only
    /// comes after the response this function has not sent yet.
    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut seen = Vec::new();
        let mut byte = [0u8; 1];

        while !seen.ends_with(b"\r\n\r\n") {
            if socket.read(&mut byte).await.expect("read") == 0 {
                return String::from_utf8_lossy(&seen).into_owned();
            }
            seen.extend_from_slice(&byte);
        }

        let length = String::from_utf8_lossy(&seen)
            .to_lowercase()
            .split("content-length:")
            .nth(1)
            .and_then(|rest| rest.split("\r\n").next())
            .and_then(|value| value.trim().parse::<usize>().ok());
        if let Some(length) = length {
            let mut body = vec![0u8; length];
            socket.read_exact(&mut body).await.expect("read body");
            seen.extend_from_slice(&body);
        }

        String::from_utf8_lossy(&seen).into_owned()
    }

    /// A body-carrying response, with the length filled in — the shape a Worker returns.
    macro_rules! json_response {
        ($status:expr, $body:expr) => {
            concat!(
                "HTTP/1.1 ",
                $status,
                "\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n",
                $body
            )
        };
    }

    #[test]
    fn a_backend_url_is_taken_apart_once() {
        let https = Backend::parse("https://api.nport.link").expect("parses");
        assert!(https.tls);
        assert_eq!(https.port, 443);
        assert_eq!(https.prefix, "");

        // `pnpm dev:api` serves plaintext, and `--backend` points at it.
        let local = Backend::parse("http://localhost:8787").expect("parses");
        assert!(!local.tls);
        assert_eq!(local.port, 8787);

        let prefixed = Backend::parse("https://example.test/nport/").expect("parses");
        assert_eq!(prefixed.prefix, "/nport");
    }

    #[test]
    fn a_scheme_that_is_not_http_is_refused_rather_than_guessed() {
        // A downgrade here would put a tunnel token on the wire in the clear, so an unknown scheme
        // fails rather than falling back to something.
        assert!(matches!(Backend::parse("ftp://x"), Err(ApiError::Backend)));
        assert!(matches!(
            Backend::parse("api.nport.link"),
            Err(ApiError::Backend)
        ));
    }

    #[tokio::test]
    async fn a_challenge_is_fetched_and_read() {
        let (base, served) = server(json_response!(
            "200 OK",
            r#"{"challenge":"abc.def","difficulty":4,"expiresAt":1785000000000}"#
        ))
        .await;

        let api = Api::new(&base).expect("backend");
        let challenge = api.challenge().await.expect("a challenge");
        let request = served.await.expect("server task");

        assert!(
            request.starts_with("GET /v1/challenge HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.to_lowercase().contains("user-agent: nport/"),
            "{request}"
        );
        assert_eq!(challenge.challenge, "abc.def");
        assert_eq!(challenge.difficulty, 4);
    }

    #[tokio::test]
    async fn creating_a_tunnel_solves_the_challenge_first() {
        // Two requests on one client: the challenge, then the create carrying a nonce that actually
        // satisfies it. The listener below serves them in order.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let served = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in [
                json_response!(
                    "200 OK",
                    r#"{"challenge":"c.h","difficulty":8,"expiresAt":1785000000000}"#
                ),
                json_response!(
                    "201 Created",
                    r#"{"expiresAt":1785000000000,"ownerToken":"owner","subdomain":"myapp","tunnelId":"t","tunnelToken":"tok","url":"https://myapp.nport.link"}"#
                ),
            ] {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let seen = read_request(&mut socket).await;
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("respond");
                socket.shutdown().await.expect("shutdown");
                requests.push(seen);
            }
            requests
        });

        let api = Api::new(&format!("http://{addr}")).expect("backend");
        let created = api
            .create_tunnel(Some("myapp".to_owned()), ClientKind::Cli)
            .await
            .expect("a tunnel");
        let requests = served.await.expect("server task");

        assert_eq!(created.url, "https://myapp.nport.link");
        assert_eq!(created.subdomain, "myapp");

        let create = &requests[1];
        assert!(
            create.starts_with("POST /v1/tunnels HTTP/1.1\r\n"),
            "{create}"
        );
        let body: CreateTunnelRequest =
            serde_json::from_str(create.split("\r\n\r\n").nth(1).expect("a body")).expect("json");
        assert_eq!(body.subdomain.as_deref(), Some("myapp"));
        assert!(
            satisfies("c.h", &body.nonce, 8),
            "the nonce sent must actually solve the challenge, got {:?}",
            body.nonce
        );
    }

    #[tokio::test]
    async fn omitting_the_subdomain_omits_the_field_rather_than_sending_null() {
        // `nport 3000` — no `-s`, the most common invocation and the one the README leads with.
        //
        // The contract says `subdomain: requestedSubdomainSchema.optional()`, and zod's `.optional()`
        // accepts a **missing key**; `null` is `.nullable()`, a different thing. Without
        // `skip_serializing_if` on the generated struct, `None` went out as `"subdomain": null` and
        // every backend answered 400 INVALID_REQUEST.
        //
        // Asserted on the raw JSON on purpose. Deserializing into `CreateTunnelRequest` maps both
        // `null` and absent to `None`, so a round-trip through the struct cannot see this at all —
        // which is why every existing test passed while the command was broken.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let served = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in [
                json_response!(
                    "200 OK",
                    r#"{"challenge":"c.h","difficulty":4,"expiresAt":1785000000000}"#
                ),
                json_response!(
                    "201 Created",
                    r#"{"expiresAt":1785000000000,"ownerToken":"owner","subdomain":"auto-name","tunnelId":"t","tunnelToken":"tok","url":"https://auto-name.nport.link"}"#
                ),
            ] {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let seen = read_request(&mut socket).await;
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("respond");
                socket.shutdown().await.expect("shutdown");
                requests.push(seen);
            }
            requests
        });

        let api = Api::new(&format!("http://{addr}")).expect("backend");
        api.create_tunnel(None, ClientKind::Cli)
            .await
            .expect("a generated name");
        let requests = served.await.expect("server task");

        let body = requests[1]
            .split("\r\n\r\n")
            .nth(1)
            .expect("a body")
            .to_owned();
        assert!(
            !body.contains("subdomain"),
            "an omitted subdomain must not appear in the body at all, got {body}"
        );
        assert!(
            !body.contains("null"),
            "no field may serialize as null: {body}"
        );
    }

    #[tokio::test]
    async fn a_refusal_carries_its_code_and_not_its_message() {
        // ADR-0018, in one assertion. v2 matched substrings like "currently in use"; this returns a
        // code a caller can branch on, and keeps the message only for a bug report.
        let (base, served) = server(json_response!(
            "409 Conflict",
            r#"{"error":{"code":"SUBDOMAIN_IN_USE","message":"That subdomain is currently in use","requestId":"r1","docsUrl":"https://nport.link/errors/subdomain-in-use"}}"#
        ))
        .await;

        let api = Api::new(&base).expect("backend");
        let error = api.challenge().await.expect_err("a refusal");
        let _ = served.await;

        assert_eq!(error.code(), ErrorCode::SubdomainInUse);
        assert!(
            !error.retryable(),
            "a taken name does not free up by retrying"
        );
    }

    #[tokio::test]
    async fn a_rate_limit_reports_how_long_to_wait() {
        // `docs/API.md`: every 429 and 503 carries Retry-After, and a client must honour it rather
        // than inventing a tighter loop.
        let (base, served) = server(
            "HTTP/1.1 429 Too Many Requests\r\nretry-after: 42\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"slow down\"}}",
        )
        .await;

        let api = Api::new(&base).expect("backend");
        let error = api.challenge().await.expect_err("a refusal");
        let _ = served.await;

        assert_eq!(error.code(), ErrorCode::RateLimited);
        assert!(error.retryable());
        assert_eq!(error.retry_after(), Some(Duration::from_secs(42)));
    }

    #[tokio::test]
    async fn a_code_is_read_even_from_a_partial_envelope() {
        // The code is the only field anything branches on. Refusing to recognise SUBDOMAIN_IN_USE
        // because `docsUrl` was missing would be the brittleness ADR-0018 exists to remove.
        let (base, served) = server(json_response!(
            "409 Conflict",
            r#"{"error":{"code":"SUBDOMAIN_IN_USE"}}"#
        ))
        .await;

        let api = Api::new(&base).expect("backend");
        let error = api.challenge().await.expect_err("a refusal");
        let _ = served.await;

        assert_eq!(error.code(), ErrorCode::SubdomainInUse);
    }

    #[tokio::test]
    async fn an_answer_that_is_not_the_envelope_is_still_a_refusal() {
        // A proxy or an error page in front of the API. Reporting "malformed" would hide a real 503
        // behind a parse error and send whoever is debugging in the wrong direction.
        let (base, served) = server(
            "HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/html\r\nconnection: close\r\n\r\n<html>nope</html>",
        )
        .await;

        let api = Api::new(&base).expect("backend");
        let error = api.challenge().await.expect_err("a refusal");
        let _ = served.await;

        assert!(matches!(error, ApiError::Refused { status: 503, .. }));
        assert!(error.retryable());
    }

    #[tokio::test]
    async fn a_chunked_answer_is_read_like_any_other() {
        // Workers answer chunked whenever they stream, which is most of the time.
        let (base, served) = server(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n1b\r\n{\"expiresAt\":1785000000000}\r\n0\r\n\r\n",
        )
        .await;

        let api = Api::new(&base).expect("backend");
        let renewed = api.heartbeat("myapp", "owner").await.expect("a heartbeat");
        let _ = served.await;

        assert_eq!(renewed.expires_at, 1_785_000_000_000);
    }

    #[tokio::test]
    async fn deleting_sends_the_owner_token_and_accepts_an_empty_answer() {
        // 204 is the documented answer, including for a lease that was already gone — a client
        // retrying after a network blip must not see a failure.
        let (base, served) = server("HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n").await;

        let api = Api::new(&base).expect("backend");
        api.delete_tunnel("myapp", "owner-token")
            .await
            .expect("deletion");
        let request = served.await.expect("server task");

        assert!(
            request.starts_with("DELETE /v1/tunnels/myapp HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.contains("\"ownerToken\":\"owner-token\""),
            "{request}"
        );
    }

    #[tokio::test]
    async fn a_backend_that_is_not_listening_is_reported_as_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);

        let api = Api::new(&format!("http://{addr}")).expect("backend");
        let error = api.challenge().await.expect_err("nothing is listening");

        assert!(matches!(error, ApiError::Unreachable(_)));
        assert!(error.retryable(), "a network blip is worth another try");
    }

    #[test]
    fn a_solved_challenge_satisfies_the_difficulty_it_was_given() {
        // Round-trips the solver against the checker, which is the same check the server runs.
        let nonce = solve("challenge", 10);
        assert!(satisfies("challenge", &nonce, 10));
    }

    #[test]
    fn difficulty_is_counted_in_bits_not_hex_digits() {
        // The distinction the server's own comment calls out: hex digits can only express multiples
        // of four, and 16 bits to 20 bits would be a 16x jump with nothing in between. A nonce that
        // clears 9 bits need not clear 12.
        let nonce = solve("challenge", 9);
        assert!(satisfies("challenge", &nonce, 9));
        assert!(satisfies("challenge", &nonce, 8));
    }

    #[test]
    fn a_nonce_that_does_not_solve_the_challenge_is_rejected() {
        // Deliberately searched for rather than hardcoded: a fixed nonce like "0" satisfies a small
        // difficulty one time in sixteen, and a test that flakes on the security control is the
        // worst kind. This is the exact mistake `apps/api`'s suite made and had to fix.
        let failing = (0..1000)
            .map(|nonce| nonce.to_string())
            .find(|nonce| !satisfies("challenge", nonce, 12))
            .expect("most nonces do not clear 12 bits");
        assert!(!satisfies("challenge", &failing, 12));
    }
}
