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
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(error) => {
            println!("✗ could not bind a local origin: {error}");
            return;
        }
    };
    let origin = listener
        .local_addr()
        .expect("bound listener has an address");
    tokio::spawn(serve_origin(listener));
    println!(
        "\nlocal origin on {origin}, body {} bytes",
        ORIGIN_BODY.len()
    );

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

/// The body the origin serves. The spike asserts the tunnel delivers it byte-identically.
const ORIGIN_BODY: &str = "nport spike origin — byte-identity check\n";

/// A deliberately minimal HTTP/1.1 origin. Not a general server: it answers anything with
/// a fixed body, which is exactly what a byte-identity check needs.
async fn serve_origin(listener: tokio::net::TcpListener) {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        tokio::spawn(async move {
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
        });
    }
}

/// One edge-initiated exchange: read the framed request, proxy it to the origin, write the
/// framed response.
async fn handle_exchange(
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    origin: std::net::SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use nport_protocol::connect::{self, ConnectionType, StreamKind};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

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

    if request.kind != ConnectionType::Http {
        connect::write_error_response(&mut send, "only http is implemented in the spike").await?;
        send.finish()?;
        return Ok(());
    }

    // Minimal origin-form HTTP/1.1 request. `connection: close` means read-to-end delimits
    // the response, so the spike needs no chunked decoder.
    let mut upstream = tokio::net::TcpStream::connect(origin).await?;
    let origin_request = format!(
        "{} {} HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n\r\n",
        request.method().unwrap_or("GET"),
        request.path_and_query(),
        request.host().unwrap_or("localhost")
    );
    upstream.write_all(origin_request.as_bytes()).await?;
    let mut raw = Vec::new();
    upstream.read_to_end(&mut raw).await?;

    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("origin response had no header terminator")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = &raw[split + 4..];

    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or("origin response had no status code")?;

    // Hop-by-hop headers must not be forwarded; everything else travels as metadata.
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(": "))
        .filter(|(name, _)| {
            !matches!(
                name.to_ascii_lowercase().as_str(),
                "connection" | "transfer-encoding" | "keep-alive"
            )
        })
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();

    connect::write_connect_response(&mut send, status, &headers).await?;
    send.write_all(body).await?;
    // End of body is stream FIN (§11).
    send.finish()?;

    println!(
        "  ← {status}, {} bytes, {} headers",
        body.len(),
        headers.len()
    );
    Ok(())
}
