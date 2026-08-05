//! One edge-initiated exchange: read the framed request, ask the local origin, frame the answer.
//!
//! This is where `crates/protocol`'s codecs meet [`crate::proxy`]'s origin handling. Neither half
//! knows about the other — the protocol crate "speaks the wire and nothing else", and `proxy` only
//! parses what an HTTP/1.1 server said — so the wiring lives here, in the crate that owns
//! "provision → connect → **proxy** → teardown" (`crates/CLAUDE.md`).
//!
//! ## Generic over the stream, on purpose
//!
//! Nothing here mentions QUIC. The edge hands over a send half and a receive half
//! (`nport_protocol::Transport`), and that is all this module needs — so the whole of it is tested
//! over `tokio::io::duplex` against a loopback origin, with the **real bytes Cloudflare's edge sent**
//! replayed from `crates/protocol/tests/fixtures/`. It is also what lets ADR-0017's HTTP/2 fallback
//! reuse this untouched.
//!
//! ## Nothing is buffered end-to-end
//!
//! Both directions stream. That is not a performance preference: buffering a response to measure it
//! breaks server-sent events, gRPC, and long downloads — the response never starts until the origin
//! has finished producing it, which for SSE is never (`docs/PROTOCOL.md` §11). The bodies here are
//! copied through as they arrive, and the *only* transformation applied is removing chunked framing,
//! which is mandatory rather than optional: forwarding `transfer-encoding: chunked` past a decoder
//! that has already consumed the framing is what made a real Next.js app render its chunk-size lines
//! as page content.

use std::net::SocketAddr;
use std::sync::Arc;

use nport_protocol::connect::{
    self, ConnectRequest, ConnectionType, FrameError, StreamKind, WEBSOCKET_ORIGIN_HEADERS,
};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite,
    AsyncWriteExt as _,
};
use tokio::net::TcpStream;

use crate::inspector::{BodyPreview, Failure, Kind, Observer, Recorder};
use crate::proxy::{MAX_CHUNK_SIZE_LINE, OriginError, ResponseHead, chunk_size};

/// Headers added to every origin request.
///
/// `connection: close` means end-of-socket delimits the origin's response, so no keep-alive state
/// machine is needed to know where a body stops. One TCP connection per exchange is what upstream
/// does under its own connection pooling too, and a dev server on localhost is not where connection
/// reuse pays.
const ORIGIN_HEADERS: [(&str, &str); 1] = [("connection", "close")];

/// Added when the request carries a body of unknown length. See [`http`].
const ORIGIN_HEADERS_STREAMED: [(&str, &str); 2] =
    [("connection", "close"), ("transfer-encoding", "chunked")];

/// What went wrong serving one exchange.
///
/// Split by *whose fault it is*, because that is the only distinction anything upstream acts on: a
/// [`Self::Frame`] is the edge or a protocol change, the origin variants are the user's own server,
/// and [`Self::Relay`] means the tunnel stream died mid-exchange, which is routine.
#[derive(Debug, thiserror::Error)]
pub enum ExchangeError {
    /// The edge's framing could not be read. A protocol change looks like this (risks P4/P5).
    #[error("the edge's request framing could not be read")]
    Frame(#[from] FrameError),
    /// Nothing is listening on the local port, or it refused the connection.
    #[error("the local origin at {addr} could not be reached")]
    OriginUnreachable {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
    /// The origin answered, but not with something that could be relayed.
    #[error("the local origin's response could not be used")]
    Origin(#[from] OriginError),
    /// The tunnel stream or the origin socket failed mid-exchange.
    #[error("the exchange was cut short")]
    Relay(#[from] std::io::Error),
}

impl ExchangeError {
    /// How this failure appears in the traffic inspector.
    fn failure(&self) -> Failure {
        match self {
            // What a Cloudflare protocol change looks like from here (risks P4/P5) — the one code
            // whose documented action is "upgrade NPort".
            Self::Frame(_) => Failure::Code(nport_contract::ErrorCode::EdgeProtocolError),
            // The user's own server. Their next move is to look at their app, not at the tunnel.
            Self::OriginUnreachable { .. } | Self::Origin(_) => {
                Failure::Code(nport_contract::ErrorCode::LocalRequestFailed)
            }
            // One stream died. The tunnel itself is fine, which is why this has no registry code —
            // see `inspector::Failure::CutShort`.
            Self::Relay(_) => Failure::CutShort,
        }
    }
}

/// Serves one stream the edge opened.
///
/// The caller owns concurrency: every exchange is independent, and `crates/core`'s connector spawns
/// one task per stream.
///
/// `sink` is the traffic inspector, or `None` — the CLI attaches nothing and pays nothing for it
/// (`crates/core`'s [`crate::inspector`]).
///
/// # Errors
///
/// See [`ExchangeError`]. A failure here concerns one request, never the connection — the caller
/// keeps serving.
pub async fn handle<S, R>(
    send: S,
    recv: R,
    origin: SocketAddr,
    sink: Option<Arc<dyn Observer>>,
) -> Result<(), ExchangeError>
where
    S: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    // Recorded when this drops, whatever happens to the exchange — including a task aborted at
    // shutdown, which no `return` here would ever see.
    let mut record = Recorder::new(sink);
    let outcome = serve(send, recv, origin, &mut record).await;
    if let Err(error) = &outcome {
        record.failed(error.failure());
    }
    outcome
}

async fn serve<S, R>(
    mut send: S,
    mut recv: R,
    origin: SocketAddr,
    record: &mut Recorder,
) -> Result<(), ExchangeError>
where
    S: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    let kind = connect::read_stream_kind(&mut recv).await?;
    if kind != StreamKind::Data {
        // An RPC stream: remote configuration and management logs (§9). NPort creates its tunnels
        // with `config_src: "cloudflare"`, so there is no local configuration to update and nothing
        // to serve here. Dropping the stream is what a connector does with a feature it advertises
        // through `DEFAULT_FEATURES` but does not implement.
        return Ok(());
    }

    connect::read_version(&mut recv).await?;
    let request = connect::read_connect_request(&mut recv).await?;

    record.request(
        match request.kind {
            ConnectionType::Http => Kind::Http,
            ConnectionType::Websocket => Kind::Websocket,
            ConnectionType::Tcp => Kind::Tcp,
        },
        request.method().unwrap_or("GET"),
        &request.dest,
        request
            .headers()
            .map(|(name, value)| (name.to_owned(), value.to_owned())),
    );

    match request.kind {
        ConnectionType::Http => http(send, recv, origin, &request, record).await,
        ConnectionType::Websocket => websocket(send, recv, origin, &request, record).await,
        ConnectionType::Tcp => {
            // Trivial once the rest works, and deliberately not done: NPort 3.0 exposes HTTP only
            // (ADR-0020). Answering with an error beats leaving the edge waiting on a stream that
            // will never be written.
            connect::write_error_response(&mut send, "tcp is out of scope for nport 3.0").await?;
            send.shutdown().await?;
            Ok(())
        }
    }
}

/// How a request body is framed toward the origin.
///
/// Decided from **metadata**, exactly as upstream does (§11: it strips the body outright when the
/// request is not a WebSocket, is not chunked, and has a zero content length). Deciding by *reading*
/// the stream instead would be a trap worth naming, because it looks more robust: the body is
/// delimited by end-of-stream, so "is there a body?" would mean waiting for the edge's half-close on
/// every bodyless `GET` — a round-trip added to the hot path before the origin is even contacted,
/// and a hang outright if the edge ever holds the stream open for the response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Body {
    /// Nothing follows the `ConnectRequest`.
    None,
    /// A known length, relayed as the edge declared it — so an origin that rejects chunked requests
    /// (still common in PHP and older WSGI stacks) sees the request it expects.
    Length(usize),
    /// Announced chunked, so the length is unknown until end-of-stream and the body is re-framed
    /// chunk by chunk as it arrives.
    Chunked,
}

/// Reads the framing out of the request's metadata.
fn body_plan(request: &ConnectRequest) -> Body {
    let mut length = None;
    for (name, value) in request.headers() {
        if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            // Chunked wins over any length: it is the framing actually on the wire.
            return Body::Chunked;
        }
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse::<usize>().ok();
        }
    }

    match length {
        Some(length) if length > 0 => Body::Length(length),
        _ => Body::None,
    }
}

