//! QUIC transport.
//!
//! `docs/PROTOCOL.md` §5. Dials an edge address with ALPN `argotunnel` and the transport
//! parameters cloudflared uses. Registration is a separate concern ([`crate::rpc`]); a
//! connection from here is established but anonymous.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ClientConfig, Endpoint, TransportConfig, VarInt};
use rustls::crypto::aws_lc_rs;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject as _;

/// Cloudflare's Origin CA roots, vendored from the pinned commit.
///
/// The edge's certificate chains to one of these rather than to a public root, so this
/// bundle is required for verification to succeed (`docs/PROTOCOL.md` §5).
const CLOUDFLARE_ROOT_CA: &str = include_str!("../certs/cloudflare-root-ca.pem");

/// ALPN protocol identifier — a single string.
///
/// cloudflared: `connection/protocol.go` → `quicProtos`.
pub const ALPN: &[u8] = b"argotunnel";

/// TLS SNI for the QUIC edge.
///
/// cloudflared: `connection/protocol.go` → `edgeQUICServerName`.
pub const SNI: &str = "quic.cftunnel.com";

/// Keep-alive ping period. **Mandatory** — the edge idles a connection out after
/// [`MAX_IDLE`], and quinn does not enable keep-alive by default.
///
/// cloudflared: `quic/constants.go` → `MaxIdlePingPeriod`.
pub const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(1);

/// Idle timeout, both directions.
///
/// cloudflared: `quic/constants.go` → `MaxIdleTimeout`.
pub const MAX_IDLE: Duration = Duration::from_secs(5);

/// Handshake idle timeout. quinn has no dedicated knob, so callers wrap the dial.
///
/// cloudflared: `quic/constants.go` → `HandshakeIdleTimeout`.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Connection-level flow control window, 30 MiB.
///
/// cloudflared: `quic/constants.go` → `QuicConnLevelFlowControlLimit`.
const CONN_RECEIVE_WINDOW: u32 = 30 * 1024 * 1024;

/// Stream-level flow control window, 6 MiB.
///
/// cloudflared: `quic/constants.go` → `QuicStreamLevelFlowControlLimit`.
const STREAM_RECEIVE_WINDOW: u32 = 6 * 1024 * 1024;

/// Max incoming streams the edge may open on one connection.
///
/// **This deliberately does not match upstream, and must not.** cloudflared advertises
/// `2^60` (`quic/constants.go` → `MaxIncomingStreams`), which is effectively unlimited
/// and costs quic-go nothing because it tracks stream permits lazily.
///
/// `quinn_proto::StreamsState::new` instead **pre-populates a map with one entry per
/// initially-permitted receive stream**. Passing `2^60` therefore does not fail — it
/// spins inside `Endpoint::connect` trying to insert 10^18 entries, synchronously, before
/// any future is returned. No timeout can interrupt it because the task never yields.
/// Diagnosed 2026-08-03 by sampling a wedged spike process; see `docs/PROTOCOL.md` §5.
///
/// 4096 concurrent in-flight requests per connection, across a default 4-connection pool,
/// is far beyond what a local development server can serve, and the limit is flow
/// control rather than an error — the edge waits rather than failing. Raise it if a real
/// workload is ever seen to queue behind it.
const MAX_INCOMING_STREAMS: u64 = 4096;

/// Compile-time guard for the wedge described above. If someone "restores fidelity" to
/// upstream's 2^60, the build fails instead of the dial hanging unkillably.
const _: () = assert!(MAX_INCOMING_STREAMS <= 1 << 20);

/// Initial packet size over IPv4.
///
/// **1232, not 1280.** quic-go 0.44 raised its default to 1280, which broke tunnelling
/// through WARP — whose MTU is exactly 1280. cloudflared: `supervisor/tunnel.go` →
/// `serveQUIC`.
const INITIAL_MTU_V4: u16 = 1232;

/// Initial packet size over IPv6.
const INITIAL_MTU_V6: u16 = 1252;

/// Upstream's whole reason for these values: stay under WARP's 1280-byte MTU.
const _: () = assert!(INITIAL_MTU_V4 < 1280 && INITIAL_MTU_V6 < 1280);

/// Which key-exchange groups to offer.
///
/// `docs/PROTOCOL.md` §5, risk P3. cloudflared offers `X25519MLKEM768`,
/// `P256Kyber768Draft00`, and `secp256r1` — notably **not** plain X25519.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyExchange {
    /// rustls' default order with `prefer-post-quantum`, so `X25519MLKEM768` first.
    /// This is the closest match to cloudflared's `PostQuantumPrefer`.
    #[default]
    PostQuantumPreferred,
    /// `secp256r1` alone. Exists to answer the empirical question of whether the edge
    /// accepts a classical-only client, and to be a fallback if a platform cannot do
    /// ML-KEM.
    ClassicalOnly,
}

