//! Origin-side proxying, shared by the `spike` and `pool` examples.
//!
//! Not a library: it lives under `examples/support/` precisely so it is not part of
//! `crates/protocol`'s public surface. `crates/core` will own the real proxy, streaming
//! rather than buffering and using `hyper` rather than this hand-rolled HTTP/1.1.
//!
//! Included with `#[path]` by both examples, so anything only one of them uses looks dead to
//! the other.
#![allow(dead_code)]

use std::time::Duration;

/// Ceiling on a buffered request body. Only exists because the spike buffers; `crates/core`
/// streams and needs no such limit.
pub const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;

/// Ceiling on an origin's response head, so a non-HTTP server on the port cannot make the
/// spike buffer forever.
pub const MAX_RESPONSE_HEAD: usize = 64 * 1024;

/// The body the origin serves. The spike asserts the tunnel delivers it byte-identically.
pub const ORIGIN_BODY: &str = "nport spike origin — byte-identity check\n";

/// A deliberately minimal origin: a fixed body over HTTP, and an echo over WebSocket.
///
/// Not a general server. The fixed body is what the byte-identity check wants, and the echo
/// is what G1 criterion 3 wants — run `--example ws_client` against the tunnel URL to drive
/// it.
pub async fn serve_origin(listener: tokio::net::TcpListener) {
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            return;
        };
        tokio::spawn(async move {
            if sniff_websocket_upgrade(&socket).await {
                serve_websocket_echo(socket).await;
            } else {
                serve_fixed_body(socket).await;
            }
        });
    }
}

/// Peeks at the request head to decide HTTP or WebSocket, without consuming it.
///
/// `peek` rather than `read` because `tokio_tungstenite::accept_async` does its own
/// handshake read and there is no way to hand it bytes we already took. Bounded polling
/// covers a head split across segments; in practice a proxied head arrives in one, since
/// both the spike and any real client write it with a single call.
pub async fn sniff_websocket_upgrade(socket: &tokio::net::TcpStream) -> bool {
    let mut probe = [0u8; 2048];
    for _ in 0..100 {
        let Ok(read) = socket.peek(&mut probe).await else {
            return false;
        };
        let head = String::from_utf8_lossy(&probe[..read]).to_ascii_lowercase();
        if head.contains("\r\n\r\n") || read == probe.len() {
            return head.contains("upgrade: websocket");
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    false
}

/// Answers anything with [`ORIGIN_BODY`].
pub async fn serve_fixed_body(mut socket: tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut scratch = [0u8; 8192];
    let _ = socket.read(&mut scratch).await;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\n\
         content-length: {}\r\nx-nport-spike: origin\r\nconnection: close\r\n\r\n{}",
        ORIGIN_BODY.len(),
        ORIGIN_BODY
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Echoes every text and binary message back unchanged.
///
/// `tokio-tungstenite` is a **dev-dependency**. The connector itself must never gain a
/// WebSocket library: past the 101 the tunnel stream is opaque bytes (§11), and parsing
/// frames there would mean masking bugs and fragmentation bugs in code that has no reason
/// to look inside a frame.
pub async fn serve_websocket_echo(socket: tokio::net::TcpStream) {
    use futures::{SinkExt as _, StreamExt as _};

    let mut socket = match tokio_tungstenite::accept_async(socket).await {
        Ok(socket) => socket,
        Err(error) => {
            println!("  ✗ websocket handshake with the origin failed: {error}");
            return;
        }
    };

    let mut echoed = 0usize;
    while let Some(message) = socket.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                println!("  ✗ websocket read failed after {echoed}: {error}");
                return;
            }
        };
        // Ping/pong and close are handled by tungstenite; echoing them would be wrong.
        if message.is_close() {
            break;
        }
        if !(message.is_text() || message.is_binary()) {
            continue;
        }
        if socket.send(message).await.is_err() {
            break;
        }
        echoed += 1;
    }
    let _ = socket.close(None).await;
    println!("  ⇄ websocket closed, {echoed} message(s) echoed");
}