/// An ordinary HTTP request.
///
/// The body — if [`body_plan`] says there is one — streams rather than being buffered, which is what
/// lets an upload larger than memory work at all.
async fn http<S, R>(
    mut send: S,
    mut recv: R,
    origin: SocketAddr,
    request: &ConnectRequest,
    record: &mut Recorder,
) -> Result<(), ExchangeError>
where
    S: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    let mut upstream =
        TcpStream::connect(origin)
            .await
            .map_err(|source| ExchangeError::OriginUnreachable {
                addr: origin,
                source,
            })?;

    let body = body_plan(request);
    let extra: &[(&str, &str)] = match body {
        Body::Chunked => &ORIGIN_HEADERS_STREAMED,
        Body::None | Body::Length(_) => &ORIGIN_HEADERS,
    };
    // The length is passed to `request_head` rather than forwarded as a header: it drops the edge's
    // `content-length` precisely so it cannot be copied past a re-framing, and hands the decision to
    // the caller that knows what it is actually about to send.
    let length = match body {
        Body::Length(length) => Some(length),
        Body::None | Body::Chunked => None,
    };
    upstream
        .write_all(connect::request_head(request, extra, length).as_bytes())
        .await?;

    let limit = record.body_limit();
    match body {
        Body::None => {}
        Body::Length(length) => {
            let copied = copy_recording(
                &mut (&mut recv).take(length as u64),
                &mut upstream,
                record.request_body(),
                limit,
            )
            .await?;
            if copied != length as u64 {
                // The origin is now waiting for bytes that will never arrive. Failing here drops the
                // connection, which is what upstream does; carrying on would hang until the origin's
                // own timeout.
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the edge ended the request body early",
                )
                .into());
            }
        }
        Body::Chunked => {
            let mut scratch = vec![0u8; 16 * 1024];
            loop {
                let read = recv.read(&mut scratch).await?;
                if read == 0 {
                    break;
                }
                record.request_body().push(&scratch[..read], limit);
                write_chunked(&scratch[..read], &mut upstream).await?;
            }
            // The terminating zero-length chunk. Without it the origin waits for a body that has
            // already finished, and the request hangs until something times out.
            upstream.write_all(b"0\r\n\r\n").await?;
        }
    }

    let head = ResponseHead::read(&mut upstream).await?;
    relay(&mut send, head, upstream, record).await
}

/// A WebSocket upgrade, then a bidirectional byte pipe (§11).
///
/// Two things separate this from [`http`] and both are easy to get wrong:
///
/// * **The upgrade headers have to be put back** ([`WEBSOCKET_ORIGIN_HEADERS`]). The edge signals the
///   upgrade in `ConnectRequest.type` and strips `Connection`/`Upgrade` before forwarding, so an
///   origin that sees only the forwarded headers answers `200` and the client's handshake fails.
/// * **Nothing past the `101` is parsed.** Frames are copied through untouched — no masking, no
///   fragmentation handling, no length checks. That is the protocol's design, and it is also what
///   keeps a WebSocket library out of the connector entirely.
async fn websocket<S, R>(
    mut send: S,
    mut recv: R,
    origin: SocketAddr,
    request: &ConnectRequest,
    record: &mut Recorder,
) -> Result<(), ExchangeError>
where
    S: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    let mut upstream =
        TcpStream::connect(origin)
            .await
            .map_err(|source| ExchangeError::OriginUnreachable {
                addr: origin,
                source,
            })?;

    // No `content-length`: a handshake carries no body, and upstream zeroes it for a WebSocket.
    let head = connect::request_head(request, &WEBSOCKET_ORIGIN_HEADERS, None);
    upstream.write_all(head.as_bytes()).await?;

    let head = ResponseHead::read(&mut upstream).await?;
    if head.status != 101 {
        // The origin declined the upgrade. Relayed as the ordinary response it is, so the client
        // sees the origin's own status rather than a synthesised 502 that hides it.
        return relay(&mut send, head, upstream, record).await;
    }

    record.response(head.status, &head.headers);
    connect::write_connect_response(&mut send, head.status, &head.headers).await?;

    let limit = record.body_limit();
    // Split rather than borrowed twice: the two directions run concurrently, and each fills its own
    // half of the record. Past the 101 those "bodies" are the raw frames of the pipe.
    let (mut upward, mut downward) = (BodyPreview::default(), BodyPreview::default());

    // Anything that arrived immediately after the head is already a frame — **and it belongs in the
    // record, not only on the wire.** A server that pushes initial state sends its greeting in the
    // same segment as the `101`, so these bytes are the common case rather than an edge one. Forwarding
    // them without recording them left the inspector's first downstream frame missing and `total`
    // short, with `truncated()` reporting `false` — so a UI had no way to know it was showing a
    // partial pipe. The two copies below are assigned over `downward`, so this has to come first.
    if !head.leftover.is_empty() {
        downward.push(&head.leftover, limit);
        send.write_all(&head.leftover).await?;
    }

    let (mut origin_read, mut origin_write) = upstream.into_split();

    let to_origin = async {
        copy_recording(&mut recv, &mut origin_write, &mut upward, limit).await?;
        // Half-close, so the origin sees end-of-input and closes its own side. Without it the
        // downstream copy never ends and the stream leaks until the process exits.
        origin_write.shutdown().await
    };
    let to_edge = async {
        copy_recording(&mut origin_read, &mut send, &mut downward, limit)
            .await
            .map(drop)
    };

    // `join!`, not `try_join!`: a close frame arrives on one direction first, and cancelling the
    // other half would truncate the close handshake the peer is waiting to complete.
    //
    // Both results are dropped. Past a successful upgrade there is no error worth reporting — a peer
    // that resets instead of closing cleanly is ordinary WebSocket behaviour, and the exchange is
    // over either way. The traffic inspector is where per-request detail will belong.
    let _ = tokio::join!(to_origin, to_edge);
    *record.request_body() = upward;
    *record.response_body() = downward;
    send.shutdown().await?;
    Ok(())
}