/// Errors from establishing a QUIC connection.
#[derive(Debug, thiserror::Error)]
pub enum QuicError {
    /// The TLS or QUIC client configuration could not be built.
    #[error("could not build the QUIC client configuration")]
    Config(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The local UDP socket could not be bound.
    #[error("could not bind a local UDP socket")]
    Bind(#[source] std::io::Error),
    /// The dial itself failed.
    #[error("could not connect to the edge at {addr}")]
    Connect {
        /// The address dialled.
        addr: SocketAddr,
        /// quinn's error.
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    /// The handshake did not complete within [`HANDSHAKE_TIMEOUT`].
    #[error("handshake with {addr} did not complete within {}s", HANDSHAKE_TIMEOUT.as_secs())]
    HandshakeTimeout {
        /// The address dialled.
        addr: SocketAddr,
    },
    /// The edge did not agree to ALPN `argotunnel`.
    #[error("edge did not negotiate the `argotunnel` ALPN")]
    AlpnRejected,
    /// The vendored Cloudflare root bundle could not be parsed. A build problem, not a
    /// network one.
    #[error("the vendored Cloudflare Origin CA bundle is unusable")]
    RootBundle(#[source] Box<dyn std::error::Error + Send + Sync>),
}

/// Builds the trust anchors: the system roots plus Cloudflare's Origin CA roots.
///
/// Upstream does the same — `x509.SystemCertPool()` then `GetCloudflareRootCA()` — and
/// **the second half is load-bearing.** The QUIC edge presents an Origin CA certificate,
/// so a client trusting only public roots fails with a certificate error that looks like
/// a misconfiguration on our side. Verified empirically 2026-08-03: macOS's platform
/// verifier rejects the edge certificate outright.
///
/// A system root that fails to parse is skipped rather than fatal — platform stores
/// routinely contain oddities, and upstream tolerates them too. A failure in the vendored
/// bundle *is* fatal, because it means the build is broken.
fn root_store() -> Result<rustls::RootCertStore, QuicError> {
    let mut roots = rustls::RootCertStore::empty();

    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        // Ignoring individual failures on purpose; see above.
        let _ = roots.add(cert);
    }

    // `CertificateDer::pem_slice_iter` rather than `rustls-pemfile`, which is unmaintained —
    // RUSTSEC-2025-0134. Its functionality moved into `rustls-pki-types`, which `rustls` already
    // re-exports, so dropping it removes a dependency rather than swapping one for another.
    let mut added = 0usize;
    for cert in CertificateDer::pem_slice_iter(CLOUDFLARE_ROOT_CA.as_bytes()) {
        let cert = cert.map_err(|e| QuicError::RootBundle(Box::new(e)))?;
        roots
            .add(cert)
            .map_err(|e| QuicError::RootBundle(Box::new(e)))?;
        added += 1;
    }
    if added == 0 {
        return Err(QuicError::RootBundle(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no certificates in the vendored bundle",
        ))));
    }

    Ok(roots)
}

/// Builds the rustls configuration for a dial.
///
/// Public so a caller can inspect what will be offered — and so the Phase 1 spike can
/// bisect the dial, since a synchronous stall inside a future's first poll cannot be
/// caught by a timeout.
pub fn tls_config(key_exchange: KeyExchange) -> Result<rustls::ClientConfig, QuicError> {
    let mut provider = aws_lc_rs::default_provider();
    if key_exchange == KeyExchange::ClassicalOnly {
        provider.kx_groups = vec![aws_lc_rs::kx_group::SECP256R1];
    }

    // Normal hostname and chain verification, no pinning, no client certificate — but
    // against a root set that includes Cloudflare's Origin CA (see `root_store`).
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| QuicError::Config(Box::new(e)))?
        .with_root_certificates(root_store()?)
        .with_no_client_auth();

    config.alpn_protocols = vec![ALPN.to_vec()];
    Ok(config)
}

/// Builds the quinn client configuration: TLS, ALPN, and the §5 transport parameters.
pub fn client_config(
    peer: SocketAddr,
    key_exchange: KeyExchange,
) -> Result<ClientConfig, QuicError> {
    let tls = tls_config(key_exchange)?;
    let quic_tls = QuicClientConfig::try_from(tls).map_err(|e| QuicError::Config(Box::new(e)))?;

    let mut config = ClientConfig::new(Arc::new(quic_tls));
    config.transport_config(Arc::new(transport_config(peer)));
    Ok(config)
}