pub type Fallible = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// One edge-initiated exchange: read the framed request, then dispatch on its type.
pub async fn handle_exchange(
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    origin: std::net::SocketAddr,
) -> Fallible {
    use nport_protocol::connect::{self, ConnectionType, StreamKind};

    // With `NPORT_FIXTURE_DIR` set, every read is teed so the frame's exact extent can be
    // recorded. The tee wraps `&mut recv`, so the body left on the stream afterwards is
    // untouched and the proxy paths below behave identically either way.
    let fixture_dir = std::env::var("NPORT_FIXTURE_DIR").ok();
    let mut tee = crate::capture::Tee::new(&mut recv);

    let kind = connect::read_stream_kind(&mut tee).await?;
    if kind != StreamKind::Data {
        println!("  ! {kind:?} stream — not implemented (ADR-0020)");
        return Ok(());
    }
    connect::read_version(&mut tee).await?;
    let request = connect::read_connect_request(&mut tee).await?;

    if let Some(dir) = &fixture_dir {
        let name = match request.kind {
            ConnectionType::Http => "connect_request_http.bin",
            ConnectionType::Websocket => "connect_request_websocket.bin",
            ConnectionType::Tcp => "connect_request_tcp.bin",
        };
        // The edge stamps the *capturing machine's* public IP into Cf-Connecting-Ip and
        // X-Forwarded-For. These files get committed to a public repository, so those bytes are
        // overwritten in place before anything is written to disk.
        let mut bytes = tee.seen.clone();
        let count = crate::capture::redact_client_ips(&mut bytes, &request.metadata);
        println!("  · redacted {count} client-IP occurrence(s) before writing the fixture");
        crate::capture::record(dir, name, &bytes);
    }

    println!(
        "  → {} {} (type {:?}, {} headers)",
        request.method().unwrap_or("?"),
        request.dest,
        request.kind,
        request.headers().count()
    );

    match request.kind {
        ConnectionType::Http => proxy_http(send, recv, origin, &request).await,
        ConnectionType::Websocket => proxy_websocket(send, recv, origin, &request).await,
        ConnectionType::Tcp => {
            // Trivial once the rest works, but NPort 3.0 exposes HTTP only (ADR-0020).
            connect::write_error_response(&mut send, "tcp is out of scope for nport 3.0").await?;
            send.finish()?;
            Ok(())
        }
    }
}

/// A parsed origin response head.
pub struct ResponseHead {
    pub status: u16,
    /// Hop-by-hop headers already removed.
    pub headers: Vec<(String, String)>,
    /// Bytes read past the `\r\n\r\n`. On a `101` these are already WebSocket frames.
    pub leftover: Vec<u8>,
    /// Whether the body arrives chunk-framed.
    ///
    /// Read from `Transfer-Encoding` **before** it is stripped, and it has to be surfaced rather
    /// than dropped with the header: the framing is still in the body, and forwarding it raw
    /// sends chunk-size lines to the browser as content.
    pub chunked: bool,
}

/// Reads one HTTP/1.1 response head.
///
/// Incremental rather than read-to-end, and it hands the leftover back rather than dropping it,
/// because on a `101` the very next bytes on the socket are already WebSocket frames. Reading
/// into a scratch buffer that goes out of scope would lose the origin's first frame with nothing
/// to show for it.
pub async fn read_response_head(
    socket: &mut tokio::net::TcpStream,
) -> Result<ResponseHead, Box<dyn std::error::Error + Send + Sync>> {
    use nport_protocol::connect::is_hop_by_hop;
    use tokio::io::AsyncReadExt as _;

    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let split = loop {
        if let Some(index) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        if raw.len() > MAX_RESPONSE_HEAD {
            return Err("origin response head exceeded the spike's limit".into());
        }
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Err("origin closed before finishing its response head".into());
        }
        raw.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let leftover = raw[split + 4..].to_vec();

    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or("origin response had no status code")?;

    let all: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();

    let chunked = all.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    });

    // Hop-by-hop headers must not be forwarded; everything else travels as metadata. On a 101
    // this strips `Connection` and `Upgrade`, which matches upstream: the edge is told about the
    // upgrade by the 101 itself plus Sec-Websocket-Accept, not by headers.
    //
    // `content-length` goes too, and is re-added from the body we actually assembled. A length
    // copied from the origin is wrong the moment the body is dechunked, and a wrong
    // content-length truncates the response in the browser.
    let headers = all
        .into_iter()
        .filter(|(name, _)| !is_hop_by_hop(name) && !name.eq_ignore_ascii_case("content-length"))
        .collect();

    Ok(ResponseHead {
        status,
        headers,
        leftover,
        chunked,
    })
}

/// Decodes HTTP/1.1 chunked transfer coding.
///
/// **This is why the browser saw binary garbage.** A Next.js dev server answers `Transfer-Encoding:
/// chunked`; the proxy correctly stripped the header, because it is hop-by-hop and cannot cross to
/// the edge's HTTP/2 hop — but the chunk framing is in the *body*, and forwarding it raw meant the
/// browser rendered hex chunk-size lines as page content.
///
/// cloudflared never hits this: Go's `http.Client` decodes chunked transparently. A hand-rolled
/// reader has to do it explicitly, which is the whole argument for `crates/core` using `hyper`
/// rather than growing this file.
///
/// Trailers after the terminating `0` chunk are discarded, matching what a proxy should do with
/// headers it is not forwarding.
pub fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut out = Vec::with_capacity(body.len());
    let mut rest = body;

    loop {
        let line_end = rest
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("chunked body ended mid-size-line")?;
        let line = &rest[..line_end];

        // A chunk-size line may carry `;ext=value` extensions. Ignore them, but do not let one
        // corrupt the size.
        let size_text = line.split(|byte| *byte == b';').next().unwrap_or(line);
        let size_text = std::str::from_utf8(size_text)?.trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| format!("chunk size {size_text:?} is not hexadecimal"))?;

        rest = &rest[line_end + 2..];
        if size == 0 {
            // Terminating chunk. Anything after it is trailers, which are dropped.
            break;
        }
        if rest.len() < size + 2 {
            return Err(format!("chunk claims {size} bytes but only {} remain", rest.len()).into());
        }
        out.extend_from_slice(&rest[..size]);
        // Each chunk is followed by its own CRLF.
        rest = &rest[size + 2..];
    }

    Ok(out)
}

