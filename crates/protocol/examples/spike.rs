//! Phase 1 protocol spike (`docs/ROADMAP.md`).
//!
//! Throwaway by design: it prints what happened at each step so the sub-steps can be
//! verified against the live edge one at a time. Nothing here is a public API, and none
//! of it survives into `crates/core`.
//!
//! ```text
//! cargo run -p nport-protocol --example spike
//! ```

use std::time::{Duration, Instant};

use nport_protocol::edge;
use nport_protocol::quic::{self, KeyExchange};
use nport_protocol::rpc;
use nport_protocol::token::Endpoint;

/// Every step is bounded, so a hang shows up as a labelled timeout rather than a wedged
/// process.
const STEP_TIMEOUT: Duration = Duration::from_secs(15);

macro_rules! step {
    ($label:expr, $body:expr) => {{
        let started = Instant::now();
        print!("… {}", $label);
        use std::io::Write as _;
        std::io::stdout().flush().ok();
        let outcome = tokio::time::timeout(STEP_TIMEOUT, $body).await;
        let elapsed = started.elapsed();
        match outcome {
            Ok(Ok(value)) => {
                println!("\r✓ {} ({:.2?})", $label, elapsed);
                Some(value)
            }
            Ok(Err(error)) => {
                println!("\r✗ {} ({:.2?})\n    {error}", $label, elapsed);
                let mut source = std::error::Error::source(&error);
                while let Some(inner) = source {
                    println!("    caused by: {inner}");
                    source = inner.source();
                }
                None
            }
            Err(_) => {
                println!("\r⏱ {} — timed out after {:?}", $label, STEP_TIMEOUT);
                None
            }
        }
    }};
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    println!("nport protocol spike — docs/PROTOCOL.md\n");

    // ── Step 2: edge discovery ────────────────────────────────────────────────────
    let Some(regions) = step!(
        "discover edges (A/AAAA shortcut)",
        edge::discover_direct(Endpoint::Global)
    ) else {
        return;
    };
    for region in &regions {
        println!(
            "    {} → {} address(es)",
            region.name,
            region.addresses.len()
        );
        for address in region.addresses.iter().take(2) {
            println!("      {address}");
        }
    }

    if let Some(srv) = step!("discover edges (SRV)", edge::discover_srv(Endpoint::Global)) {
        for region in &srv {
            let ports: Vec<u16> = region.addresses.iter().map(|a| a.port()).collect();
            println!(
                "    {} → ports {:?}",
                region.name,
                &ports[..ports.len().min(2)]
            );
        }
    }

    // Prefer IPv4: `lookup_ip` returns AAAA first, and an IPv4 dial is the configuration
    // the initial-MTU constant was chosen for.
    let peer = regions
        .iter()
        .flat_map(|r| r.addresses.iter())
        .find(|a| a.is_ipv4())
        .copied()
        .unwrap_or(regions[0].addresses[0]);
    println!("\ndialling {peer}\n");

    // Stage-by-stage, because a synchronous stall inside a future's first poll cannot be
    // interrupted by a timeout — it has to be located by bisection instead.
    {
        use std::io::Write as _;
        let stage = |label: &str, f: &mut dyn FnMut()| {
            print!("    [{label}] ");
            std::io::stdout().flush().ok();
            let started = Instant::now();
            f();
            println!("ok ({:.2?})", started.elapsed());
        };
        stage("tls config", &mut || {
            quic::tls_config(KeyExchange::PostQuantumPreferred).expect("tls config");
        });
        stage("quinn client config", &mut || {
            quic::client_config(peer, KeyExchange::PostQuantumPreferred).expect("client config");
        });
        stage("bind udp socket", &mut || {
            quic::bind_endpoint(peer, KeyExchange::PostQuantumPreferred).expect("bind");
        });
    }

    // ── Step 3: QUIC handshake ────────────────────────────────────────────────────
    // Both key-exchange configurations, because whether the edge accepts a
    // classical-only client is docs/PROTOCOL.md §17 question 3.
    for key_exchange in [
        KeyExchange::PostQuantumPreferred,
        KeyExchange::ClassicalOnly,
    ] {
        let label = format!("QUIC handshake, {key_exchange:?}");
        if let Some(established) = step!(label, quic::connect(peer, key_exchange)) {
            println!(
                "    ALPN negotiated, rtt {:?}, colo unknown until registration",
                established.connection.rtt()
            );
            established.connection.close(0u32.into(), b"spike");
        }
    }

    // ── Step 4: registration RPC over the control stream ─────────────────────────
    // Needs a real token. Read from the environment, never from a file and never from
    // argv — `ps` exposes argv to every local user, which is exactly what v2 got wrong.
    let Ok(raw_token) = std::env::var("NPORT_TUNNEL_TOKEN") else {
        println!("\nsteps 1–3 exercised. Set NPORT_TUNNEL_TOKEN to run step 4.");
        return;
    };

    let token = match nport_protocol::token::TunnelToken::parse(&raw_token) {
        Ok(token) => token,
        Err(error) => {
            println!("\n✗ token did not parse: {error}");
            return;
        }
    };
    println!(
        "\ntoken parsed — tunnel {}, secret redacted",
        token.tunnel_id()
    );

    let Some(established) = step!(
        "QUIC handshake for registration",
        quic::connect(peer, KeyExchange::PostQuantumPreferred)
    ) else {
        return;
    };

    // The connector ID: a per-process random v4 UUID, distinct from the tunnel ID.
    let client_id = uuid::Uuid::new_v4();
    let version = concat!("nport/", env!("CARGO_PKG_VERSION"));

    let Some(details) = step!(
        "registerConnection (control stream, no preamble)",
        rpc::register_connection(&established.connection, &token, 0, client_id, version)
    ) else {
        return;
    };
    println!("    colo:                     {}", details.location_name);
    println!("    connection uuid:          {} bytes", details.uuid.len());
    println!(
        "    remotely managed:         {} (expected true — config_src cloudflare)",
        details.tunnel_is_remotely_managed
    );

    // ── Step 5: ConnectRequest framing, one HTTP GET end-to-end ──────────────────
    // NPORT_SPIKE_ORIGIN points at a real local server ("3008" or "127.0.0.1:3008").
    // Without it the spike serves its own fixed-body origin, which is what the
    // byte-identity check wants.
    let origin = match std::env::var("NPORT_SPIKE_ORIGIN") {
        Ok(value) => {
            let target = if value.contains(':') {
                value
            } else {
                format!("127.0.0.1:{value}")
            };
            let Ok(address) = target.parse::<std::net::SocketAddr>() else {
                println!("✗ NPORT_SPIKE_ORIGIN is not an address: {target}");
                return;
            };
            // Probe before serving. Failing fast beats publishing a URL that 502s — the
            // R18 requirement in docs/ARCHITECTURE.md §8.
            if let Err(error) = tokio::net::TcpStream::connect(address).await {
                println!("\n✗ nothing is listening on {address}: {error}");
                println!("  start your server first, then re-run.");
                return;
            }
            println!("\nforwarding to {address} (pre-flight probe ok)");
            address
        }
        Err(_) => {
            let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                Ok(listener) => listener,
                Err(error) => {
                    println!("✗ could not bind a local origin: {error}");
                    return;
                }
            };
            let address = listener
                .local_addr()
                .expect("bound listener has an address");
            tokio::spawn(serve_origin(listener));
            println!(
                "\nbuilt-in origin on {address}, body {} bytes",
                ORIGIN_BODY.len()
            );
            address
        }
    };

    let serve_secs: u64 = std::env::var("NPORT_SPIKE_SERVE_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(25);
    println!("serving exchanges for {serve_secs}s — curl the tunnel now\n");

    let deadline = tokio::time::sleep(Duration::from_secs(serve_secs));
    tokio::pin!(deadline);
    let mut exchanges = 0usize;
    loop {
        tokio::select! {
            () = &mut deadline => break,
            accepted = established.connection.accept_bi() => match accepted {
                Ok((send, recv)) => {
                    exchanges += 1;
                    tokio::spawn(async move {
                        if let Err(error) = handle_exchange(send, recv, origin).await {
                            println!("  ✗ exchange failed: {error}");
                        }
                    });
                }
                Err(error) => {
                    println!("edge closed the connection: {error}");
                    break;
                }
            },
        }
    }

    println!("\n{exchanges} exchange(s) handled.");
    established.connection.close(0u32.into(), b"spike");
    // Let the CONNECTION_CLOSE frame actually leave before the process exits.
    established.endpoint.wait_idle().await;
}

