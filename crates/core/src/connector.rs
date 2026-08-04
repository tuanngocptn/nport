//! The QUIC connector: discovery, dial, register, serve.
//!
//! This is the piece that turns [`crate::manager`]'s supervision loop into an actual tunnel. The
//! manager owns sockets and timers and no rules; the supervisor owns rules and no sockets; this
//! module owns **the sequence** — claim an address, dial it, hold a control stream open, register,
//! then serve streams until the connection ends or the tunnel stops.
//!
//! ## Where the `!Send` region is
//!
//! `capnp-rpc` holds `Rc`, so a registration session cannot live on a multi-threaded runtime at all
//! (ADR-0024). [`crate::local_runtime`] gives it a thread of its own, and the handle that comes back
//! is `Send` — so everything here, including the serve loop, is an ordinary `tokio::spawn`. The
//! session is created *and stays* on that thread for the connection's whole life, which is what §12's
//! graceful shutdown needs: `unregisterConnection` is an RPC, and an RPC needs the stream.
//!
//! ## One endpoint per connection index, held for its life
//!
//! Upstream binds a fixed local port per index (`connection/quic.go` → `portForConnIndex`) so a
//! reconnect leaves from the same source port — NAT and the edge's own state recognise the returning
//! connection, which matters a great deal behind carrier-grade NAT. `quinn` will not do that for you:
//! keeping the [`quinn::Endpoint`] alive across reconnects is the whole mechanism, so they live in a
//! map here rather than beside a connection that is about to be dropped.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use nport_protocol::edge::{self, AddressPool, EdgeError};
use nport_protocol::quic::{self, KeyExchange};
use nport_protocol::rpc::{ConnectionDetails, RpcError, Session};
use nport_protocol::token::{Endpoint as TokenEndpoint, TunnelToken};
use uuid::Uuid;

use crate::event::ConnectionIndex;
use crate::exchange;
use crate::local_runtime::{Gone, Hosted, LocalRuntime};
use crate::manager::{Connection, Connector, Shutdown};

/// The version string sent to the edge in `ClientInfo`.
const VERSION: &str = concat!("nport/", env!("CARGO_PKG_VERSION"));

/// Why a connector could not be built.
///
/// Only discovery can fail here; everything else fails per-attempt inside [`Connector::connect`],
/// where the supervisor can decide what to do about it.
#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    /// No usable edge addresses. Both SRV and the direct A/AAAA fallback failed.
    #[error("could not discover any Cloudflare edge addresses")]
    Discovery(#[source] EdgeError),
}

/// Dials, registers, and serves connections over QUIC.
pub struct QuicConnector {
    token: Arc<TunnelToken>,
    /// The user's own server. Every exchange opens a fresh TCP connection to it.
    origin: SocketAddr,
    /// Identifies the **connector**, not the connection: one per process, as upstream does.
    client_id: Uuid,
    pool: Arc<Mutex<AddressPool>>,
    /// Hosts the `!Send` capnp sessions. Cloned per connection, so the thread outlives them all.
    runtime: LocalRuntime,
    /// One socket per connection index, held for its life. See the module docs.
    endpoints: Mutex<HashMap<ConnectionIndex, quinn::Endpoint>>,
    key_exchange: KeyExchange,
}

impl QuicConnector {
    /// Discovers the edge and prepares to dial it.
    ///
    /// SRV first, falling back to the direct A/AAAA hostnames — the same order cloudflared uses, and
    /// the fallback matters on networks that filter SRV lookups.
    ///
    /// # Errors
    ///
    /// [`SetupError::Discovery`] if neither method yields the two regions the address pool requires.
    pub async fn new(
        token: TunnelToken,
        local_port: u16,
        endpoint: TokenEndpoint,
    ) -> Result<Self, SetupError> {
        let regions = match edge::discover_srv(endpoint).await {
            Ok(regions) => regions,
            // A failure here is not worth surfacing on its own: the fallback is expected to work,
            // and only its failure is a problem the user can act on.
            Err(_) => edge::discover_direct(endpoint)
                .await
                .map_err(SetupError::Discovery)?,
        };
        let pool = AddressPool::new(regions).map_err(SetupError::Discovery)?;

        Ok(Self {
            token: Arc::new(token),
            // Loopback, deliberately: the connector forwards to the user's own machine and must not
            // be pointable at someone else's. Tunnelling an address the user does not control is a
            // different product with a different threat model.
            origin: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), local_port),
            client_id: Uuid::new_v4(),
            pool: Arc::new(Mutex::new(pool)),
            runtime: LocalRuntime::start(),
            endpoints: Mutex::new(HashMap::new()),
            key_exchange: KeyExchange::PostQuantumPreferred,
        })
    }

    /// How many regions the pool is balancing across. For tests and diagnostics.
    #[must_use]
    pub fn regions(&self) -> usize {
        self.pool.lock().expect("pool lock poisoned").regions()
    }
}

