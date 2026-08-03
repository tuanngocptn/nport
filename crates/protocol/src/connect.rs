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
use quinn::{RecvStream, SendStream};
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
pub async fn read_stream_kind(recv: &mut RecvStream) -> Result<StreamKind, FrameError> {
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
pub async fn read_version(recv: &mut RecvStream) -> Result<(), FrameError> {
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
pub async fn read_connect_request(recv: &mut RecvStream) -> Result<ConnectRequest, FrameError> {
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
pub async fn write_connect_response(
    send: &mut SendStream,
    status: u16,
    headers: &[(String, String)],
) -> Result<(), FrameError> {
    write_response_message(send, None, Some(status), headers).await
}

/// Writes an error `ConnectResponse`. Upstream pairs the error with `HttpStatus: 502`.
pub async fn write_error_response(send: &mut SendStream, error: &str) -> Result<(), FrameError> {
    write_response_message(send, Some(error), Some(502), &[]).await
}

async fn write_response_message(
    send: &mut SendStream,
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