/// Ceiling on a buffered request body. Only exists because the spike buffers; `crates/core`
/// streams and needs no such limit.
const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;

/// Ceiling on an origin's response head, so a non-HTTP server on the port cannot make the
/// spike buffer forever.
const MAX_RESPONSE_HEAD: usize = 64 * 1024;

/// The body the origin serves. The spike asserts the tunnel delivers it byte-identically.
const ORIGIN_BODY: &str = "nport spike origin — byte-identity check\n";

/// A deliberately minimal origin: a fixed body over HTTP, and an echo over WebSocket.
///
/// Not a general server. The fixed body is what the byte-identity check wants, and the echo
/// is what G1 criterion 3 wants — run `--example ws_client` against the tunnel URL to drive
/// it.
async fn serve_origin(listener: tokio::net::TcpListener) {
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
async fn sniff_websocket_upgrade(socket: &tokio::net::TcpStream) -> bool {
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
async fn serve_fixed_body(mut socket: tokio::net::TcpStream) {
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
async fn serve_websocket_echo(socket: tokio::net::TcpStream) {
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

type Fallible = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// One edge-initiated exchange: read the framed request, then dispatch on its type.
async fn handle_exchange(
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
fn origin_request_head(
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
async fn read_response_head(
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
async fn proxy_http(
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
async fn proxy_websocket(
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