impl Connector for QuicConnector {
    type Conn = EdgeConnection;

    async fn connect(&self, index: ConnectionIndex, rotate: bool) -> Result<Self::Conn, RpcError> {
        let peer = {
            // Taken, used, dropped. Never held across an await (`docs/conventions/rust.md`).
            let mut pool = self.pool.lock().expect("pool lock poisoned");
            if rotate {
                pool.rotate(index)
            } else {
                pool.claim(index)
            }
        }
        .map_err(dial_failure)?;

        let endpoint = self.endpoint_for(index, peer)?;
        let connection = quic::connect_on(&endpoint, peer, self.key_exchange)
            .await
            .map_err(dial_failure)?;

        // The session is built on the confined thread and never leaves it. `Session::open` panics
        // outside a `LocalSet`, which is exactly what `LocalRuntime::host` provides.
        let control = self
            .runtime
            .host({
                let connection = connection.clone();
                move || async move { Control::open(&connection).await }
            })
            .await
            .map_err(dial_failure)?;

        let details = register(&control, Arc::clone(&self.token), index, self.client_id).await?;

        Ok(EdgeConnection {
            connection,
            endpoint,
            control,
            colo: details.location_name,
            origin: self.origin,
            index,
            pool: Arc::clone(&self.pool),
        })
    }
}

impl QuicConnector {
    /// The socket for `index`, bound once and reused.
    ///
    /// Rebinds only when the address family changes: the family is fixed at bind time, and
    /// [`AddressPool`] hands out IPv4 first, so this is rare.
    fn endpoint_for(
        &self,
        index: ConnectionIndex,
        peer: SocketAddr,
    ) -> Result<quinn::Endpoint, RpcError> {
        let mut endpoints = self.endpoints.lock().expect("endpoint lock poisoned");

        let reusable = endpoints
            .get(&index)
            .and_then(|endpoint| endpoint.local_addr().ok())
            .is_some_and(|local| local.is_ipv4() == peer.is_ipv4());

        if !reusable {
            let bound = quic::bind_endpoint(peer, self.key_exchange).map_err(dial_failure)?;
            endpoints.insert(index, bound);
        }

        Ok(endpoints
            .get(&index)
            .expect("just inserted if it was missing")
            .clone())
    }
}

/// Maps a failure that happened *before* the RPC into the one error type the supervisor reads.
///
/// [`Connector::connect`] returns an [`RpcError`] because that is what [`crate::retry`] classifies,
/// and the mapping is not a fudge: `OpenStream`'s documented meaning is "the control stream could not
/// be opened", and a dial that never completed certainly did not open one. Both consequences are
/// what §12 asks for — [`crate::retry::classify`] rotates (a dial failure always rotates) and
/// [`crate::retry::code_for`] reports `EDGE_CONNECT_FAILED`, which is precisely what a user whose
/// network is refusing UDP/7844 should see.
fn dial_failure<E>(error: E) -> RpcError
where
    E: std::error::Error + Send + Sync + 'static,
{
    RpcError::OpenStream(Box::new(error))
}

/// The control stream for one connection, or the reason there is not one.
///
/// Lives on [`LocalRuntime`]'s thread — the [`Session`] inside it is `!Send` and cannot be moved. The
/// failure case is carried rather than returned from the constructor because [`LocalRuntime::host`]
/// hands back a handle, not a value: the reason has to travel out through the first call.
enum Control {
    Open(Session),
    /// Opening failed. Handed to the first caller and replaced with [`Control::Spent`].
    Failed(RpcError),
    /// The failure has been reported. There is never a second caller — `connect` returns the error
    /// and drops the handle — so this state exists only to make moving the error out safe.
    Spent,
}

impl Control {
    async fn open(connection: &quinn::Connection) -> Self {
        match Session::open(connection).await {
            Ok(session) => Self::Open(session),
            Err(error) => Self::Failed(error),
        }
    }

    /// Moves the failure out. Only reachable when the session is *not* open — see the caller.
    fn take_failure(&mut self) -> RpcError {
        match std::mem::replace(self, Self::Spent) {
            Self::Failed(error) => error,
            // `Open` is matched by every caller before this is reached, so replacing it here cannot
            // destroy a live session. `Spent` means a second caller, which does not happen.
            Self::Open(_) | Self::Spent => {
                dial_failure(std::io::Error::other("the control stream is gone"))
            }
        }
    }
}

