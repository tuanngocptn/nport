//! Drives **G1 criterion 3**: a WebSocket echo surviving 100 messages in both directions,
//! through the real Cloudflare edge and back out of the spike's origin.
//!
//! ```text
//! # terminal 1 — publish the built-in echo origin
//! ./crates/protocol/tests/live/tunnel.sh builtin ws-spike 180
//!
//! # terminal 2
//! cargo run -p nport-protocol --example ws_client -- wss://ws-spike.nport.link/
//! ```
//!
//! Deliberately not part of `cargo test`: it needs the network, a live tunnel, and a
//! subdomain that exists. `docs/TESTING.md` covers where the line sits.
//!
//! `tokio-tungstenite` and `tokio-rustls` are **dev-dependencies**. This file is a test
//! client, not connector code — `crates/protocol` itself never interprets a WebSocket frame.

use std::sync::Arc;
use std::time::{Duration, Instant};

/// Each round-trip is bounded so a stalled pipe fails loudly rather than hanging the run.
const ECHO_TIMEOUT: Duration = Duration::from_secs(10);

/// A payload large enough to be split across frames by nothing in particular, but big enough
/// that a truncating pipe shows up. 64 KiB crosses tungstenite's default read-buffer size.
const LARGE_PAYLOAD: usize = 64 * 1024;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> std::process::ExitCode {
    let url = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("NPORT_WS_URL").ok())
        .unwrap_or_else(|| "wss://spike.nport.link/".to_owned());
    let messages: usize = std::env::args()
        .nth(2)
        .or_else(|| std::env::var("NPORT_WS_MESSAGES").ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(100);

    println!("nport websocket echo check — {messages} round-trips against {url}\n");

    match run(&url, messages).await {
        Ok(report) => {
            println!("\n✓ {report}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            println!("\n✗ {error}");
            let mut source = error.source();
            while let Some(inner) = source {
                println!("  caused by: {inner}");
                source = inner.source();
            }
            std::process::ExitCode::FAILURE
        }
    }
}

type Failure = Box<dyn std::error::Error + Send + Sync>;

async fn run(url: &str, messages: usize) -> Result<String, Failure> {
    use futures::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::Message;

    let host = host_of(url)?;
    // Mirrors `curl --resolve`. macOS negative-caches the NXDOMAIN from before a freshly
    // created record existed, so the system resolver can keep failing long after the record
    // is live — that cost real debugging time on step 5.
    let address = match std::env::var("NPORT_WS_RESOLVE") {
        Ok(ip) => format!("{ip}:443"),
        Err(_) => format!("{host}:443"),
    };

    let started = Instant::now();
    let stream = tokio::net::TcpStream::connect(&address).await?;
    let stream = tls_connect(stream, &host).await?;
    let (mut socket, response) = tokio_tungstenite::client_async(url, stream).await?;
    println!(
        "handshake ok in {:.2?} — status {}",
        started.elapsed(),
        response.status()
    );

    let mut round_trips = 0usize;
    for index in 0..messages {
        // Alternate text and binary: they take different paths through tungstenite on both
        // ends, and only the raw bytes are guaranteed to survive the tunnel.
        let sent = if index % 2 == 0 {
            Message::text(format!("nport-ws-{index}"))
        } else {
            Message::binary(vec![u8::try_from(index % 256).unwrap_or(0); 1 + index])
        };

        socket.send(sent.clone()).await?;
        let received = tokio::time::timeout(ECHO_TIMEOUT, socket.next())
            .await
            .map_err(|_| format!("message {index} was not echoed within {ECHO_TIMEOUT:?}"))?
            .ok_or_else(|| format!("the pipe closed at message {index}"))??;

        if received.into_data() != sent.into_data() {
            return Err(format!("message {index} came back altered").into());
        }
        round_trips += 1;
        if round_trips % 25 == 0 {
            println!("  {round_trips}/{messages} echoed");
        }
    }

    // One oversized frame, after the count is satisfied: a pipe that works for small frames
    // can still truncate when the payload crosses a read-buffer boundary.
    let large = Message::binary(
        (0..LARGE_PAYLOAD)
            .map(|index| u8::try_from(index % 256).unwrap_or(0))
            .collect::<Vec<u8>>(),
    );
    socket.send(large.clone()).await?;
    let echoed = tokio::time::timeout(ECHO_TIMEOUT, socket.next())
        .await
        .map_err(|_| format!("the {LARGE_PAYLOAD}-byte frame was not echoed"))?
        .ok_or("the pipe closed during the large frame")??;
    if echoed.into_data() != large.into_data() {
        return Err(format!("the {LARGE_PAYLOAD}-byte frame came back altered").into());
    }

    socket.close(None).await?;
    Ok(format!(
        "{round_trips} round-trips byte-identical, plus one {LARGE_PAYLOAD}-byte frame, in {:.2?}",
        started.elapsed()
    ))
}

/// The host portion of a `ws://`/`wss://` URL.
///
/// Not a URL parser: enough to get an SNI name and a TCP target, which is all this driver
/// needs and it keeps `url` out of the dependency list.
fn host_of(url: &str) -> Result<String, Failure> {
    let after_scheme = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or("the URL needs a wss:// or ws:// scheme")?;
    let authority = after_scheme
        .split_once('/')
        .map_or(after_scheme, |(authority, _)| authority);
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host);
    if host.is_empty() {
        return Err("the URL has no host".into());
    }
    Ok(host.to_owned())
}

/// A plain TLS client for the public edge — system roots, no customisation.
///
/// Unrelated to the connector's own TLS: that one needs Cloudflare's Origin CA roots because
/// the tunnel edge presents an Origin CA certificate (`docs/PROTOCOL.md` §5). This is just a
/// browser-equivalent client talking to `*.nport.link`.
async fn tls_connect(
    stream: tokio::net::TcpStream,
    host: &str,
) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>, Failure> {
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        roots.add(certificate)?;
    }

    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();

    let name = rustls::pki_types::ServerName::try_from(host.to_owned())?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await?;
    Ok(stream)
}