/// Binds a local UDP socket in the peer's address family and attaches [`client_config`].
pub fn bind_endpoint(peer: SocketAddr, key_exchange: KeyExchange) -> Result<Endpoint, QuicError> {
    let bind: SocketAddr = if peer.is_ipv4() {
        (Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let mut endpoint = Endpoint::client(bind).map_err(QuicError::Bind)?;
    endpoint.set_default_client_config(client_config(peer, key_exchange)?);
    Ok(endpoint)
}

/// Builds the transport parameters from §5.
fn transport_config(peer: SocketAddr) -> TransportConfig {
    let mut transport = TransportConfig::default();

    transport.keep_alive_interval(Some(KEEP_ALIVE_INTERVAL));
    transport.max_idle_timeout(Some(MAX_IDLE.try_into().expect("5s fits in a VarInt")));
    transport.receive_window(VarInt::from_u32(CONN_RECEIVE_WINDOW));
    transport.stream_receive_window(VarInt::from_u32(STREAM_RECEIVE_WINDOW));
    transport.max_concurrent_bidi_streams(
        VarInt::from_u64(MAX_INCOMING_STREAMS).expect("2^60 fits in a VarInt"),
    );
    transport.max_concurrent_uni_streams(
        VarInt::from_u64(MAX_INCOMING_STREAMS).expect("2^60 fits in a VarInt"),
    );

    transport.initial_mtu(if peer.is_ipv4() {
        INITIAL_MTU_V4
    } else {
        INITIAL_MTU_V6
    });
    // Upstream picked its initial size to survive WARP's 1280 MTU. Probing upward would
    // undo that, so discovery stays off until there is a reason to turn it on.
    transport.mtu_discovery_config(None);

    transport
}

/// A dialled, established QUIC connection to an edge address.
///
/// Anonymous until `registerConnection` succeeds on the control stream.
#[derive(Debug)]
pub struct EdgeConnection {
    /// The live connection.
    pub connection: quinn::Connection,
    /// The endpoint owning the socket. Dropping it closes the connection, so it is kept
    /// alongside rather than discarded.
    pub endpoint: Endpoint,
    /// The address that answered.
    pub peer: SocketAddr,
}

/// Dials one edge address on a fresh socket.
///
/// The local socket family matches the peer's, and the source port is ephemeral. For a pool,
/// use [`connect_on`] with one long-lived [`Endpoint`] per connection index instead — see its
/// documentation for why the source port matters.
pub async fn connect(
    peer: SocketAddr,
    key_exchange: KeyExchange,
) -> Result<EdgeConnection, QuicError> {
    let endpoint = bind_endpoint(peer, key_exchange)?;
    let connection = connect_on(&endpoint, peer, key_exchange).await?;
    Ok(EdgeConnection {
        connection,
        endpoint,
        peer,
    })
}

/// Dials one edge address on a socket the caller owns.
///
/// **This is how the source port gets reused across reconnects.** Upstream binds a fixed
/// local port per connection index (`connection/quic.go` → `portForConnIndex`) because
/// reconnecting from the same source port lets NAT and the edge's own state recognise the
/// returning connection; a fresh ephemeral port on every retry is materially worse behind
/// carrier-grade NAT. `quinn` will not do this for you — holding the [`Endpoint`] for the
/// index's whole life is what achieves it.
///
/// The endpoint's socket family is fixed at bind time, so a rotation that crosses address
/// families needs a rebind. Callers that prefer IPv4 (as [`crate::edge::AddressPool`] does)
/// will rarely hit that.
pub async fn connect_on(
    endpoint: &Endpoint,
    peer: SocketAddr,
    key_exchange: KeyExchange,
) -> Result<quinn::Connection, QuicError> {
    // A per-dial config, not the endpoint default: the initial MTU depends on the peer's
    // address family (§5), so reusing one config across a family change would send packets
    // sized for the wrong path.
    let connecting = endpoint
        .connect_with(client_config(peer, key_exchange)?, peer, SNI)
        .map_err(|e| QuicError::Connect {
            addr: peer,
            source: Box::new(e),
        })?;

    let connection = tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting)
        .await
        .map_err(|_| QuicError::HandshakeTimeout { addr: peer })?
        .map_err(|e| QuicError::Connect {
            addr: peer,
            source: Box::new(e),
        })?;

    // The edge must agree to `argotunnel`. A connection without it is not one we can use,
    // and failing here beats a confusing hang on the control stream.
    let negotiated = connection
        .handshake_data()
        .and_then(|d| d.downcast::<quinn::crypto::rustls::HandshakeData>().ok())
        .and_then(|d| d.protocol.clone());
    if negotiated.as_deref() != Some(ALPN) {
        return Err(QuicError::AlpnRejected);
    }

    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge;
    use crate::token::Endpoint as TokenEndpoint;

    #[test]
    fn alpn_and_sni_match_the_pinned_source() {
        assert_eq!(ALPN, b"argotunnel");
        assert_eq!(SNI, "quic.cftunnel.com");
    }

    #[test]
    fn keep_alive_is_well_below_the_idle_timeout() {
        // The whole point: 1s pings against a 5s idle timeout.
        assert!(KEEP_ALIVE_INTERVAL * 2 < MAX_IDLE);
    }

    #[test]
    fn the_vendored_bundle_holds_the_three_origin_ca_roots() {
        let roots = root_store().expect("bundle should parse");
        // System roots are also present, so assert the floor rather than an exact count.
        assert!(roots.len() >= 3, "only {} roots", roots.len());
    }

    #[test]
    fn building_a_client_config_is_fast() {
        // The 2^60 wedge showed up here first: config construction must not be doing
        // work proportional to the stream limit.
        let peer = SocketAddr::from(([198, 51, 100, 1], EDGE_PORT_FOR_TEST));
        let started = std::time::Instant::now();
        client_config(peer, KeyExchange::PostQuantumPreferred).expect("should build");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "took {:?}",
            started.elapsed()
        );
    }

    const EDGE_PORT_FOR_TEST: u16 = 7844;

    #[test]
    fn initial_mtu_matches_the_pinned_source() {
        // The < 1280 relationship is a compile-time assertion; these pin the values.
        assert_eq!(INITIAL_MTU_V4, 1232);
        assert_eq!(INITIAL_MTU_V6, 1252);
    }

    #[test]
    fn both_key_exchange_configurations_build() {
        tls_config(KeyExchange::PostQuantumPreferred).expect("PQ config should build");
        tls_config(KeyExchange::ClassicalOnly).expect("classical config should build");
    }

    #[test]
    fn classical_only_offers_exactly_one_group() {
        let config = tls_config(KeyExchange::ClassicalOnly).expect("should build");
        assert_eq!(config.crypto_provider().kx_groups.len(), 1);
    }

    #[test]
    fn post_quantum_is_preferred_first() {
        // rustls' `prefer-post-quantum` default feature puts X25519MLKEM768 first, which
        // is what makes this configuration match cloudflared's PostQuantumPrefer.
        let config = tls_config(KeyExchange::PostQuantumPreferred).expect("should build");
        let first = config.crypto_provider().kx_groups[0].name();
        assert_eq!(first, rustls::NamedGroup::X25519MLKEM768, "got {first:?}");
    }

    /// Live edge. Answers `docs/PROTOCOL.md` §17 question 3.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn handshakes_with_post_quantum_key_exchange() {
        let regions = edge::discover_direct(TokenEndpoint::Global)
            .await
            .expect("discovery should succeed");
        // Deterministically IPv4: discovery returns AAAA first, and the IPv6 path is not
        // yet exercised (docs/PROTOCOL.md §5).
        let peer = regions
            .iter()
            .flat_map(|r| r.addresses.iter())
            .find(|a| a.is_ipv4())
            .copied()
            .expect("the edge should publish at least one A record");

        let established = connect(peer, KeyExchange::PostQuantumPreferred)
            .await
            .expect("PQ handshake should succeed");
        assert_eq!(established.peer, peer);
        established.connection.close(0u32.into(), b"");
    }

    /// Live edge. This is the actual answer to question 3: does the edge accept a client
    /// that offers no post-quantum group at all?
    #[tokio::test]
    #[ignore = "requires network"]
    async fn handshakes_with_classical_key_exchange_only() {
        let regions = edge::discover_direct(TokenEndpoint::Global)
            .await
            .expect("discovery should succeed");
        // Deterministically IPv4: discovery returns AAAA first, and the IPv6 path is not
        // yet exercised (docs/PROTOCOL.md §5).
        let peer = regions
            .iter()
            .flat_map(|r| r.addresses.iter())
            .find(|a| a.is_ipv4())
            .copied()
            .expect("the edge should publish at least one A record");

        let established = connect(peer, KeyExchange::ClassicalOnly)
            .await
            .expect("secp256r1-only handshake should succeed");
        established.connection.close(0u32.into(), b"");
    }
}