/// Registers this connection, on the thread the session lives on.
async fn register(
    control: &Hosted<Control>,
    token: Arc<TunnelToken>,
    index: ConnectionIndex,
    client_id: Uuid,
) -> Result<ConnectionDetails, RpcError> {
    control
        .call(move |control| {
            Box::pin(async move {
                match control {
                    Control::Open(session) => {
                        session.register(&token, index, client_id, VERSION).await
                    }
                    other => Err(other.take_failure()),
                }
            })
        })
        .await
        .unwrap_or_else(|gone: Gone| Err(dial_failure(gone)))
}

/// A registered connection, serving until it dies or the tunnel stops.
pub struct EdgeConnection {
    connection: quinn::Connection,
    /// Held so the socket outlives the connection and the source port survives a reconnect. Cloning
    /// a [`quinn::Endpoint`] is cheap and does not change its lifetime.
    endpoint: quinn::Endpoint,
    control: Hosted<Control>,
    colo: String,
    origin: SocketAddr,
    index: ConnectionIndex,
    pool: Arc<Mutex<AddressPool>>,
}

impl Connection for EdgeConnection {
    fn colo(&self) -> String {
        self.colo.clone()
    }

    async fn serve(self, mut shutdown: Shutdown) {
        // Each exchange is independent and gets its own task. The set is what makes the drain below
        // possible: without it, "wait for in-flight requests" would have nothing to wait on.
        let mut in_flight = tokio::task::JoinSet::new();

        loop {
            tokio::select! {
                () = shutdown.requested() => break,
                accepted = self.connection.accept_bi() => match accepted {
                    Ok((send, recv)) => {
                        in_flight.spawn(exchange::handle(send, recv, self.origin));
                    }
                    // The connection is gone. Nothing to unregister and nothing to drain — the
                    // manager reconnects this index, keeping the address it already holds.
                    Err(_) => return,
                },
                // Reaping finished exchanges here rather than only at shutdown keeps the set from
                // growing for the connection's whole life. The guard matters: `join_next` on an
                // empty set returns immediately, which would spin this loop.
                Some(_) = in_flight.join_next(), if !in_flight.is_empty() => {}
            }
        }

        // §12's sequence, in order, and the order is the point. Unregister **first** so the edge
        // stops routing new requests here, then let what is already in flight finish, and only then
        // close. Closing first drops those requests on the floor.
        //
        // A failure to unregister is not worth reporting: the connection is about to close either
        // way, and the edge reaps unregistered connections on its own.
        let _ = self
            .control
            .call(|control| {
                Box::pin(async move {
                    match control {
                        Control::Open(session) => session.unregister().await,
                        other => Err(other.take_failure()),
                    }
                })
            })
            .await;

        while in_flight.join_next().await.is_some() {}

        // The manager's grace period bounds all of this — a connection that will not drain is cut
        // there, and reports `Stopped { drained: false }`.
        self.connection.close(0u32.into(), b"nport: shutting down");
        // Lets the close frame actually reach the edge before the socket goes away.
        self.endpoint.wait_idle().await;

        // A clean stop releases the address without demoting it: nothing was wrong with it.
        self.pool
            .lock()
            .expect("pool lock poisoned")
            .release(self.index);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nport_contract::ErrorCode;

    use super::*;
    use crate::retry::{Disposition, classify, code_for};

    fn endpoints() -> Mutex<HashMap<ConnectionIndex, quinn::Endpoint>> {
        Mutex::new(HashMap::new())
    }

    /// A connector with a pool, without touching the network.
    ///
    /// Discovery is the only part of `new` that needs DNS, so the tests below build the struct
    /// directly. `TunnelToken` has no test constructor by design — it is credential material — so
    /// the token is parsed from a synthetic one that is valid in shape and belongs to nothing.
    fn connector(regions: Vec<edge::Region>) -> QuicConnector {
        // base64 of {"a":"0"*32,"t":<uuid>,"s":base64(32 zero bytes)}. Not a credential: the tunnel
        // it names does not exist.
        const FAKE: &str = concat!(
            "eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiMDAwMDAwMDAtMDAw",
            "MC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwIiwicyI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB",
            "QUFBQUFBQUFBQUFBQUFBQUE9In0="
        );

        QuicConnector {
            token: Arc::new(TunnelToken::parse(FAKE).expect("a well-formed synthetic token")),
            origin: "127.0.0.1:3000".parse().expect("address"),
            client_id: Uuid::new_v4(),
            pool: Arc::new(Mutex::new(
                AddressPool::new(regions).expect("two regions is enough"),
            )),
            runtime: LocalRuntime::start(),
            endpoints: endpoints(),
            key_exchange: KeyExchange::PostQuantumPreferred,
        }
    }

    fn two_regions() -> Vec<edge::Region> {
        vec![
            edge::Region {
                name: "region1.v2.argotunnel.com".to_owned(),
                // TEST-NET-3 (RFC 5737). Documentation addresses, guaranteed not to be a real host.
                addresses: vec![
                    "203.0.113.1:7844".parse().expect("address"),
                    "203.0.113.2:7844".parse().expect("address"),
                ],
            },
            edge::Region {
                name: "region2.v2.argotunnel.com".to_owned(),
                addresses: vec![
                    "203.0.113.3:7844".parse().expect("address"),
                    "203.0.113.4:7844".parse().expect("address"),
                ],
            },
        ]
    }

    // `quinn::Endpoint::client` binds a socket through the reactor, so this needs a runtime.
    #[tokio::test]
    async fn one_index_keeps_one_socket_across_reconnects() {
        // `portForConnIndex`: reconnecting from the same source port lets NAT and the edge recognise
        // the returning connection. `quinn` will not do it for you — holding the endpoint is the
        // whole mechanism, so this asserts it is actually held.
        let connector = connector(two_regions());
        let peer: SocketAddr = "203.0.113.1:7844".parse().expect("address");

        let first = connector.endpoint_for(0, peer).expect("bind");
        let second = connector.endpoint_for(0, peer).expect("bind");

        assert_eq!(
            first.local_addr().expect("bound"),
            second.local_addr().expect("bound"),
            "a reconnect must leave from the same source port"
        );
    }

    // `quinn::Endpoint::client` binds a socket through the reactor, so this needs a runtime.
    #[tokio::test]
    async fn each_index_gets_its_own_socket() {
        // Two connections sharing a source port would be indistinguishable to the edge, which is
        // what the per-index port exists to prevent.
        let connector = connector(two_regions());
        let peer: SocketAddr = "203.0.113.1:7844".parse().expect("address");

        let zero = connector.endpoint_for(0, peer).expect("bind");
        let one = connector.endpoint_for(1, peer).expect("bind");

        assert_ne!(
            zero.local_addr().expect("bound"),
            one.local_addr().expect("bound")
        );
    }

    // `quinn::Endpoint::client` binds a socket through the reactor, so this needs a runtime.
    #[tokio::test]
    async fn a_family_change_rebinds_rather_than_reusing_the_wrong_socket() {
        // A socket's family is fixed at bind time, so an IPv4 endpoint cannot dial an IPv6 peer.
        // Reusing it would fail every attempt for as long as the pool kept handing out that address.
        let connector = connector(two_regions());

        let v4 = connector
            .endpoint_for(0, "203.0.113.1:7844".parse().expect("address"))
            .expect("bind");
        let v6 = connector
            .endpoint_for(0, "[2606:4700:a0::1]:7844".parse().expect("address"))
            .expect("bind");

        assert!(v4.local_addr().expect("bound").is_ipv4());
        assert!(v6.local_addr().expect("bound").is_ipv6());
    }

    #[test]
    fn a_dial_failure_rotates_and_reports_a_connect_error() {
        // The mapping that makes `Connector::connect`'s single error type honest. §12: a dial error
        // always rotates, and the user-facing code is EDGE_CONNECT_FAILED rather than anything
        // registration-shaped — nothing was registered.
        let error = dial_failure(quic::QuicError::HandshakeTimeout {
            addr: "203.0.113.1:7844".parse().expect("address"),
        });

        assert_eq!(classify(&error), Disposition::Rotate);
        assert_eq!(code_for(&error), ErrorCode::EdgeConnectFailed);
    }

    #[test]
    fn an_exhausted_pool_is_a_connect_failure_too() {
        // Not a protocol error, and it must not be: `EDGE_PROTOCOL_ERROR` is the code that means
        // "Cloudflare changed the protocol" and pages accordingly (`docs/OPERATIONS.md`). Having
        // nowhere left to dial is a network problem on this machine.
        let error = dial_failure(EdgeError::NoAddress);

        assert_eq!(code_for(&error), ErrorCode::EdgeConnectFailed);
        assert_ne!(code_for(&error), ErrorCode::EdgeProtocolError);
    }

    #[tokio::test]
    async fn a_connection_that_never_answers_fails_rather_than_hanging() {
        // TEST-NET-3 swallows packets, so this exercises the handshake deadline: a connector that
        // waited forever would leave the manager's retry budget with nothing to count.
        let connector = connector(two_regions());

        let attempt = tokio::time::timeout(
            quic::HANDSHAKE_TIMEOUT + Duration::from_secs(5),
            connector.connect(0, false),
        )
        .await
        .expect("the dial must give up on its own");

        let error = attempt
            .err()
            .expect("a documentation address cannot answer");
        assert_eq!(classify(&error), Disposition::Rotate);
    }
}
