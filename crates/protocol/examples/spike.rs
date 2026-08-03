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

#[path = "support/capture.rs"]
mod capture;
#[path = "support/proxy.rs"]
mod proxy;

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
            tokio::spawn(proxy::serve_origin(listener));
            println!(
                "\nbuilt-in origin on {address}, body {} bytes",
                proxy::ORIGIN_BODY.len()
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
                        if let Err(error) = proxy::handle_exchange(send, recv, origin).await {
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