/// Writes the response head as a `ConnectResponse`, then streams the body.
///
/// The `content-length` rule is the one worth reading twice. [`ResponseHead::read`] strips the
/// origin's header so it cannot be copied blindly, and it is put back **only** when the body is
/// being relayed untouched. A dechunked body has a different length than the framing announced, and
/// a `content-length` that disagrees with the bytes truncates the response in the browser — so a
/// chunked response goes out with no length at all and is delimited by end-of-stream, exactly as
/// §11 specifies.
async fn relay<S>(
    send: &mut S,
    head: ResponseHead,
    upstream: TcpStream,
    record: &mut Recorder,
) -> Result<(), ExchangeError>
where
    S: AsyncWrite + Unpin + Send,
{
    let mut headers = head.headers;
    if !head.chunked {
        if let Some(length) = head.content_length {
            headers.push(("content-length".to_owned(), length.to_string()));
        }
    }

    record.response(head.status, &headers);
    connect::write_connect_response(send, head.status, &headers).await?;

    // The bytes read past the head come first, then the rest of the socket. Chained rather than
    // written separately so the dechunker sees one continuous body — a chunk-size line can straddle
    // the boundary.
    let mut body = std::io::Cursor::new(head.leftover).chain(upstream);

    let limit = record.body_limit();
    if head.chunked {
        dechunk(&mut body, send, record.response_body(), limit).await?;
    } else {
        copy_recording(&mut body, send, record.response_body(), limit).await?;
    }

    // End of body is stream FIN (§11). For QUIC this finishes the stream; for the HTTP/2 fallback it
    // ends the body. Without it the edge waits for more.
    send.shutdown().await?;
    Ok(())
}

/// Streams a chunk-framed body through, dropping the framing as it goes.
///
/// The streaming counterpart to [`crate::proxy::decode_chunked`], which the examples use on a body
/// they already hold. Both read sizes through [`chunk_size`], so they cannot disagree about the
/// radix — `1c8d` read as decimal is where this whole bug class starts.
///
/// Trailers after the terminating chunk are dropped: nothing downstream can act on them, and
/// forwarding them would mean inventing somewhere to put them.
async fn dechunk<R, W>(
    src: &mut R,
    dst: &mut W,
    preview: &mut BodyPreview,
    limit: usize,
) -> Result<(), ExchangeError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut src = tokio::io::BufReader::new(src);
    let mut line = Vec::new();

    loop {
        line.clear();
        if read_size_line(&mut src, &mut line).await? == 0 {
            return Err(OriginError::MalformedChunk {
                reason: "ended before the terminating chunk".to_owned(),
            }
            .into());
        }

        let size = chunk_size(line.trim_ascii_end())?;
        if size == 0 {
            return Ok(());
        }

        let mut chunk = (&mut src).take(size as u64);
        let moved = copy_recording(&mut chunk, dst, preview, limit).await?;
        if moved != size as u64 {
            return Err(OriginError::MalformedChunk {
                reason: format!("chunk claims {size} bytes, {moved} arrived"),
            }
            .into());
        }

        // Each chunk is followed by its own line terminator: CRLF, or a bare LF for the same reason
        // the head accepts one. Previously this read two bytes and checked neither, so a bare-LF origin
        // had the first digit of its next size line eaten and failed one chunk later with a message
        // about hex.
        let mut byte = [0u8; 1];
        src.read_exact(&mut byte).await?;
        if byte[0] == b'\r' {
            src.read_exact(&mut byte).await?;
        }
        if byte[0] != b'\n' {
            return Err(OriginError::MalformedChunk {
                reason: format!("chunk of {size} bytes is not followed by a line terminator"),
            }
            .into());
        }
    }
}

/// Reads one chunk-size line, refusing to buffer without bound.
///
/// **`read_until` has no ceiling**, which is the gap this closes: an origin that streams bytes and
/// never sends a newline grows `line` until the process runs out of memory. `MAX_RESPONSE_HEAD` exists
/// for precisely that reason one layer up — "a non-HTTP server listening on the port must not make the
/// connector buffer without bound" — and the same sentence is true of a size line, which is where the
/// reasoning had not been applied. A size line is at most sixteen hex digits plus extensions nobody
/// sends, so [`MAX_CHUNK_SIZE_LINE`] is generous; what matters is that it is finite.
///
/// Returns the number of bytes read, `0` at end of stream, mirroring `read_until`.
async fn read_size_line<R: AsyncBufRead + Unpin>(
    src: &mut R,
    line: &mut Vec<u8>,
) -> Result<usize, ExchangeError> {
    loop {
        let available = src.fill_buf().await?;
        if available.is_empty() {
            return Ok(line.len());
        }

        // How much of what is on offer belongs to this line: everything up to and including a newline,
        // or the whole buffer while still looking for one.
        let newline_at = available.iter().position(|byte| *byte == b'\n');
        let wanted = newline_at.map_or(available.len(), |at| at + 1);
        // Checked *before* copying, so the buffer never exceeds the bound by a whole read — otherwise
        // the ceiling would really be `MAX_CHUNK_SIZE_LINE` plus whatever the reader handed over.
        if line.len() + wanted > MAX_CHUNK_SIZE_LINE {
            return Err(OriginError::MalformedChunk {
                reason: format!("chunk-size line exceeded {MAX_CHUNK_SIZE_LINE} bytes"),
            }
            .into());
        }
        line.extend_from_slice(&available[..wanted]);
        src.consume(wanted);
        if newline_at.is_some() {
            return Ok(line.len());
        }
    }
}

