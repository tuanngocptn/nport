//! Per-stream framing: signatures, the version byte, and the `ConnectRequest` /
//! `ConnectResponse` codecs.
//!
//! `docs/PROTOCOL.md` §6, §7, §11.
//!
//! ```text
//! edge   → client:  0A 36 CD 12 A1 3E | "01" | capnp ConnectRequest  | raw body
//! client → edge:    0A 36 CD 12 A1 3E | "01" | capnp ConnectResponse | raw body
//! ```
//!
//! **There is no HTTP/1.1 request line or header block on the stream.** Headers travel
//! entirely inside `ConnectRequest.metadata`, and end-of-body is QUIC stream FIN.

use capnp::message;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio_util::compat::{TokioAsyncReadCompatExt as _, TokioAsyncWriteCompatExt as _};

use crate::schema::quic_metadata_protocol_capnp::{
    ConnectionType as WireConnectionType, connect_request, connect_response,
};

/// Marks a data stream.
///
/// cloudflared: `tunnelrpc/quic/protocol.go` → `dataStreamProtocolSignature`.
pub const DATA_SIGNATURE: [u8; 6] = [0x0A, 0x36, 0xCD, 0x12, 0xA1, 0x3E];

/// Marks an RPC stream. Used for UDP session management, which NPort does not implement
/// (ADR-0020) — kept so an unexpected one is recognised rather than misparsed.
///
/// cloudflared: `tunnelrpc/quic/protocol.go` → `rpcStreamProtocolSignature`.
pub const RPC_SIGNATURE: [u8; 6] = [0x52, 0xBB, 0x82, 0x5C, 0xDB, 0x65];

/// Protocol version, ASCII. Upstream comments it as a deliberate branch point for future
/// versions, which makes it a silent-change hook — risk P4.
///
/// cloudflared: `tunnelrpc/quic/protocol.go` → `protocolV1`.
pub const PROTOCOL_V1: [u8; 2] = *b"01";

/// The full 8-byte data-stream preamble as a single buffer.
///
/// **Write this with one `write_all`.** Upstream's `readVersion` uses a bare `Read` rather
/// than `ReadFull`, so a peer that splits the two version bytes across packets desyncs the
/// reader (§6, trap 2). Having it as one constant makes that the easy path.
pub const DATA_PREAMBLE: [u8; 8] = [0x0A, 0x36, 0xCD, 0x12, 0xA1, 0x3E, b'0', b'1'];

/// Metadata key for the request method.
pub const HTTP_METHOD: &str = "HttpMethod";
/// Metadata key for the value of the `Host` header.
pub const HTTP_HOST: &str = "HttpHost";
/// Metadata key for the response status, as a decimal string.
pub const HTTP_STATUS: &str = "HttpStatus";
/// Metadata key prefix for headers — **one entry per header value**, so repeated headers
/// produce repeated entries.
pub const HTTP_HEADER_PREFIX: &str = "HttpHeader:";
/// Metadata key for the tracing correlation ID.
pub const FLOW_ID: &str = "FlowID";
/// Set by the edge when it rate-limited the flow rather than the origin failing. Worth
/// surfacing distinctly.
///
/// cloudflared: `tunnelrpc/pogs/quic_metadata_protocol.go` → `ErrorFlowConnectRateLimitedMetadata`.
pub const FLOW_RATE_LIMITED: &str = "FlowConnectRateLimited";

/// Headers that describe a single hop and must not be relayed — in either direction.
///
/// RFC 9110 §7.6.1, plus `proxy-connection`, which the RFC never standardised but which is
/// hop-by-hop wherever it appears.
///
/// **`content-length` is deliberately not here.** It is end-to-end: a proxy that buffers a
/// body has to recompute it, and one that streams has to forward it. Which of those applies
/// is the caller's decision, not this predicate's.
pub const HOP_BY_HOP_HEADERS: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Whether a header name is hop-by-hop, compared ASCII-case-insensitively.
///
/// Header names arrive from the edge in whatever case the client sent, so a `matches!` on
/// lowercase literals silently passes `Transfer-Encoding` through.
#[must_use]
pub fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP_HEADERS
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