/// An ordinary request/response exchange.
pub async fn proxy_http(
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    origin: std::net::SocketAddr,
    request: &nport_protocol::connect::ConnectRequest,
) -> Fallible {
    use nport_protocol::connect;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    // The request body is whatever follows the ConnectRequest on this stream, delimited by
    // FIN (§11). Reading it is safe here because capnp's framed reader consumes exactly the
    // message and never over-reads into the body.
    //
    // The spike buffers it. That is wrong for `crates/core` — a large upload must stream,
    // which means chunked encoding toward the origin since the length is not known upfront —
    // but it keeps the spike a single readable function.
    let body = recv.read_to_end(MAX_REQUEST_BODY).await.unwrap_or_default();

    let mut upstream = tokio::net::TcpStream::connect(origin).await?;
    // `connection: close` means read-to-end delimits the response, so the spike needs no
    // chunked decoder on the way back.
    let head = nport_protocol::connect::request_head(
        request,
        &[("connection", "close")],
        Some(body.len()),
    );

    upstream.write_all(head.as_bytes()).await?;
    if !body.is_empty() {
        upstream.write_all(&body).await?;
    }

    let head = read_response_head(&mut upstream).await?;
    // `connection: close` means read-to-end delimits the body, so no length header is needed to
    // know where it stops.
    let mut raw_body = head.leftover;
    upstream.read_to_end(&mut raw_body).await?;

    let response_body = if head.chunked {
        decode_chunked(&raw_body)?
    } else {
        raw_body
    };

    // content-length is re-derived, never copied: read_response_head dropped the origin's, and a
    // dechunked body has a different length than the framing announced.
    let mut headers = head.headers;
    headers.push(("content-length".to_owned(), response_body.len().to_string()));

    connect::write_connect_response(&mut send, head.status, &headers).await?;
    send.write_all(&response_body).await?;
    // End of body is stream FIN (§11).
    send.finish()?;

    println!(
        "  ← {}, {} bytes out{}, {} in, {} headers",
        head.status,
        response_body.len(),
        if head.chunked { " (dechunked)" } else { "" },
        body.len(),
        headers.len()
    );
    Ok(())
}

