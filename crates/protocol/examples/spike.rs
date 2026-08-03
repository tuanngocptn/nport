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

    println!("\nsteps 1–3 exercised. Registration (step 4) needs a tunnel token.");
}