/// The headers a proxy must **re-add** toward the origin for a `websocket` exchange.
///
/// The edge does not send them: `Connection` and `Upgrade` are hop-by-hop and cannot survive
/// the edge's own HTTP hop, so the upgrade is signalled by `ConnectRequest.type` instead. The
/// origin is an ordinary HTTP/1.1 server and will not upgrade without them.
///
/// `Sec-Websocket-Key` is **not** in this list on purpose — it is client-specific and arrives
/// in the metadata like any other header. The origin derives `Sec-Websocket-Accept` from it,
/// so substituting our own key would make the client reject the handshake.
///
/// cloudflared: `proxy/proxy.go` → `proxyHTTPRequest`, the `isWebsocket` branch, which sets
/// exactly these three and zeroes `ContentLength`.
pub const WEBSOCKET_ORIGIN_HEADERS: [(&str, &str); 3] = [
    ("connection", "Upgrade"),
    ("upgrade", "websocket"),
    ("sec-websocket-version", "13"),
];

/// What kind of stream the peer opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    /// A request/response exchange.
    Data,
    /// Session-management RPC. Out of scope for 3.0.
    Rpc,
}

/// What the edge is asking us to connect to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionType {
    /// Ordinary HTTP. `dest` is the full request URL.
    Http,
    /// WebSocket upgrade. `dest` is the full request URL.
    Websocket,
    /// Raw TCP. `dest` is `addr:port`. Not used by NPort 3.0.
    Tcp,
}