/// A WebSocket upgrade, then a bidirectional byte pipe (§11).
///
/// Two things make this different from the HTTP path and both are easy to get wrong:
///
/// * **The upgrade headers have to be re-added** toward the origin. The edge signals the
///   upgrade in `ConnectRequest.type` and sends no `Connection`/`Upgrade`, so an origin that
///   only sees the forwarded headers answers 200 and the client's handshake fails.
/// * **Nothing past the 101 is parsed.** The frames are copied through untouched — no
///   masking, no fragmentation handling, no length checks. That is the protocol's design and
///   it is also what keeps a WebSocket library out of the connector.
pub async fn proxy_websocket(
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    origin: std::net::SocketAddr,
    request: &nport_protocol::connect::ConnectRequest,
) -> Fallible {
    use nport_protocol::connect::{self, WEBSOCKET_ORIGIN_HEADERS};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let mut upstream = tokio::net::TcpStream::connect(origin).await?;
    // No content-length: upstream zeroes it for a WebSocket, and a handshake carries no body.
    let head = nport_protocol::connect::request_head(request, &WEBSOCKET_ORIGIN_HEADERS, None);
    upstream.write_all(head.as_bytes()).await?;

    let head = read_response_head(&mut upstream).await?;

    if head.status != 101 {
        // The origin declined the upgrade — a plain HTTP response, relayed as one. The client
        // sees its handshake fail with the origin's own status, which is far more useful than a
        // synthesised 502.
        let mut raw_body = head.leftover;
        upstream.read_to_end(&mut raw_body).await?;
        let body = if head.chunked {
            decode_chunked(&raw_body)?
        } else {
            raw_body
        };
        let mut headers = head.headers;
        headers.push(("content-length".to_owned(), body.len().to_string()));
        connect::write_connect_response(&mut send, head.status, &headers).await?;
        send.write_all(&body).await?;
        send.finish()?;
        println!("  ← {} — origin refused the upgrade", head.status);
        return Ok(());
    }

    let accept = head
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-accept"));
    // No content-length on a 101: there is no body, only a byte pipe.
    connect::write_connect_response(&mut send, 101, &head.headers).await?;
    println!("  ← 101 switching protocols (accept header {accept}), piping");

    // Anything the origin sent immediately after its head is already a frame.
    if !head.leftover.is_empty() {
        send.write_all(&head.leftover).await?;
    }

    let (mut origin_read, mut origin_write) = upstream.into_split();

    let to_origin = async {
        let moved = tokio::io::copy(&mut recv, &mut origin_write).await?;
        // Half-close so the origin sees EOF and closes its own side. Without this the
        // downstream copy never ends and the stream leaks until the process exits.
        origin_write.shutdown().await?;
        Ok::<u64, std::io::Error>(moved)
    };
    let to_edge = async {
        let moved = tokio::io::copy(&mut origin_read, &mut send).await?;
        Ok::<u64, std::io::Error>(moved)
    };

    // `join!`, not `try_join!`: a close frame arrives on one direction first, and cancelling
    // the other half would truncate the close handshake the peer is waiting to complete.
    let (up, down) = tokio::join!(to_origin, to_edge);
    send.finish()?;

    match (up, down) {
        (Ok(up), Ok(down)) => println!("  ⇄ pipe closed — {up} bytes up, {down} down"),
        (up, down) => println!("  ⇄ pipe ended with an error — up {up:?}, down {down:?}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run with `cargo test --examples` — a plain `cargo test` compiles examples but does not run
    /// tests inside them. Called out because a test nobody runs is worse than none.
    #[test]
    fn decodes_a_single_chunk() {
        assert_eq!(
            decode_chunked(b"5\r\nhello\r\n0\r\n\r\n").unwrap(),
            b"hello"
        );
    }

    #[test]
    fn joins_several_chunks_without_separators() {
        // The failure this guards: leaving the CRLF between chunks in the output, which shows up
        // as stray blank lines rather than as obvious garbage.
        assert_eq!(
            decode_chunked(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap(),
            b" world"
                .iter()
                .copied()
                .fold(b"hello".to_vec(), |mut acc, b| {
                    acc.push(b);
                    acc
                })
        );
    }

    #[test]
    fn reads_sizes_as_hexadecimal_not_decimal() {
        // `1c8d` was in the corrupted page the user saw. Parsed as decimal it is nonsense; the
        // whole bug class starts with getting this radix wrong.
        let payload = vec![b'x'; 0x1c8d];
        let mut body = format!("{:x}\r\n", payload.len()).into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(decode_chunked(&body).unwrap().len(), 0x1c8d);
    }

    #[test]
    fn ignores_chunk_extensions() {
        assert_eq!(
            decode_chunked(b"5;name=value\r\nhello\r\n0\r\n\r\n").unwrap(),
            b"hello"
        );
    }

    #[test]
    fn discards_trailers_after_the_final_chunk() {
        assert_eq!(
            decode_chunked(b"5\r\nhello\r\n0\r\nX-Trailer: v\r\n\r\n").unwrap(),
            b"hello"
        );
    }

    #[test]
    fn an_empty_body_decodes_to_nothing() {
        assert_eq!(decode_chunked(b"0\r\n\r\n").unwrap(), b"");
    }

    #[test]
    fn preserves_bytes_that_look_like_framing() {
        // A body containing "\r\n0\r\n\r\n" must not terminate early. Real HTML and gzip both
        // contain arbitrary bytes, so a decoder that scans for the terminator instead of
        // honouring sizes truncates pages at random.
        let payload = b"before\r\n0\r\n\r\nafter";
        let mut body = format!("{:x}\r\n", payload.len()).into_bytes();
        body.extend_from_slice(payload);
        body.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(decode_chunked(&body).unwrap(), payload);
    }

    #[test]
    fn handles_binary_payloads() {
        // gzip is what the origin actually sends, and it is full of bytes that are not UTF-8.
        let payload: Vec<u8> = (0..=255u8).collect();
        let mut body = format!("{:x}\r\n", payload.len()).into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(decode_chunked(&body).unwrap(), payload);
    }

    #[test]
    fn rejects_a_truncated_chunk_rather_than_returning_partial_data() {
        // Silently returning what arrived would serve a half page as if it were whole.
        assert!(decode_chunked(b"10\r\nshort\r\n").is_err());
    }

    #[test]
    fn rejects_a_non_hexadecimal_size() {
        assert!(decode_chunked(b"zz\r\nhello\r\n0\r\n\r\n").is_err());
    }

    #[test]
    fn rejects_a_body_that_ends_mid_size_line() {
        assert!(decode_chunked(b"5").is_err());
    }
}
