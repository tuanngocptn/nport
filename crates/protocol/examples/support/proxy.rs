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

    let kind = connect::read_stream_kind(&mut recv).await?;
    if kind != StreamKind::Data {
        println!("  ! {kind:?} stream — not implemented (ADR-0020)");
        return Ok(());
    }
    connect::read_version(&mut recv).await?;
    let request = connect::read_connect_request(&mut recv).await?;

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

/// Builds the origin-form HTTP/1.1 request head from a `ConnectRequest`.
///
/// `extra` is the caller's own hop-by-hop set — `connection: close` for a plain request, the
/// upgrade trio for a WebSocket. Anything named there wins over the client's version, and
/// `connection` reaches the origin **only** through it, since the forwarded headers are
/// hop-by-hop filtered first.
pub fn origin_request_head(
    request: &nport_protocol::connect::ConnectRequest,
    extra: &[(&str, &str)],
    content_length: Option<usize>,
) -> String {
    use nport_protocol::connect::is_hop_by_hop;

    let mut head = format!(
        "{} {} HTTP/1.1\r\n",
        request.method().unwrap_or("GET"),
        request.path_and_query()
    );
    // Host comes from the HttpHost metadata key, not from the header list.
    head.push_str(&format!(
        "host: {}\r\n",
        request.host().unwrap_or("localhost")
    ));

    for (name, value) in request.headers() {
        // Hop-by-hop headers describe one connection and must not be relayed. content-length
        // is recomputed from what actually arrived, so the origin never sees a stale one.
        if name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("content-length")
            || is_hop_by_hop(name)
            || extra
                .iter()
                .any(|(override_name, _)| name.eq_ignore_ascii_case(override_name))
        {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }

    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(length) = content_length.filter(|length| *length > 0) {
        head.push_str(&format!("content-length: {length}\r\n"));
    }
    head.push_str("\r\n");
    head
}

/// Reads one HTTP/1.1 response head, returning the status, the headers, and **any bytes read
/// past the terminator**.
///
/// Incremental rather than read-to-end, and it hands the leftover back rather than dropping
/// it, because on a `101` the very next bytes on the socket are already WebSocket frames.
/// Reading into a scratch buffer that goes out of scope would lose the origin's first frame
/// with nothing to show for it.
pub async fn read_response_head(
    socket: &mut tokio::net::TcpStream,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), Box<dyn std::error::Error + Send + Sync>> {
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

    // Hop-by-hop headers must not be forwarded; everything else travels as metadata. On a
    // 101 this strips `Connection` and `Upgrade`, which matches upstream: the edge is told
    // about the upgrade by the 101 itself plus Sec-Websocket-Accept, not by headers.
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .filter(|(name, _)| !is_hop_by_hop(name))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();

    Ok((status, headers, leftover))
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
    let head = origin_request_head(request, &[("connection", "close")], Some(body.len()));

    upstream.write_all(head.as_bytes()).await?;
    if !body.is_empty() {
        upstream.write_all(&body).await?;
    }

    let (status, headers, mut response_body) = read_response_head(&mut upstream).await?;
    upstream.read_to_end(&mut response_body).await?;

    connect::write_connect_response(&mut send, status, &headers).await?;
    send.write_all(&response_body).await?;
    // End of body is stream FIN (§11).
    send.finish()?;

    println!(
        "  ← {status}, {} bytes out, {} in, {} headers",
        response_body.len(),
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
    let head = origin_request_head(request, &WEBSOCKET_ORIGIN_HEADERS, None);
    upstream.write_all(head.as_bytes()).await?;

    let (status, headers, leftover) = read_response_head(&mut upstream).await?;

    if status != 101 {
        // The origin declined the upgrade — a plain HTTP response, relayed as one. The
        // client sees its handshake fail with the origin's own status, which is far more
        // useful than a synthesised 502.
        let mut body = leftover;
        upstream.read_to_end(&mut body).await?;
        connect::write_connect_response(&mut send, status, &headers).await?;
        send.write_all(&body).await?;
        send.finish()?;
        println!("  ← {status} — origin refused the upgrade");
        return Ok(());
    }

    let accept = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-accept"));
    connect::write_connect_response(&mut send, 101, &headers).await?;
    println!("  ← 101 switching protocols (accept header {accept}), piping");

    // Anything the origin sent immediately after its head is already a frame.
    if !leftover.is_empty() {
        send.write_all(&leftover).await?;
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