/// Errors from reading or writing a frame.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    /// The stream ended or failed while reading.
    #[error("could not read from the stream")]
    Read(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// Writing to the stream failed.
    #[error("could not write to the stream")]
    Write(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The first six bytes matched no known signature.
    #[error("unrecognised stream signature {0:02x?}")]
    UnknownSignature([u8; 6]),
    /// The version bytes were not `01`.
    ///
    /// **This is the shape an edge protocol bump takes.** Upstream comments the version as
    /// a no-op branch point for exactly this purpose (risk P4), so treat it as a signal to
    /// investigate rather than a transient fault.
    #[error("unsupported protocol version {0:02x?}, expected \"01\"")]
    UnsupportedVersion([u8; 2]),
    /// The Cap'n Proto message was absent or unreadable.
    #[error("could not decode the Cap'n Proto message")]
    Capnp(#[source] capnp::Error),
    /// The message decoded but a field was not interpretable.
    #[error("malformed frame: {0}")]
    Malformed(String),
}

impl From<capnp::Error> for FrameError {
    fn from(error: capnp::Error) -> Self {
        Self::Capnp(error)
    }
}

impl From<capnp::NotInSchema> for FrameError {
    fn from(error: capnp::NotInSchema) -> Self {
        // An unknown ConnectionType is an edge-side addition, not our bug.
        Self::Malformed(format!("unknown enum discriminant: {error}"))
    }
}

impl From<std::str::Utf8Error> for FrameError {
    fn from(error: std::str::Utf8Error) -> Self {
        Self::Malformed(format!("text field is not UTF-8: {error}"))
    }
}

/// A decoded `ConnectRequest`.
#[derive(Debug, Clone)]
pub struct ConnectRequest {
    /// The full request URL for `http`/`websocket`, or `addr:port` for `tcp`.
    pub dest: String,
    /// Which kind of connection the edge wants.
    pub kind: ConnectionType,
    /// Metadata in wire order. Kept as a list rather than a map because repeated headers
    /// are represented as repeated entries and collapsing them would lose values.
    pub metadata: Vec<(String, String)>,
}

impl ConnectRequest {
    /// First value for a metadata key.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.metadata
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The HTTP method, if present.
    #[must_use]
    pub fn method(&self) -> Option<&str> {
        self.get(HTTP_METHOD)
    }

    /// The value for the `Host` header, if present.
    #[must_use]
    pub fn host(&self) -> Option<&str> {
        self.get(HTTP_HOST)
    }

    /// Every header as `(name, value)`, preserving duplicates and order.
    pub fn headers(&self) -> impl Iterator<Item = (&str, &str)> {
        self.metadata.iter().filter_map(|(key, value)| {
            key.strip_prefix(HTTP_HEADER_PREFIX)
                .map(|name| (name, value.as_str()))
        })
    }

    /// The path-and-query portion of [`Self::dest`].
    ///
    /// Deliberately not a full URL parse: the edge sends an absolute URL and the origin
    /// request needs the origin-form target. Falls back to `/` rather than failing, because
    /// a request is better served than dropped.
    #[must_use]
    pub fn path_and_query(&self) -> &str {
        let after_scheme = self
            .dest
            .find("://")
            .map_or(self.dest.as_str(), |index| &self.dest[index + 3..]);
        after_scheme
            .find('/')
            .map_or("/", |index| &after_scheme[index..])
    }
}

/// Reads the six-byte signature that opens every stream except the control stream.
///
/// The control stream carries **no** signature (§6, trap 1) — do not call this on it.
///
/// Generic over the stream rather than taking a `quinn::RecvStream`, for two reasons that both
/// matter: `src/h2.rs` is the ADR-0017 fallback and carries the same frames over an HTTP/2
/// body, and a plain `&[u8]` is what makes these codecs testable without a network at all.
/// Builds the HTTP/1.1 request head an origin should see, from a decoded [`ConnectRequest`].
///
/// The mapping is the protocol's, not a policy choice: `docs/PROTOCOL.md` §7 defines the metadata keys
/// (`HttpMethod`, `HttpHost`, and one `HttpHeader:<Name>` entry per header value), so turning them back
/// into a request line and headers belongs beside the codec that decoded them. What the caller does with
/// the head — which socket it goes down, how the body is framed — is `crates/core`'s.
///
/// Three rules, each of which has cost a real bug:
///
/// 1. **`Host` comes from the `HttpHost` metadata key, not the header list.** The edge sends it as
///    metadata, and a stale `host` header would send the origin's virtual-host routing somewhere else.
/// 2. **Hop-by-hop headers are dropped** ([`is_hop_by_hop`]). They describe one connection and relaying
///    them is meaningless at best.
/// 3. **`content-length` is recomputed, never copied.** This is the one that shipped: forwarding the
///    edge's `transfer-encoding: chunked` header while sending an unchunked body made a Next.js app
///    render as hex chunk sizes. The caller passes the length of what it actually has, and a `0` or
///    `None` emits no header at all — a bodyless `GET` must not carry `content-length: 0`.
///
/// `extra` is for headers the caller must add and that must win over anything the edge sent — the
/// WebSocket upgrade set in [`WEBSOCKET_ORIGIN_HEADERS`], which the edge strips before forwarding.
#[must_use]
pub fn request_head(
    request: &ConnectRequest,
    extra: &[(&str, &str)],
    content_length: Option<usize>,
) -> String {
    use std::fmt::Write as _;

    let mut head = format!(
        "{} {} HTTP/1.1\r\n",
        request.method().unwrap_or("GET"),
        request.path_and_query()
    );
    let _ = writeln!(head, "host: {}\r", request.host().unwrap_or("localhost"));

    for (name, value) in request.headers() {
        if name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("content-length")
            || is_hop_by_hop(name)
            || extra
                .iter()
                .any(|(override_name, _)| name.eq_ignore_ascii_case(override_name))
        {
            continue;
        }
        let _ = writeln!(head, "{name}: {value}\r");
    }

    for (name, value) in extra {
        let _ = writeln!(head, "{name}: {value}\r");
    }
    if let Some(length) = content_length.filter(|length| *length > 0) {
        let _ = writeln!(head, "content-length: {length}\r");
    }
    head.push_str("\r\n");
    head
}

pub async fn read_stream_kind<R: AsyncRead + Unpin>(
    recv: &mut R,
) -> Result<StreamKind, FrameError> {
    let mut signature = [0u8; 6];
    recv.read_exact(&mut signature)
        .await
        .map_err(|e| FrameError::Read(Box::new(e)))?;

    match signature {
        DATA_SIGNATURE => Ok(StreamKind::Data),
        RPC_SIGNATURE => Ok(StreamKind::Rpc),
        other => Err(FrameError::UnknownSignature(other)),
    }
}

/// Reads and validates the two-byte version that follows a data-stream signature.
pub async fn read_version<R: AsyncRead + Unpin>(recv: &mut R) -> Result<(), FrameError> {
    let mut version = [0u8; 2];
    recv.read_exact(&mut version)
        .await
        .map_err(|e| FrameError::Read(Box::new(e)))?;

    if version == PROTOCOL_V1 {
        Ok(())
    } else {
        Err(FrameError::UnsupportedVersion(version))
    }
}

/// Reads the `ConnectRequest` that follows the preamble.
pub async fn read_connect_request<R: AsyncRead + Unpin>(
    recv: &mut R,
) -> Result<ConnectRequest, FrameError> {
    let mut reader = recv.compat();
    // `try_read_message` distinguishes a clean stream end from a decode failure — the edge
    // can close without sending, and that is not a protocol error.
    let message =
        capnp_futures::serialize::try_read_message(&mut reader, message::ReaderOptions::new())
            .await?
            .ok_or_else(|| {
                FrameError::Malformed("stream ended before ConnectRequest".to_owned())
            })?;

    let request: connect_request::Reader = message.get_root()?;

    let dest = request.get_dest()?.to_str()?.to_owned();
    let kind = match request.get_type()? {
        WireConnectionType::Http => ConnectionType::Http,
        WireConnectionType::Websocket => ConnectionType::Websocket,
        WireConnectionType::Tcp => ConnectionType::Tcp,
    };

    let mut metadata = Vec::new();
    for entry in request.get_metadata()? {
        metadata.push((
            entry.get_key()?.to_str()?.to_owned(),
            entry.get_val()?.to_str()?.to_owned(),
        ));
    }

    Ok(ConnectRequest {
        dest,
        kind,
        metadata,
    })
}

/// Writes the data preamble followed by a `ConnectResponse`.
///
/// The preamble goes out in a single `write_all` (§6, trap 2). Nothing here is buffered:
/// a `BufWriter` toward the edge stalls SSE and gRPC in ways that are miserable to
/// diagnose (§11).
pub async fn write_connect_response<W: AsyncWrite + Unpin>(
    send: &mut W,
    status: u16,
    headers: &[(String, String)],
) -> Result<(), FrameError> {
    write_response_message(send, None, Some(status), headers).await
}

/// Writes an error `ConnectResponse`. Upstream pairs the error with `HttpStatus: 502`.
pub async fn write_error_response<W: AsyncWrite + Unpin>(
    send: &mut W,
    error: &str,
) -> Result<(), FrameError> {
    write_response_message(send, Some(error), Some(502), &[]).await
}

async fn write_response_message<W: AsyncWrite + Unpin>(
    send: &mut W,
    error: Option<&str>,
    status: Option<u16>,
    headers: &[(String, String)],
) -> Result<(), FrameError> {
    send.write_all(&DATA_PREAMBLE)
        .await
        .map_err(|e| FrameError::Write(Box::new(e)))?;

    let mut builder = message::Builder::new_default();
    {
        let mut response = builder.init_root::<connect_response::Builder>();
        if let Some(error) = error {
            response.set_error(error);
        }

        let entries = usize::from(status.is_some()) + headers.len();
        let mut metadata = response.init_metadata(u32::try_from(entries).map_err(|_| {
            FrameError::Malformed("too many metadata entries for one message".to_owned())
        })?);

        let mut index = 0u32;
        if let Some(status) = status {
            let mut entry = metadata.reborrow().get(index);
            entry.set_key(HTTP_STATUS);
            entry.set_val(status.to_string().as_str());
            index += 1;
        }
        for (name, value) in headers {
            let mut entry = metadata.reborrow().get(index);
            entry.set_key(format!("{HTTP_HEADER_PREFIX}{name}").as_str());
            entry.set_val(value.as_str());
            index += 1;
        }
    }

    let mut writer = send.compat_write();
    capnp_futures::serialize::write_message(&mut writer, &builder).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes a `ConnectRequest` the way the **edge** would, so the reader can be exercised
    /// against bytes it did not produce itself.
    ///
    /// This is a test double, not a fixture. A real fixture has to come from cloudflared or
    /// the live edge (`docs/TESTING.md`) — bytes from this function only prove the reader and
    /// the schema agree, which is still worth asserting but is a weaker claim.
    fn encode_request(dest: &str, kind: WireConnectionType, metadata: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = message::Builder::new_default();
        {
            let mut request = builder.init_root::<connect_request::Builder>();
            request.set_dest(dest);
            request.set_type(kind);
            let mut entries =
                request.init_metadata(u32::try_from(metadata.len()).expect("small in tests"));
            for (index, (key, value)) in metadata.iter().enumerate() {
                let mut entry = entries.reborrow().get(u32::try_from(index).expect("small"));
                entry.set_key(*key);
                entry.set_val(*value);
            }
        }
        let mut out = Vec::new();
        capnp::serialize::write_message(&mut out, &builder).expect("a Vec never fails to write");
        out
    }

    /// `xxd`-style dump, so a snapshot diff is readable by a human at 2am.
    fn hexdump(bytes: &[u8]) -> String {
        bytes
            .chunks(16)
            .enumerate()
            .map(|(row, chunk)| {
                let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
                let ascii: String = chunk
                    .iter()
                    .map(|b| {
                        if b.is_ascii_graphic() {
                            *b as char
                        } else {
                            '.'
                        }
                    })
                    .collect();
                format!("{:08x}  {:<47}  {ascii}", row * 16, hex.join(" "))
            })
            .collect::<Vec<String>>()
            .join("\n")
    }

    #[tokio::test]
    async fn reads_a_data_stream_preamble_then_the_request() {
        // The whole edge→client path, end to end, with no network: signature, version, capnp.
        let mut stream = DATA_PREAMBLE.to_vec();
        stream.extend_from_slice(&encode_request(
            "https://spike.nport.link/a?b=c",
            WireConnectionType::Http,
            &[
                (HTTP_METHOD, "POST"),
                (HTTP_HOST, "spike.nport.link"),
                ("HttpHeader:Content-Type", "application/json"),
            ],
        ));

        let mut reader: &[u8] = &stream;
        assert_eq!(
            read_stream_kind(&mut reader).await.expect("data signature"),
            StreamKind::Data
        );
        read_version(&mut reader).await.expect("version 01");
        let request = read_connect_request(&mut reader)
            .await
            .expect("a well-formed request");

        assert_eq!(request.kind, ConnectionType::Http);
        assert_eq!(request.method(), Some("POST"));
        assert_eq!(request.host(), Some("spike.nport.link"));
        assert_eq!(request.path_and_query(), "/a?b=c");
        // The reader must stop exactly at the end of the capnp message, or the request body
        // that follows on a real stream is lost. This is the guarantee §11 depends on.
        assert!(reader.is_empty(), "{} bytes over-read", reader.len());
    }

    #[tokio::test]
    async fn a_body_after_the_request_survives_the_reader() {
        // The regression test for the bug that shipped in the spike: the reader must not
        // consume into the body. Here the body is checkable rather than merely absent.
        let mut stream = DATA_PREAMBLE.to_vec();
        stream.extend_from_slice(&encode_request(
            "https://x.nport.link/",
            WireConnectionType::Http,
            &[(HTTP_METHOD, "POST")],
        ));
        stream.extend_from_slice(b"hello-body-42");

        let mut reader: &[u8] = &stream;
        read_stream_kind(&mut reader).await.expect("signature");
        read_version(&mut reader).await.expect("version");
        read_connect_request(&mut reader).await.expect("request");
        assert_eq!(reader, b"hello-body-42");
    }

    #[tokio::test]
    async fn decodes_a_websocket_request_as_websocket() {
        let mut stream = DATA_PREAMBLE.to_vec();
        stream.extend_from_slice(&encode_request(
            "https://x.nport.link/socket",
            WireConnectionType::Websocket,
            &[("HttpHeader:Sec-Websocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")],
        ));

        let mut reader: &[u8] = &stream;
        read_stream_kind(&mut reader).await.expect("signature");
        read_version(&mut reader).await.expect("version");
        let request = read_connect_request(&mut reader).await.expect("request");

        assert_eq!(request.kind, ConnectionType::Websocket);
        // The client's key has to survive: the origin derives Sec-Websocket-Accept from it.
        assert_eq!(
            request
                .headers()
                .find(|(name, _)| *name == "Sec-Websocket-Key"),
            Some(("Sec-Websocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="))
        );
    }

    #[tokio::test]
    async fn rejects_an_rpc_signature_as_a_distinct_kind_not_an_error() {
        let mut reader: &[u8] = &RPC_SIGNATURE;
        assert_eq!(
            read_stream_kind(&mut reader).await.expect("rpc signature"),
            StreamKind::Rpc
        );
    }

    #[tokio::test]
    async fn rejects_an_unknown_signature_without_guessing() {
        let bytes = [0xFFu8; 6];
        let mut reader: &[u8] = &bytes;
        assert!(matches!(
            read_stream_kind(&mut reader).await,
            Err(FrameError::UnknownSignature(_))
        ));
    }

    #[tokio::test]
    async fn a_version_other_than_01_is_its_own_error() {
        // Risk P4: upstream comments the version as a branch point for future protocol
        // versions, so this is the exact shape an edge bump takes. It must not be reported as
        // a generic read failure or nobody will notice what happened.
        let bytes = *b"02";
        let mut reader: &[u8] = &bytes;
        assert!(matches!(
            read_version(&mut reader).await,
            Err(FrameError::UnsupportedVersion(v)) if v == *b"02"
        ));
    }

    #[tokio::test]
    async fn a_truncated_stream_is_a_read_error_not_a_panic() {
        let bytes = [0x0Au8, 0x36];
        let mut reader: &[u8] = &bytes;
        assert!(matches!(
            read_stream_kind(&mut reader).await,
            Err(FrameError::Read(_))
        ));
    }

    #[tokio::test]
    async fn a_stream_that_ends_before_the_request_says_so() {
        let mut reader: &[u8] = &[];
        let error = read_connect_request(&mut reader)
            .await
            .expect_err("no message");
        assert!(matches!(error, FrameError::Malformed(_)), "{error:?}");
    }

    #[tokio::test]
    async fn the_response_encoder_writes_the_preamble_before_the_message() {
        let mut out: Vec<u8> = Vec::new();
        write_connect_response(
            &mut out,
            200,
            &[("Content-Type".to_owned(), "text/plain".to_owned())],
        )
        .await
        .expect("a Vec never fails");
        assert_eq!(&out[..8], &DATA_PREAMBLE, "preamble missing or reordered");
        assert!(out.len() > 8, "no capnp message followed the preamble");
    }

    #[tokio::test]
    async fn snapshot_of_a_200_response() {
        // Rule 4 in crates/protocol/CLAUDE.md: a wire-format change needs a reviewed snapshot.
        // This asserts our *encoder* is stable, which is a different claim from the golden
        // fixtures — those assert we agree with cloudflared.
        let mut out: Vec<u8> = Vec::new();
        write_connect_response(
            &mut out,
            200,
            &[
                ("Content-Type".to_owned(), "text/plain".to_owned()),
                ("Content-Length".to_owned(), "2".to_owned()),
            ],
        )
        .await
        .expect("a Vec never fails");
        insta::assert_snapshot!(hexdump(&out));
    }

    #[tokio::test]
    async fn snapshot_of_an_error_response() {
        let mut out: Vec<u8> = Vec::new();
        write_error_response(&mut out, "origin unreachable")
            .await
            .expect("a Vec never fails");
        insta::assert_snapshot!(hexdump(&out));
    }

    #[test]
    fn signatures_match_the_pinned_source() {
        assert_eq!(DATA_SIGNATURE, [0x0A, 0x36, 0xCD, 0x12, 0xA1, 0x3E]);
        assert_eq!(RPC_SIGNATURE, [0x52, 0xBB, 0x82, 0x5C, 0xDB, 0x65]);
        assert_eq!(PROTOCOL_V1, [0x30, 0x31]);
    }

    #[test]
    fn the_preamble_is_one_buffer_of_signature_then_version() {
        // The point of the constant: it cannot be written in two calls by accident.
        assert_eq!(DATA_PREAMBLE.len(), 8);
        assert_eq!(&DATA_PREAMBLE[..6], &DATA_SIGNATURE);
        assert_eq!(&DATA_PREAMBLE[6..], &PROTOCOL_V1);
    }

    #[test]
    fn signatures_are_distinguishable_by_their_first_byte() {
        // Dispatch reads six bytes, but if these ever collided the reader would need to
        // buffer and retry. They do not.
        assert_ne!(DATA_SIGNATURE[0], RPC_SIGNATURE[0]);
    }

    #[test]
    fn hop_by_hop_matching_ignores_case() {
        // The edge relays header names in the client's casing, so a lowercase-only match
        // leaks `Transfer-Encoding` through to the origin.
        assert!(is_hop_by_hop("Transfer-Encoding"));
        assert!(is_hop_by_hop("TE"));
        assert!(is_hop_by_hop("connection"));
        assert!(is_hop_by_hop("Proxy-Connection"));
        assert!(!is_hop_by_hop("Cookie"));
        assert!(!is_hop_by_hop("Authorization"));
    }

    #[test]
    fn content_length_is_not_hop_by_hop() {
        // It is end-to-end. Whether to forward or recompute it belongs to the proxy, and
        // folding it in here would hide that decision.
        assert!(!is_hop_by_hop("content-length"));
        assert!(!is_hop_by_hop("Content-Length"));
    }

    #[test]
    fn the_websocket_upgrade_headers_are_the_three_upstream_re_adds() {
        let names: Vec<&str> = WEBSOCKET_ORIGIN_HEADERS
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            names,
            vec!["connection", "upgrade", "sec-websocket-version"]
        );
        // The client's own key must survive from the metadata — deriving Sec-Websocket-Accept
        // from a key we invented makes the client reject the 101.
        assert!(
            !WEBSOCKET_ORIGIN_HEADERS
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-key"))
        );
    }

    #[test]
    fn two_of_the_upgrade_headers_are_themselves_hop_by_hop() {
        // Which is exactly why they have to be re-added: a correct hop-by-hop filter strips
        // them, so a proxy that only filters produces a request the origin will not upgrade.
        assert!(is_hop_by_hop("connection"));
        assert!(is_hop_by_hop("upgrade"));
        assert!(!is_hop_by_hop("sec-websocket-version"));
    }

    #[test]
    fn websocket_is_a_distinct_connection_type() {
        // ConnectRequest.type is the only upgrade signal on the wire (§11); there is no
        // `Upgrade` header to notice.
        assert_ne!(ConnectionType::Websocket, ConnectionType::Http);
    }

    #[test]
    fn a_request_head_takes_host_from_metadata_not_from_a_header() {
        // The edge sends Host as `HttpHost` metadata (§7). A stale `host` header in the list would
        // send the origin's virtual-host routing somewhere the caller never asked for.
        let request = request(
            "https://myapp.nport.link/health",
            &[
                ("HttpMethod", "GET"),
                ("HttpHost", "myapp.nport.link"),
                ("HttpHeader:Host", "attacker.example"),
            ],
        );

        let head = request_head(&request, &[], None);

        assert!(head.starts_with("GET /health HTTP/1.1\r\n"));
        assert!(head.contains("host: myapp.nport.link\r\n"));
        assert!(!head.contains("attacker.example"));
    }

    #[test]
    fn a_request_head_drops_hop_by_hop_headers() {
        let request = request(
            "https://myapp.nport.link/",
            &[
                ("HttpMethod", "POST"),
                ("HttpHost", "myapp.nport.link"),
                ("HttpHeader:Connection", "keep-alive"),
                ("HttpHeader:Transfer-Encoding", "chunked"),
                ("HttpHeader:Content-Type", "application/json"),
            ],
        );

        let head = request_head(&request, &[], Some(11));

        // The one that shipped: relaying `transfer-encoding: chunked` while sending an unchunked body
        // made a real app render as hex chunk sizes.
        assert!(!head.to_lowercase().contains("transfer-encoding"));
        assert!(!head.to_lowercase().contains("connection:"));
        // Case is preserved as the edge sent it — header names are case-insensitive, but rewriting
        // them is a gratuitous difference an origin could notice.
        assert!(head.contains("Content-Type: application/json\r\n"));
    }

    #[test]
    fn a_request_head_recomputes_content_length_and_never_copies_it() {
        let request = request(
            "https://myapp.nport.link/",
            &[
                ("HttpMethod", "POST"),
                ("HttpHost", "myapp.nport.link"),
                // What the edge claimed. The body we actually hold is what matters.
                ("HttpHeader:Content-Length", "99999"),
            ],
        );

        let head = request_head(&request, &[], Some(4));

        assert!(head.contains("content-length: 4\r\n"));
        assert!(!head.contains("99999"));
    }

    #[test]
    fn a_bodyless_request_carries_no_content_length() {
        // `content-length: 0` on a GET is not wrong so much as noise, and some origins treat it as a
        // signal that a body is coming.
        let request = request(
            "https://myapp.nport.link/",
            &[("HttpMethod", "GET"), ("HttpHost", "myapp.nport.link")],
        );

        for length in [None, Some(0)] {
            let head = request_head(&request, &[], length);
            assert!(
                !head.to_lowercase().contains("content-length"),
                "length {length:?} should emit no header"
            );
        }
    }

    #[test]
    fn extra_headers_win_over_whatever_the_edge_sent() {
        // The WebSocket case: the edge strips the upgrade headers before forwarding, so the connector
        // re-adds them — and if the edge did send a conflicting one, ours has to be the only one left,
        // or the origin sees two `Connection` headers and picks whichever it likes.
        let request = request(
            "https://myapp.nport.link/ws",
            &[
                ("HttpMethod", "GET"),
                ("HttpHost", "myapp.nport.link"),
                ("HttpHeader:Sec-WebSocket-Version", "8"),
            ],
        );

        let head = request_head(&request, &WEBSOCKET_ORIGIN_HEADERS, None);

        assert!(head.contains("sec-websocket-version: 13\r\n"));
        assert_eq!(
            head.to_lowercase().matches("sec-websocket-version").count(),
            1
        );
        assert!(!head.contains(": 8\r\n"));
    }

    #[test]
    fn repeated_headers_all_survive() {
        // Metadata is a list, not a map, precisely so repeated values are not collapsed — two `Set-Cookie`
        // headers arriving as one would silently drop a cookie.
        let request = request(
            "https://myapp.nport.link/",
            &[
                ("HttpMethod", "GET"),
                ("HttpHost", "myapp.nport.link"),
                ("HttpHeader:X-Trace", "one"),
                ("HttpHeader:X-Trace", "two"),
            ],
        );

        let head = request_head(&request, &[], None);

        assert!(head.contains("X-Trace: one\r\n"));
        assert!(head.contains("X-Trace: two\r\n"));
    }

    #[test]
    fn a_request_head_ends_with_a_blank_line() {
        // Without the terminating CRLF the origin waits for more headers and the request hangs.
        let request = request(
            "https://myapp.nport.link/",
            &[("HttpMethod", "GET"), ("HttpHost", "myapp.nport.link")],
        );
        assert!(request_head(&request, &[], None).ends_with("\r\n\r\n"));
    }

    fn request(dest: &str, metadata: &[(&str, &str)]) -> ConnectRequest {
        ConnectRequest {
            dest: dest.to_owned(),
            kind: ConnectionType::Http,
            metadata: metadata
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        }
    }

    #[test]
    fn extracts_method_and_host_from_metadata() {
        let request = request(
            "https://spike.nport.link/health",
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "spike.nport.link")],
        );
        assert_eq!(request.method(), Some("GET"));
        assert_eq!(request.host(), Some("spike.nport.link"));
    }

    #[test]
    fn preserves_repeated_headers_rather_than_collapsing_them() {
        // One metadata entry per header *value*, so a map would silently drop cookies.
        let request = request(
            "https://x.nport.link/",
            &[
                ("HttpHeader:Set-Cookie", "a=1"),
                ("HttpHeader:Set-Cookie", "b=2"),
                ("HttpHeader:Accept", "*/*"),
            ],
        );
        let cookies: Vec<&str> = request
            .headers()
            .filter(|(name, _)| *name == "Set-Cookie")
            .map(|(_, value)| value)
            .collect();
        assert_eq!(cookies, vec!["a=1", "b=2"]);
        assert_eq!(request.headers().count(), 3);
    }

    #[test]
    fn header_iteration_excludes_non_header_metadata() {
        let request = request(
            "https://x.nport.link/",
            &[
                (HTTP_METHOD, "GET"),
                (FLOW_ID, "abc"),
                ("HttpHeader:X", "1"),
            ],
        );
        let names: Vec<&str> = request.headers().map(|(name, _)| name).collect();
        assert_eq!(names, vec!["X"]);
    }

    #[test]
    fn derives_the_origin_form_target_from_an_absolute_url() {
        assert_eq!(
            request("https://spike.nport.link/a/b?c=d", &[]).path_and_query(),
            "/a/b?c=d"
        );
        assert_eq!(
            request("https://spike.nport.link/", &[]).path_and_query(),
            "/"
        );
    }

    #[test]
    fn a_url_with_no_path_still_yields_a_target() {
        // The edge should always send a path, but serving `/` beats dropping the request.
        assert_eq!(
            request("https://spike.nport.link", &[]).path_and_query(),
            "/"
        );
    }
}