/// Copies `src` into `dst`, recording what passed.
///
/// A hand-rolled loop rather than [`tokio::io::copy`] because the inspector needs the bytes, and
/// wrapping `dst` in a teeing `AsyncWrite` to get them would mean an `AsyncWrite` implementation
/// whose only job is to be handed to a function that already does this. With no inspector attached
/// `limit` is zero, so the recording is a counter.
async fn copy_recording<R, W>(
    src: &mut R,
    dst: &mut W,
    preview: &mut BodyPreview,
    limit: usize,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut scratch = vec![0u8; 16 * 1024];
    let mut moved = 0u64;

    loop {
        let read = src.read(&mut scratch).await?;
        if read == 0 {
            return Ok(moved);
        }
        // Written before it is recorded: the inspector must never be able to delay a byte.
        dst.write_all(&scratch[..read]).await?;
        preview.push(&scratch[..read], limit);
        moved += read as u64;
    }
}

/// Writes one chunk of a chunk-framed request body.
async fn write_chunked<W: AsyncWrite + Unpin>(bytes: &[u8], dst: &mut W) -> std::io::Result<()> {
    dst.write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
        .await?;
    dst.write_all(bytes).await?;
    dst.write_all(b"\r\n").await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use capnp::message;

    use crate::inspector::{Exchange, Inspector};
    use nport_protocol::connect::{DATA_PREAMBLE, HTTP_HEADER_PREFIX, HTTP_HOST, HTTP_METHOD};
    use nport_protocol::schema::quic_metadata_protocol_capnp::{
        ConnectionType as WireType, connect_request,
    };
    use tokio::io::{AsyncReadExt as _, DuplexStream, duplex};
    use tokio::net::TcpListener;

    use super::*;

    /// A chunk-size line that never ends must be refused rather than buffered.
    ///
    /// `read_until` has no ceiling, so an origin streaming bytes with no newline grew the line buffer
    /// until the process ran out of memory. `MAX_RESPONSE_HEAD` bounds the *head* for exactly that
    /// reason — "a non-HTTP server listening on the port must not make the connector buffer without
    /// bound" — and the same sentence is true of a size line, where the bound was missing.
    #[tokio::test]
    async fn a_runaway_chunk_size_line_is_refused() {
        let flood = b"a".repeat(MAX_CHUNK_SIZE_LINE * 4);
        let mut src = tokio::io::BufReader::new(&flood[..]);
        let mut line = Vec::new();

        let error = read_size_line(&mut src, &mut line)
            .await
            .expect_err("must refuse a size line with no newline");
        assert!(
            matches!(
                &error,
                ExchangeError::Origin(OriginError::MalformedChunk { reason })
                    if reason.contains("exceeded")
            ),
            "{error:?}"
        );
        // And it refused before copying, so the buffer never exceeded the bound.
        assert!(
            line.len() <= MAX_CHUNK_SIZE_LINE,
            "buffered {} bytes",
            line.len()
        );
    }

    /// The bound has to be reached through `dechunk`, not only through the helper.
    ///
    /// Asserting on `read_size_line` alone proves the helper is bounded, not that the production
    /// decoder calls it — a swap back to `read_until` at the one call site would leave that test
    /// green *if it only matched the variant*. This one goes through the function the connector runs
    /// and pins the reason.
    #[tokio::test]
    async fn dechunk_refuses_a_runaway_size_line() {
        let flood = b"a".repeat(MAX_CHUNK_SIZE_LINE * 4);
        let mut src = &flood[..];
        let mut dst = Vec::new();
        let mut preview = BodyPreview::default();

        let error = dechunk(&mut src, &mut dst, &mut preview, 0)
            .await
            .expect_err("must refuse");
        // The *reason*, not just the variant: with an unbounded read this still fails, but later and
        // for a different cause — `read_until` hits EOF and `chunk_size` then rejects the hex. Both are
        // `MalformedChunk`, so matching the variant alone would go green on the bug.
        assert!(
            matches!(
                &error,
                ExchangeError::Origin(OriginError::MalformedChunk { reason })
                    if reason.contains("exceeded")
            ),
            "{error:?}"
        );
        assert!(dst.is_empty(), "nothing should have reached the tunnel");
    }

    #[tokio::test]
    async fn a_size_line_split_across_reads_still_arrives_whole() {
        // The bounded reader replaced `read_until`, so the straddling case it handled for free has to
        // be asserted rather than assumed: `fill_buf` returns whatever happens to be available.
        let (mut client, mut server) = duplex(64);
        tokio::spawn(async move {
            server.write_all(b"1c").await.expect("write");
            tokio::time::sleep(Duration::from_millis(10)).await;
            server.write_all(b"8d\r\n").await.expect("write");
        });

        let mut src = tokio::io::BufReader::new(&mut client);
        let mut line = Vec::new();
        read_size_line(&mut src, &mut line)
            .await
            .expect("should read");
        assert_eq!(chunk_size(line.trim_ascii_end()).expect("hex"), 0x1c8d);
    }

    /// Fails a hung test in seconds rather than wedging the suite.
    async fn within<F: std::future::Future>(future: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("timed out — a stream half was probably left open")
    }

    /// Encodes what the edge would send on a data stream.
    ///
    /// Hand-built rather than fixture-driven so a test can vary one field. The fixture tests below
    /// are the ones that assert this encoder resembles reality.
    fn edge_request(dest: &str, kind: WireType, metadata: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut builder = message::Builder::new_default();
        {
            let mut request = builder.init_root::<connect_request::Builder<'_>>();
            request.set_dest(dest);
            request.set_type(kind);
            let mut entries = request.init_metadata(
                u32::try_from(metadata.len()).expect("a test never sends this many"),
            );
            for (index, (key, value)) in metadata.iter().enumerate() {
                let mut entry = entries.reborrow().get(u32::try_from(index).expect("small"));
                entry.set_key(key);
                entry.set_val(value);
            }
        }

        let mut stream = DATA_PREAMBLE.to_vec();
        capnp::serialize::write_message(&mut stream, &builder).expect("encode");
        stream.extend_from_slice(body);
        stream
    }

    /// The bytes the live edge actually sent, from `crates/protocol/tests/fixtures/`.
    ///
    /// Reaching into a sibling crate's test data is deliberate. These are the only request bytes in
    /// the repository that Cloudflare produced rather than we did, and replaying them through the
    /// real proxy is the closest thing to an end-to-end test that needs no network. Re-capturing
    /// them is `cargo xtask fixtures`, and a failure here is diagnosed by the rules in
    /// `crates/protocol/tests/golden_fixtures.rs`.
    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/tests/fixtures")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|error| panic!("reading {}: {error}", path.display()))
    }

    /// A one-shot origin that records the request it was given and answers with `response`.
    ///
    /// Returns the address to point an exchange at, and a handle yielding what the origin saw.
    async fn origin(response: &'static [u8]) -> (SocketAddr, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let seen = read_request(&mut socket).await;
            socket.write_all(response).await.expect("write");
            // End-of-socket delimits the response, which is what `connection: close` promised.
            socket.shutdown().await.expect("shutdown");
            seen
        });

        (addr, served)
    }

    /// Reads exactly one request: the head, plus a chunk-framed body if the head announced one.
    ///
    /// **Not `read_to_end`.** A real HTTP server answers a request while the connection is still
    /// open in both directions, and so must this one — the connector does not half-close toward the
    /// origin, because a server that treats a client FIN as an abort (Node's does) would drop the
    /// response. Reading to end here would deadlock against exactly the behaviour being tested.
    ///
    /// One byte at a time so nothing past the request is consumed: after a WebSocket upgrade the
    /// next bytes belong to the pipe, and an origin that swallowed them would fail the test for the
    /// wrong reason.
    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut seen = Vec::new();
        let mut byte = [0u8; 1];

        while !seen.ends_with(b"\r\n\r\n") {
            if socket.read(&mut byte).await.expect("read") == 0 {
                return String::from_utf8_lossy(&seen).into_owned();
            }
            seen.extend_from_slice(&byte);
        }

        let head = String::from_utf8_lossy(&seen).to_lowercase();
        if head.contains("transfer-encoding: chunked") {
            while !seen.ends_with(b"\r\n0\r\n\r\n") {
                if socket.read(&mut byte).await.expect("read") == 0 {
                    break;
                }
                seen.extend_from_slice(&byte);
            }
        } else if let Some(length) = head
            .split("content-length:")
            .nth(1)
            .and_then(|rest| rest.split("\r\n").next())
            .and_then(|value| value.trim().parse::<usize>().ok())
        {
            // A declared body has to be consumed here too. Answering before reading it would leave
            // the connector writing into a socket this task is about to drop, and the exchange would
            // fail with a connection reset that says nothing about what was being tested.
            let mut body = vec![0u8; length];
            socket.read_exact(&mut body).await.expect("read body");
            seen.extend_from_slice(&body);
        }

        String::from_utf8_lossy(&seen).into_owned()
    }

    /// Runs one exchange over an in-memory pipe and returns what went back to the edge.
    async fn exchange(request: Vec<u8>, origin: SocketAddr) -> Vec<u8> {
        watched(request, origin).await.0
    }

    /// The same, with an inspector attached — so a test can assert both what the edge saw and what
    /// was recorded about it.
    async fn watched(request: Vec<u8>, origin: SocketAddr) -> (Vec<u8>, Vec<Exchange>) {
        let inspector = Arc::new(Inspector::new(8));
        let (edge, connector) = duplex(64 * 1024);
        let (connector_recv, connector_send) = tokio::io::split(connector);

        let served = tokio::spawn(handle(
            connector_send,
            connector_recv,
            origin,
            Some(Arc::clone(&inspector) as Arc<dyn Observer>),
        ));
        let answered = tokio::spawn(feed(edge, request));

        within(served).await.expect("task").expect("exchange");
        (within(answered).await.expect("task"), inspector.recent())
    }

    /// Plays the edge's half: write the request, half-close, read the answer.
    async fn feed(edge: DuplexStream, request: Vec<u8>) -> Vec<u8> {
        let (mut read, mut write) = tokio::io::split(edge);
        write.write_all(&request).await.expect("write");
        // Half-close so the connector's body probe sees end-of-stream. `tokio::io::split` keeps the
        // stream alive until both halves drop, so shutting down the write half is the only way to
        // signal it without losing the read half.
        write.shutdown().await.expect("shutdown");

        let mut answer = Vec::new();
        read.read_to_end(&mut answer).await.expect("read");
        answer
    }

    /// Decodes the `ConnectResponse` the connector wrote, checking the preamble first.
    fn decode_response(bytes: &[u8]) -> (Vec<(String, String)>, Vec<u8>) {
        use nport_protocol::schema::quic_metadata_protocol_capnp::connect_response;

        assert_eq!(
            &bytes[..DATA_PREAMBLE.len()],
            &DATA_PREAMBLE,
            "the response must open with the signature and version (§6, trap 2)"
        );

        let mut rest = &bytes[DATA_PREAMBLE.len()..];
        let before = rest.len();
        let message = capnp::serialize::read_message(&mut rest, message::ReaderOptions::new())
            .expect("a ConnectResponse");
        let consumed = before - rest.len();

        let response: connect_response::Reader<'_> = message.get_root().expect("root");
        let metadata = response
            .get_metadata()
            .expect("metadata")
            .iter()
            .map(|entry| {
                (
                    entry.get_key().expect("key").to_string().expect("utf8"),
                    entry.get_val().expect("val").to_string().expect("utf8"),
                )
            })
            .collect();

        let body = bytes[DATA_PREAMBLE.len() + consumed..].to_vec();
        (metadata, body)
    }

    fn status(metadata: &[(String, String)]) -> &str {
        metadata
            .iter()
            .find(|(key, _)| key == "HttpStatus")
            .map(|(_, value)| value.as_str())
            .expect("every response carries a status")
    }

    fn header<'a>(metadata: &'a [(String, String)], name: &str) -> Option<&'a str> {
        metadata
            .iter()
            .find(|(key, _)| {
                key.strip_prefix(HTTP_HEADER_PREFIX)
                    .is_some_and(|header| header.eq_ignore_ascii_case(name))
            })
            .map(|(_, value)| value.as_str())
    }

    #[tokio::test]
    async fn serves_a_request_the_live_edge_actually_sent() {
        // The bytes in this fixture came off the wire from Cloudflare. Everything between them and
        // the origin's answer is the real path: signature, version, ConnectRequest, request head,
        // response framing.
        let (addr, served) = origin(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nhello",
        )
        .await;

        let answer = exchange(fixture("connect_request_http.bin"), addr).await;
        let seen = within(served).await.expect("origin task");

        // The origin-form target, query string intact — dropping it is invisible on a bare `/` and
        // breaks every real application.
        assert!(seen.starts_with("GET /fixture?q=1 HTTP/1.1\r\n"), "{seen}");
        // The Host comes from the HttpHost metadata key, never from a forwarded header (§7).
        assert!(seen.to_lowercase().contains("\r\nhost: "), "{seen}");

        let (metadata, body) = decode_response(&answer);
        assert_eq!(status(&metadata), "200");
        assert_eq!(header(&metadata, "content-type"), Some("text/plain"));
        assert_eq!(body, b"hello");
    }

    #[tokio::test]
    async fn a_bodyless_request_carries_no_framing_at_all() {
        // A `GET` announcing `transfer-encoding: chunked` confuses enough servers to be worth the
        // one-byte probe that avoids it — and a `content-length: 0` on a GET is just as wrong.
        let (addr, served) = origin(b"HTTP/1.1 204 No Content\r\n\r\n").await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let seen = within(served).await.expect("origin task");

        let lowered = seen.to_lowercase();
        assert!(!lowered.contains("transfer-encoding"), "{seen}");
        assert!(!lowered.contains("content-length"), "{seen}");
        assert_eq!(status(&decode_response(&answer).0), "204");
    }

    #[tokio::test]
    async fn a_request_body_streams_to_the_origin_chunk_framed() {
        // The length is unknown when the head has to be written — the body is delimited by
        // end-of-stream (§11). Buffering it to find out is what a large upload cannot afford.
        let (addr, served) = origin(b"HTTP/1.1 201 Created\r\ncontent-length: 0\r\n\r\n").await;

        let request = edge_request(
            "https://x.nport.link/upload",
            WireType::Http,
            &[
                (HTTP_METHOD, "POST"),
                (HTTP_HOST, "x.nport.link"),
                (&format!("{HTTP_HEADER_PREFIX}transfer-encoding"), "chunked"),
            ],
            b"payload",
        );
        let answer = exchange(request, addr).await;
        let seen = within(served).await.expect("origin task");

        assert!(
            seen.to_lowercase().contains("transfer-encoding: chunked"),
            "{seen}"
        );
        assert!(seen.ends_with("7\r\npayload\r\n0\r\n\r\n"), "{seen}");
        assert_eq!(status(&decode_response(&answer).0), "201");
    }

    #[tokio::test]
    async fn a_declared_length_is_relayed_rather_than_re_framed() {
        // An origin that rejects chunked requests — still common in PHP and older WSGI stacks —
        // must see the request the client actually sent. Re-framing every upload as chunked because
        // it was simpler here would break those for no gain.
        let (addr, served) = origin(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await;

        let request = edge_request(
            "https://x.nport.link/upload",
            WireType::Http,
            &[
                (HTTP_METHOD, "POST"),
                (HTTP_HOST, "x.nport.link"),
                (&format!("{HTTP_HEADER_PREFIX}content-length"), "7"),
            ],
            b"payload",
        );
        let _ = exchange(request, addr).await;
        let seen = within(served).await.expect("origin task");

        let lowered = seen.to_lowercase();
        assert!(lowered.contains("content-length: 7"), "{seen}");
        assert!(!lowered.contains("transfer-encoding"), "{seen}");
        assert!(seen.ends_with("\r\n\r\npayload"), "{seen}");
    }

    #[test]
    fn a_bodyless_request_is_recognised_from_metadata_alone() {
        // §11: upstream strips the body when the request is not a WebSocket, is not chunked, and has
        // a zero content length. Reading the stream to find out instead would mean waiting for the
        // edge's half-close on every `GET` — a round trip before the origin is even contacted, and a
        // hang outright if the edge ever holds the stream open for the response.
        let bare = ConnectRequest {
            dest: "https://x.nport.link/".to_owned(),
            kind: ConnectionType::Http,
            metadata: vec![(HTTP_METHOD.to_owned(), "GET".to_owned())],
        };
        assert_eq!(body_plan(&bare), Body::None);

        let zero = ConnectRequest {
            metadata: vec![(
                format!("{HTTP_HEADER_PREFIX}content-length"),
                "0".to_owned(),
            )],
            ..bare.clone()
        };
        assert_eq!(body_plan(&zero), Body::None);

        let sized = ConnectRequest {
            metadata: vec![(
                format!("{HTTP_HEADER_PREFIX}Content-Length"),
                "42".to_owned(),
            )],
            ..bare.clone()
        };
        assert_eq!(body_plan(&sized), Body::Length(42));

        let chunked = ConnectRequest {
            metadata: vec![(
                format!("{HTTP_HEADER_PREFIX}Transfer-Encoding"),
                "gzip, Chunked".to_owned(),
            )],
            ..bare.clone()
        };
        assert_eq!(body_plan(&chunked), Body::Chunked);

        // Both declared: the framing on the wire wins, or the body is read as the wrong number of
        // bytes and everything after it desynchronises.
        let both = ConnectRequest {
            metadata: vec![
                (
                    format!("{HTTP_HEADER_PREFIX}content-length"),
                    "42".to_owned(),
                ),
                (
                    format!("{HTTP_HEADER_PREFIX}transfer-encoding"),
                    "chunked".to_owned(),
                ),
            ],
            ..bare
        };
        assert_eq!(body_plan(&both), Body::Chunked);
    }

    #[tokio::test]
    async fn a_chunked_response_is_dechunked_and_loses_its_length() {
        // The bug this exists to prevent: a chunk-size line rendered as page content. And the half
        // that is easy to miss — a `content-length` copied from the origin no longer matches a
        // dechunked body, so it must not be sent at all. End-of-stream delimits it (§11).
        let (addr, served) = origin(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
        )
        .await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let _ = within(served).await.expect("origin task");

        let (metadata, body) = decode_response(&answer);
        assert_eq!(body, b"hello world");
        assert_eq!(header(&metadata, "content-length"), None);
        assert_eq!(header(&metadata, "transfer-encoding"), None);
    }

    #[tokio::test]
    async fn a_chunked_response_is_dechunked_when_the_origin_omits_the_space() {
        // The same response as above with the space after each colon removed — still valid HTTP, since
        // `OWS` may be empty. A `": "` split saw neither header, so the framing went to the browser as
        // content: `5`, `hello`, `6`, ` world`, `0`. This asserts through the whole exchange rather than
        // through the parser, because the parser is where it was wrong and the body is where it showed.
        let (addr, served) = origin(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding:chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
        )
        .await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let _ = within(served).await.expect("origin task");

        let (metadata, body) = decode_response(&answer);
        assert_eq!(body, b"hello world");
        assert_eq!(header(&metadata, "transfer-encoding"), None);
    }

    #[tokio::test]
    async fn a_bare_lf_origin_is_served_rather_than_failed() {
        // A server someone wrote this afternoon, terminating its lines with "\n". curl fetches it
        // happily; through the tunnel it used to produce no response at all, because the head's end was
        // never found. Asserted through the whole exchange because the parser is where it was wrong and
        // "my site returns nothing" is how the user meets it.
        let (addr, served) =
            origin(b"HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 5\n\nhello").await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let _ = within(served).await.expect("origin task");

        let (metadata, body) = decode_response(&answer);
        assert_eq!(status(&metadata), "200");
        assert_eq!(body, b"hello");
        assert_eq!(header(&metadata, "content-type"), Some("text/plain"));
    }

    /// The streaming decoder is the one production runs, so the leniency has to be proved there too.
    ///
    /// A whole bare-LF response: head, size lines and chunk terminators. The old `read_exact(2)` after
    /// each chunk ate the first digit of the next size line, so this failed one chunk in with a message
    /// about hexadecimal — pointing at the size line rather than at the terminator that misled it.
    #[tokio::test]
    async fn a_bare_lf_chunked_origin_is_dechunked_end_to_end() {
        let (addr, served) =
            origin(b"HTTP/1.1 200 OK\nTransfer-Encoding:chunked\n\n5\nhello\n6\n world\n0\n\n")
                .await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let _ = within(served).await.expect("origin task");

        let (_, body) = decode_response(&answer);
        assert_eq!(body, b"hello world");
    }

    #[tokio::test]
    async fn an_unchunked_length_is_relayed_as_the_origin_gave_it() {
        // The other side of the same rule: nothing was transformed, so the origin's own length is
        // still true and dropping it would leave the edge waiting on end-of-stream for no reason.
        let (addr, served) = origin(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello").await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let _ = within(served).await.expect("origin task");

        let (metadata, body) = decode_response(&answer);
        assert_eq!(header(&metadata, "content-length"), Some("5"));
        assert_eq!(body, b"hello");
    }

    #[tokio::test]
    async fn hop_by_hop_headers_do_not_survive_either_direction() {
        // They describe one connection. Relaying `keep-alive` toward a browser is meaningless at
        // best, and toward the origin it contradicts the `connection: close` this module sends.
        let (addr, served) = origin(
            b"HTTP/1.1 200 OK\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\nx-app: mine\r\ncontent-length: 0\r\n\r\n",
        )
        .await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[
                (HTTP_METHOD, "GET"),
                (HTTP_HOST, "x.nport.link"),
                (&format!("{HTTP_HEADER_PREFIX}connection"), "upgrade"),
            ],
            b"",
        );
        let answer = exchange(request, addr).await;
        let seen = within(served).await.expect("origin task");

        assert!(
            !seen.to_lowercase().contains("connection: upgrade"),
            "{seen}"
        );

        let (metadata, _) = decode_response(&answer);
        assert_eq!(header(&metadata, "keep-alive"), None);
        assert_eq!(header(&metadata, "x-app"), Some("mine"));
    }

    #[tokio::test]
    async fn a_websocket_upgrade_pipes_bytes_both_ways_untouched() {
        // Past the 101 the stream is opaque (§11) — no masking, no fragmentation handling. The
        // bytes below are not valid frames on purpose: if anything in this path tried to parse
        // them, it would have to fail.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let origin_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let head = read_request(&mut socket).await;
            // The response and the origin's first frame in one write, which is what makes the
            // `leftover` path matter: those bytes arrive attached to the head.
            socket
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\
                      sec-websocket-accept: x\r\n\r\n\x81\x04down",
                )
                .await
                .expect("write");

            let mut echoed = [0u8; 4];
            socket.read_exact(&mut echoed).await.expect("read up");
            socket.shutdown().await.expect("shutdown");
            (head, echoed)
        });

        let request = edge_request(
            "wss://x.nport.link/socket",
            WireType::Websocket,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"upup",
        );
        let answer = exchange(request, addr).await;
        let (head, up) = within(origin_task).await.expect("origin task");

        // The upgrade headers the edge stripped have to be put back, or the origin answers 200.
        let lowered = head.to_lowercase();
        assert!(lowered.contains("upgrade: websocket"), "{head}");
        assert!(lowered.contains("connection: upgrade"), "{head}");
        assert_eq!(
            &up, b"upup",
            "bytes toward the origin must arrive untouched"
        );

        let (metadata, body) = decode_response(&answer);
        assert_eq!(status(&metadata), "101");
        assert_eq!(
            body, b"\x81\x04down",
            "bytes toward the edge must arrive untouched"
        );
    }

    #[tokio::test]
    async fn a_websocket_the_origin_refuses_relays_its_answer_rather_than_a_502() {
        // The origin's own status is far more useful to whoever is debugging than a synthesised
        // gateway error that hides it.
        let (addr, served) = origin(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 2\r\n\r\nno").await;

        let request = edge_request(
            "wss://x.nport.link/socket",
            WireType::Websocket,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let answer = exchange(request, addr).await;
        let _ = within(served).await.expect("origin task");

        let (metadata, body) = decode_response(&answer);
        assert_eq!(status(&metadata), "403");
        assert_eq!(body, b"no");
    }

    #[tokio::test]
    async fn a_websocket_request_from_the_live_edge_reaches_the_origin() {
        // The second fixture Cloudflare produced. It asserts what the hand-built encoder above
        // cannot: that a real upgrade request is recognised as one.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let origin_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let head = read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 101 Switching Protocols\r\nsec-websocket-accept: x\r\n\r\n")
                .await
                .expect("write");
            socket.shutdown().await.expect("shutdown");
            head
        });

        let answer = exchange(fixture("connect_request_websocket.bin"), addr).await;
        let head = within(origin_task).await.expect("origin task");

        assert!(
            head.to_lowercase().contains("upgrade: websocket"),
            "the upgrade the edge stripped was not put back: {head}"
        );
        assert_eq!(status(&decode_response(&answer).0), "101");
    }

    #[tokio::test]
    async fn an_inspected_exchange_records_both_directions() {
        // The contract the desktop inspector's columns are built from. If a field the UI needs is
        // missing, it is added to `inspector::Exchange` first and captured here.
        let (addr, served) = origin(
            b"HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: 4\r\n\r\ndone",
        )
        .await;

        let request = edge_request(
            "https://x.nport.link/api/items?page=2",
            WireType::Http,
            &[
                (HTTP_METHOD, "POST"),
                (HTTP_HOST, "x.nport.link"),
                (&format!("{HTTP_HEADER_PREFIX}content-length"), "7"),
                (&format!("{HTTP_HEADER_PREFIX}x-trace"), "abc"),
            ],
            b"payload",
        );
        let (_, recorded) = watched(request, addr).await;
        let _ = within(served).await.expect("origin task");

        assert_eq!(recorded.len(), 1, "one stream is one exchange");
        let exchange = &recorded[0];
        assert_eq!(exchange.method, "POST");
        assert_eq!(exchange.url, "https://x.nport.link/api/items?page=2");
        assert_eq!(exchange.status, Some(201));
        assert_eq!(exchange.failure, None);
        assert_eq!(exchange.request_body.bytes, b"payload");
        assert_eq!(exchange.response_body.bytes, b"done");
        assert!(
            exchange
                .request_headers
                .iter()
                .any(|(name, value)| name == "x-trace" && value == "abc")
        );
        assert!(
            exchange
                .response_headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        );
    }

    #[tokio::test]
    async fn a_dechunked_body_is_recorded_as_the_client_will_see_it() {
        // Not as the origin framed it. Recording the chunk-size lines would show the inspector's
        // reader a body no browser ever receives.
        let (addr, served) = origin(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
        )
        .await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );
        let (_, recorded) = watched(request, addr).await;
        let _ = within(served).await.expect("origin task");

        assert_eq!(recorded[0].response_body.bytes, b"hello world");
        assert_eq!(recorded[0].response_body.total, 11);
    }

    /// A greeting frame attached to the handshake must reach the *record*, not only the edge.
    ///
    /// `a_websocket_upgrade_pipes_bytes_both_ways_untouched` already proves it reaches the edge, and it
    /// did — the wire was always right. The record was not: the frame was written straight to `send`,
    /// and the two copy tasks then assigned over `downward`, so the inspector's first downstream frame
    /// was missing and `total` was short while `truncated()` still said `false`. A server that pushes
    /// initial state sends its greeting in the same segment as the `101`, so this is the common case.
    #[tokio::test]
    async fn a_greeting_frame_attached_to_the_handshake_is_recorded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let origin_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let _ = read_request(&mut socket).await;
            // The handshake and the origin's greeting frame in one write, which is what a server that
            // pushes initial state actually does.
            socket
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\
                      sec-websocket-accept: x\r\n\r\n\x81\x04down",
                )
                .await
                .expect("write");
            let mut echoed = [0u8; 4];
            socket.read_exact(&mut echoed).await.expect("read up");
            socket.shutdown().await.expect("shutdown");
        });

        let request = edge_request(
            "wss://x.nport.link/socket",
            WireType::Websocket,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"upup",
        );
        let (_, recorded) = watched(request, addr).await;
        within(origin_task).await.expect("origin task");

        assert_eq!(
            recorded[0].response_body.bytes, b"\x81\x04down",
            "the greeting frame reached the edge but not the record"
        );
        assert_eq!(
            recorded[0].response_body.total, 6,
            "and `total` undercounted it"
        );
        assert!(
            !recorded[0].response_body.truncated(),
            "nothing was dropped, so the UI must not be told it was"
        );
    }

    #[tokio::test]
    async fn a_failed_exchange_is_still_recorded_with_its_reason() {
        // An exchange that fails is the one someone opens the inspector to look at. Recording only
        // successes would hide exactly the rows that matter.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);

        let inspector = Arc::new(Inspector::new(4));
        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );

        let (edge, connector) = duplex(64 * 1024);
        let (connector_recv, connector_send) = tokio::io::split(connector);
        let served = tokio::spawn(handle(
            connector_send,
            connector_recv,
            addr,
            Some(Arc::clone(&inspector) as Arc<dyn Observer>),
        ));
        drop(tokio::spawn(feed(edge, request)));

        within(served)
            .await
            .expect("task")
            .expect_err("nothing is listening");

        let recorded = inspector.recent();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].status, None);
        assert_eq!(
            recorded[0].failure,
            Some(Failure::Code(nport_contract::ErrorCode::LocalRequestFailed)),
            "an origin that is not listening is the user's own server, not the tunnel"
        );
    }

    #[tokio::test]
    async fn an_origin_that_is_not_listening_is_named_as_the_cause() {
        // `LOCAL_REQUEST_FAILED`, not a tunnel error: the user's next move is to look at their own
        // app, and an error that blamed the edge would send them the wrong way.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );

        let (edge, connector) = duplex(64 * 1024);
        let (connector_recv, connector_send) = tokio::io::split(connector);
        let served = tokio::spawn(handle(connector_send, connector_recv, addr, None));
        drop(tokio::spawn(feed(edge, request)));

        let error = within(served)
            .await
            .expect("task")
            .expect_err("nothing is listening");
        assert!(matches!(error, ExchangeError::OriginUnreachable { .. }));
    }

    #[tokio::test]
    async fn an_rpc_stream_is_left_alone() {
        // §9: NPort creates its tunnels with `config_src: "cloudflare"`, so there is no local
        // configuration to update. Treating this as a data stream would try to decode a management
        // message as a ConnectRequest and report a protocol change that has not happened.
        let mut stream = nport_protocol::connect::RPC_SIGNATURE.to_vec();
        stream.extend_from_slice(b"whatever the edge says next");

        let (edge, connector) = duplex(64 * 1024);
        let (connector_recv, connector_send) = tokio::io::split(connector);
        let served = tokio::spawn(handle(
            connector_send,
            connector_recv,
            "127.0.0.1:1".parse().expect("address"),
            None,
        ));
        drop(tokio::spawn(feed(edge, stream)));

        within(served).await.expect("task").expect("no error");
    }

    #[tokio::test]
    async fn a_truncated_chunked_body_is_refused_rather_than_relayed() {
        // Half a page is worse than an error: the browser renders it and nobody knows why it is
        // short. The connector's own stream is finished by the caller, so the edge sees a cut body.
        let (addr, served) =
            origin(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\nshort").await;

        let request = edge_request(
            "https://x.nport.link/",
            WireType::Http,
            &[(HTTP_METHOD, "GET"), (HTTP_HOST, "x.nport.link")],
            b"",
        );

        let (edge, connector) = duplex(64 * 1024);
        let (connector_recv, connector_send) = tokio::io::split(connector);
        let exchanged = tokio::spawn(handle(connector_send, connector_recv, addr, None));
        drop(tokio::spawn(feed(edge, request)));

        let error = within(exchanged)
            .await
            .expect("task")
            .expect_err("truncated");
        assert!(
            matches!(
                error,
                ExchangeError::Origin(OriginError::MalformedChunk { .. })
            ),
            "unexpected error: {error:?}"
        );
        let _ = within(served).await;
    }
}
