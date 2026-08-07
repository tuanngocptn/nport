//! The whole lifecycle: provision → connect → proxy → teardown.
//!
//! `docs/ARCHITECTURE.md` §3. [`crate::manager`] keeps four connections registered and
//! [`crate::connector`] makes them real; this module is what turns those into *a tunnel* — a lease
//! claimed from the control plane, kept alive by heartbeats, and released when it ends.
//!
//! It is the layer `crates/cli` and `apps/desktop` actually use. Both get the same three things: a
//! URL, an event stream, and a way to stop.
//!
//! ## Provisioning is not an event
//!
//! [`Tunnel::start`] returns a `Result`, and only then does anything asynchronous begin. A caller
//! that cannot claim a subdomain has nothing to render and should say so and exit — turning that
//! into an event would make every consumer implement "wait for either the URL or the failure",
//! which is a state machine nobody needs. Once there *is* a tunnel, everything else is an event,
//! because from then on the caller cannot do anything but display what happens.
//!
//! ## The server owns the clock
//!
//! Invariant 3. `expiresAt` is displayed and never enforced here: no timer ends the tunnel locally,
//! and the heartbeat corrects the displayed expiry from each response rather than counting down. v2
//! enforced its four-hour limit with a client-side `setTimeout`, which made the limit advisory
//! (defect R6) — and made a clock skew look like an outage.

use std::sync::Arc;
use std::time::Duration;

use nport_contract::{ClientKind, CreateTunnelResponse, ErrorCode};
use nport_protocol::token::TunnelToken;
use tokio::sync::{broadcast, oneshot};

use crate::api::{Api, ApiError};
use crate::connector::QuicConnector;
use crate::discovery;
use crate::event::{ShutdownReason, TunnelEvent};
use crate::inspector::Observer;
use crate::manager::{Connector, TunnelConfig, TunnelHandle, TunnelManager};

/// The fallback beat rate, used only when the server does not say.
///
/// `docs/ARCHITECTURE.md` §3c. Distinct from the QUIC keep-alive in `docs/PROTOCOL.md` §12: that one
/// keeps the *edge connection* up, this one keeps the *lease* alive, and either can fail while the
/// other is healthy.
///
/// **The rate normally comes from `GET /v1/meta`**, which publishes `heartbeatIntervalMs` as a
/// quarter of the grace period for exactly this purpose — `apps/api/CLAUDE.md` says a limit is
/// surfaced there "so clients discover rather than hardcode it". This value was hardcoded and the
/// published one was read by nobody, which meant the server could not shorten its own grace period:
/// drop it to 60 s and a client still beating every 30 s has one miss of headroom instead of four;
/// drop it to 30 s and every tunnel dies on schedule, with nothing anywhere saying why. Invariant 3
/// makes the server authoritative for time limits, and a client picking its own beat rate is the
/// client enforcing one.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Bounds on what the server may talk us into.
///
/// Trusting `heartbeatIntervalMs` is right — it already carries the server's own headroom — but not
/// unboundedly: a zero would spin, and an hour would silently disable renewal. The floor is also
/// what makes this testable, since `pnpm smoke` shortens the grace period to watch a real beat.
const MIN_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
const MAX_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(300);

/// The beat rate the server asks for, clamped, or [`HEARTBEAT_INTERVAL`] if it did not say.
///
/// A failure to read `/v1/meta` must never stop a tunnel that has already been provisioned, so this
/// takes an `Option` and falls back rather than propagating.
#[must_use]
fn heartbeat_interval(published_ms: Option<u64>) -> Duration {
    match published_ms {
        Some(ms) if ms > 0 => {
            Duration::from_millis(ms).clamp(MIN_HEARTBEAT_INTERVAL, MAX_HEARTBEAT_INTERVAL)
        }
        _ => HEARTBEAT_INTERVAL,
    }
}

/// How many events a slow consumer may fall behind before the oldest are dropped.
const EVENT_BUFFER: usize = 256;

/// Why a tunnel could not be started.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// The control plane refused, or could not be reached.
    #[error("the tunnel could not be provisioned")]
    Provision(#[from] ApiError),
    /// The control plane answered with a token this client cannot use.
    ///
    /// Its own error type is deliberately not carried: [`nport_protocol::token::TokenError`] is
    /// written so no variant can quote any part of the input, and wrapping it here would be the
    /// obvious place to undo that.
    #[error("the control plane returned a tunnel token that could not be parsed")]
    Token,
    /// The Cloudflare edge could not be discovered.
    #[error("the Cloudflare edge could not be found")]
    Edge(#[from] crate::connector::SetupError),
    /// No node could be found to provision against (ADR-0031).
    #[error("no NPort node could be found")]
    Discovery(#[from] crate::discovery::DiscoveryError),
}

/// Discovers a node and claims a lease on it, trying the next one only when it is safe to.
///
/// **The failover rule lives here, and it is the one thing in this file that can lose a user's
/// tunnel.** `POST /v1/tunnels` is not idempotent, so this moves on to the next candidate *only* when
/// [`may_try_another_node`] says the node answered and its answer proves nothing was created. A
/// network failure mid-request is indistinguishable from one before it, so it ends the attempt rather
/// than risking a second tunnel nobody holds the tokens for.
///
/// The loop is over *candidates*, not attempts: each node is tried once, in the order discovery
/// ranked them, and a fresh challenge is taken per node because that is what `create_tunnel` does.
async fn provision_via_registry(
    config: &TunnelConfig,
    client: ClientKind,
    registry: &str,
) -> Result<(Api, CreateTunnelResponse), StartError> {
    let directory = Api::new(registry).map_err(StartError::Provision)?;
    let candidates = discovery::select(
        &directory,
        config.nodes_cache.as_deref(),
        config.node.as_deref(),
    )
    .await?;

    // Carried so the *last* refusal is what the user sees. Reporting the first would name a node that
    // may have been full while a later one was genuinely broken, and reporting a generic failure would
    // throw away the only actionable thing in the sequence.
    let mut last: Option<StartError> = None;

    for candidate in candidates {
        let api = match Api::new(&candidate.node.url) {
            Ok(api) => api,
            // A directory entry with an unusable URL. Nothing was sent, so moving on is safe.
            Err(error) => {
                last = Some(StartError::Provision(error));
                continue;
            }
        };

        match api.create_tunnel(config.subdomain.clone(), client).await {
            Ok(lease) => return Ok((api, lease)),
            Err(error) => {
                let may_continue = discovery::may_try_another_node(&error);
                last = Some(StartError::Provision(error));
                if !may_continue {
                    break;
                }
            }
        }
    }

    Err(last.unwrap_or(StartError::Discovery(
        discovery::DiscoveryError::NoNodeAvailable,
    )))
}

impl StartError {
    /// The code a user should see. Codes, never prose.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Provision(error) => error.code(),
            // Not `PROVISION_FAILED`: provisioning worked, and the thing that came back was wrong.
            // A user seeing this is looking at a client/server version mismatch.
            Self::Token => ErrorCode::EdgeProtocolError,
            Self::Edge(_) => ErrorCode::EdgeDiscoveryFailed,
            Self::Discovery(error) => error.code(),
        }
    }
}

/// A running tunnel.
///
/// Dropping this does **not** stop it — call [`Tunnel::shutdown`], which consumes the value so a
/// second stop cannot compile. v2's signal handler called an async cleanup it never awaited, with no
/// guard, so a second Ctrl+C fired a second delete (defect R19).
#[derive(Debug)]
pub struct Tunnel {
    /// The public HTTPS URL. Live within a few seconds of `start`, not instantly.
    url: String,
    subdomain: String,
    /// Server-authoritative expiry, epoch milliseconds. Displayed, never enforced.
    expires_at: i64,
    events: broadcast::Sender<TunnelEvent>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Tunnel {
    /// Claims a subdomain, connects to the edge, and starts serving.
    ///
    /// Returns once the lease exists and the connections have been *started* — not once they are
    /// registered. The URL is real from here; whether it is serving yet arrives as
    /// [`TunnelEvent::ConnectionUp`].
    ///
    /// # Errors
    ///
    /// [`StartError`]. Nothing has been left behind on any of these paths: a lease that was claimed
    /// but could not be connected to is released before returning.
    pub async fn start(
        config: TunnelConfig,
        client: ClientKind,
        inspector: Option<Arc<dyn Observer>>,
    ) -> Result<Self, StartError> {
        // **`--backend` skips discovery entirely**, which is what keeps `pnpm dev:cli` and every
        // self-hosted deployment working exactly as before (`docs/SELF_HOSTING.md`). `registry` being
        // `Some` is the only thing that turns federation on, so the default path for a self-hoster is
        // the one that asks no directory anything.
        let (api, lease) = match config.registry.as_deref() {
            None => {
                let api = Api::new(&config.backend).map_err(StartError::Provision)?;
                let lease = api
                    .create_tunnel(config.subdomain.clone(), client)
                    .await
                    .map_err(StartError::Provision)?;
                (api, lease)
            }
            Some(registry) => provision_via_registry(&config, client, registry).await?,
        };

        // **After the claim now, and failure here is still not fatal.** The interval is the only thing
        // read from it, and a tunnel that provisioned fine should not be refused because `/v1/meta`
        // hiccuped — so this is an `Option`, not a `?`. It moved below the claim because the node is
        // not known until the claim has happened on the federated path.
        let published = api.meta().await.ok().map(|meta| meta.heartbeat_interval_ms);

        // Everything from here to a live connector can fail with the lease already claimed, and
        // **every one of those paths must release it**. Written as one closure rather than a `?` per
        // step because a `?` here is silent: it returns the error and leaves the name held for the
        // full lease duration, which is precisely the bug this shape prevents. Adding a step below
        // cannot reintroduce it.
        let connector = async {
            let token = TunnelToken::parse(&lease.tunnel_token).map_err(|_| StartError::Token)?;
            let endpoint = token.endpoint();
            let connector = QuicConnector::new(token, config.local_port, endpoint).await?;
            Ok::<_, StartError>(match inspector {
                Some(sink) => connector.watching(sink),
                None => connector,
            })
        }
        .await;

        let connector = match connector {
            Ok(connector) => connector,
            Err(error) => {
                // The lease exists and nothing will ever connect to it. Releasing it now returns the
                // name immediately instead of leaving it claimed for the whole lease duration —
                // which, on a name the user asked for by hand, is the difference between "try again"
                // and "wait an hour".
                //
                // The result is discarded deliberately: the caller is already being handed the
                // failure that matters, and the lease expires on its own if this does not land.
                let _ = api
                    .delete_tunnel(&lease.subdomain, &lease.owner_token)
                    .await;
                return Err(error);
            }
        };

        Ok(Self::serve(
            config,
            api,
            lease,
            connector,
            heartbeat_interval(published),
        ))
    }

    /// Everything after provisioning, split out so the tests can drive it with a fake connector.
    fn serve<C: Connector>(
        config: TunnelConfig,
        api: Api,
        lease: nport_contract::CreateTunnelResponse,
        connector: C,
        beat: Duration,
    ) -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let (stop, stopped) = oneshot::channel();

        let expires_at = i64::try_from(lease.expires_at).unwrap_or(i64::MAX);
        let _ = events.send(TunnelEvent::Provisioned {
            url: lease.url.clone(),
            subdomain: lease.subdomain.clone(),
            expires_at,
        });

        let handle = TunnelManager::spawn(config, connector);
        let task = tokio::spawn(run(
            api,
            lease.clone(),
            handle,
            events.clone(),
            stopped,
            beat,
        ));

        Self {
            url: lease.url,
            subdomain: lease.subdomain,
            expires_at,
            events,
            stop: Some(stop),
            task,
        }
    }

    /// The public URL.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The subdomain that was actually claimed — normalized, or generated.
    #[must_use]
    pub fn subdomain(&self) -> &str {
        &self.subdomain
    }

    /// Server-authoritative expiry, epoch milliseconds. **Display only** (invariant 3).
    #[must_use]
    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    /// A new receiver. Events are broadcast, so every caller gets its own.
    ///
    /// A receiver created after an event was sent does not see it — which is why
    /// [`TunnelEvent::Provisioned`] is also available directly on this type.
    #[must_use]
    pub fn events(&self) -> broadcast::Receiver<TunnelEvent> {
        self.events.subscribe()
    }

    /// Stops the tunnel: drains the connections, then releases the lease.
    ///
    /// Consumes the value, so a second call does not compile.
    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            // Gone already if the tunnel ended on its own, which is not an error.
            let _ = stop.send(());
        }
        let _ = self.task.await;
    }
}

/// Supervises a running tunnel until it ends, then releases the lease.
async fn run(
    api: Api,
    lease: nport_contract::CreateTunnelResponse,
    handle: TunnelHandle,
    events: broadcast::Sender<TunnelEvent>,
    stopped: oneshot::Receiver<()>,
    beat: Duration,
) {
    // The manager has its own stream; consumers of a `Tunnel` see one. Forwarding rather than
    // handing the manager this channel keeps `TunnelManager` usable on its own, which is what its
    // tests drive.
    //
    // The forwarder also reports when the manager *ends*, and that is not decoration. A pool that
    // gives up announces `ShuttingDown` and stops — and the broadcast sender lives in the handle
    // this function owns, so the stream never closes to say so. Without this signal the select
    // below would wait forever on a tunnel with zero connections: nothing to serve with, no
    // terminal event, and a CLI hanging while it looks healthy. Defect R1's exact shape.
    let (finished, manager_ended) = oneshot::channel();
    let forwarding = tokio::spawn(forward(handle.events(), events.clone(), finished));

    let reason = tokio::select! {
        _ = stopped => ShutdownReason::Requested,
        () = heartbeat(&api, &lease, &events, beat) => ShutdownReason::LeaseExpired,
        _ = manager_ended => ShutdownReason::ConnectionsExhausted,
    };

    if reason == ShutdownReason::LeaseExpired {
        // The manager announces its own `ShuttingDown` when *it* decides to stop. This one is ours:
        // the lease is gone, and the connections are still perfectly healthy — which is exactly the
        // case a user would otherwise see as an unexplained disconnect.
        let _ = events.send(TunnelEvent::ShuttingDown { reason });
    }

    handle.shutdown().await;
    forwarding.abort();

    // Idempotent, and skipping it is safe — the lease expires on its own (`docs/API.md`). So it gets
    // one attempt and no retry: a shutdown path that waits on the network is one that hangs when the
    // network is what failed, and the user pressing Ctrl+C is entitled to a prompt exit.
    let _ = api
        .delete_tunnel(&lease.subdomain, &lease.owner_token)
        .await;

    let _ = events.send(TunnelEvent::Stopped { drained: true });
}

/// Forwards the manager's events, and reports when it ends.
///
/// The manager's own `Stopped` is dropped rather than forwarded — this module sends the last event,
/// after the lease has been released, so a consumer treating `Stopped` as "everything is done" is
/// not lied to. But it is also the manager's *only* signal that it has finished, so it becomes
/// `finished` rather than disappearing.
async fn forward(
    mut from: broadcast::Receiver<TunnelEvent>,
    to: broadcast::Sender<TunnelEvent>,
    finished: oneshot::Sender<()>,
) {
    let mut finished = Some(finished);
    while let Ok(event) = from.recv().await {
        if matches!(event, TunnelEvent::Stopped { .. }) {
            if let Some(finished) = finished.take() {
                // Gone when the shutdown was ours: `run` has already left the select and is waiting
                // on `handle.shutdown()`. Not an error — just nobody listening.
                let _ = finished.send(());
            }
            continue;
        }
        let _ = to.send(event);
    }
}

/// Renews the lease forever. Returns only when the lease is gone for good.
///
/// A failed heartbeat is not on its own fatal: the server allows 120 s of silence, so a blip costs
/// nothing and retrying on the normal interval is the right response. What *is* fatal is the server
/// saying the lease no longer exists — no number of retries brings it back, and a client that kept
/// beating at a tunnel nobody can reach is the "looks healthy, serves nothing" state that R1 was.
async fn heartbeat(
    api: &Api,
    lease: &nport_contract::CreateTunnelResponse,
    events: &broadcast::Sender<TunnelEvent>,
    beat: Duration,
) {
    let mut announced = i64::try_from(lease.expires_at).unwrap_or(i64::MAX);

    loop {
        tokio::time::sleep(beat).await;

        match api.heartbeat(&lease.subdomain, &lease.owner_token).await {
            Ok(renewed) => {
                // **Only when it moved.** A heartbeat does not extend the lease (defect R6), so this
                // number is normally identical every thirty seconds — and re-announcing it makes a
                // CLI reprint its whole URL banner twice a minute. A correction still gets through,
                // which is the case invariant 3 actually cares about: the server owns this number,
                // and if it ever moves one, the display follows.
                let expires_at = i64::try_from(renewed.expires_at).unwrap_or(i64::MAX);
                if expires_at != announced {
                    announced = expires_at;
                    let _ = events.send(TunnelEvent::Provisioned {
                        url: lease.url.clone(),
                        subdomain: lease.subdomain.clone(),
                        expires_at,
                    });
                }
            }
            Err(error) => match error.code() {
                // The lease is gone: expired, deleted elsewhere, or reaped. Nothing to renew.
                ErrorCode::TunnelNotFound
                | ErrorCode::LeaseExpired
                | ErrorCode::InvalidOwnerToken => {
                    return;
                }
                // Anything else is a blip. 120 s of silence is allowed, so one missed beat is not
                // worth reporting to a user who cannot act on it.
                _ => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use nport_contract::CreateTunnelResponse;
    use nport_protocol::rpc::RpcError;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    use super::*;
    use crate::event::ConnectionIndex;
    use crate::manager::{Connection, Shutdown};

    /// A connection that stays up until asked to stop.
    struct Held;

    impl Connection for Held {
        fn colo(&self) -> String {
            "test01".to_owned()
        }
        async fn serve(self, mut shutdown: Shutdown) {
            shutdown.requested().await;
        }
    }

    struct AlwaysUp;

    impl Connector for AlwaysUp {
        type Conn = Held;
        async fn connect(&self, _index: ConnectionIndex, _rotate: bool) -> Result<Held, RpcError> {
            Ok(Held)
        }
    }

    fn lease() -> CreateTunnelResponse {
        CreateTunnelResponse {
            expires_at: 1_785_000_000_000,
            owner_token: "owner".to_owned(),
            subdomain: "myapp".to_owned(),
            tunnel_id: "tunnel".to_owned(),
            tunnel_token: "never parsed in these tests".to_owned(),
            url: "https://myapp.nport.link".to_owned(),
        }
    }

    fn config(backend: String) -> TunnelConfig {
        TunnelConfig {
            local_port: 3000,
            subdomain: Some("myapp".to_owned()),
            backend,
            // Discovery off: these exercise a node directly, which is also every self-hosted
            // deployment's path (`registry: None` is the switch, ADR-0031).
            registry: None,
            nodes_cache: None,
            node: None,
            // Milliseconds rather than the deployed 30 seconds: these assert the drain happens, and
            // waiting half a minute to prove it would be its own kind of bug.
            shutdown_grace: Duration::from_millis(300),
        }
    }

    /// A control plane that answers every request with `response` and counts what it was asked.
    ///
    /// Returns the base URL and a counter of `DELETE`s, which is the one call the teardown path is
    /// judged on.
    async fn control_plane(response: &'static str) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let deletes = Arc::new(AtomicUsize::new(0));

        let counted = Arc::clone(&deletes);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let counted = Arc::clone(&counted);
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match socket.read(&mut byte).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => head.extend_from_slice(&byte),
                        }
                    }
                    let request = String::from_utf8_lossy(&head).into_owned();
                    // The body is drained by the read above only as far as the head; these requests
                    // are small enough that whatever follows is irrelevant to the assertions.
                    if request.starts_with("DELETE ") {
                        counted.fetch_add(1, Ordering::Relaxed);
                        let _ = socket
                            .write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n")
                            .await;
                    } else {
                        let _ = socket.write_all(response.as_bytes()).await;
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });

        (format!("http://{addr}"), deletes)
    }

    /// A server that answers each path with a fixed response, and records the paths it was asked for.
    ///
    /// Deliberately not the `control_plane` helper above: these tests are about *which node gets
    /// asked*, so the assertion is the recorded path list rather than a delete count.
    async fn routed(
        routes: Vec<(&'static str, &'static str)>,
    ) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));

        let recorded = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let routes = routes.clone();
                let recorded = Arc::clone(&recorded);
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match socket.read(&mut byte).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => head.extend_from_slice(&byte),
                        }
                    }
                    let request = String::from_utf8_lossy(&head).into_owned();
                    let line = request.lines().next().unwrap_or_default().to_owned();
                    recorded.lock().expect("lock").push(line.clone());

                    // **Drain the declared body before answering.** Responding and closing while the
                    // client is still writing its `POST` body resets the connection, and the client
                    // reports that as `Unreachable` — which on this path is indistinguishable from a
                    // node that died mid-request, so failover correctly refuses to continue and the
                    // test fails for a reason that has nothing to do with the code. The first draft
                    // did exactly that.
                    let length = request
                        .lines()
                        .find_map(|header| {
                            header
                                .strip_prefix("content-length: ")
                                .or_else(|| header.strip_prefix("Content-Length: "))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    let mut body = vec![0u8; length];
                    if length > 0 && socket.read_exact(&mut body).await.is_err() {
                        return;
                    }

                    let response = routes
                        .iter()
                        .find(|(pattern, _)| line.contains(*pattern))
                        .map_or(
                            "HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
                            |(_, response)| *response,
                        );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        (format!("http://{addr}"), seen)
    }

    fn json(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    const META: &str = r#"{"minClientVersion":"0.0.0","tunnelDurationMs":3600000,"heartbeatIntervalMs":30000,"powDifficulty":1,"maxConcurrentPerSource":3,"maxCreatesPerHourPerSource":20,"activeTunnels":1,"maxActiveTunnels":100}"#;

    /// `/v1/meta` reporting plenty of room, so ranking puts this node first **deterministically**.
    ///
    /// The first draft relied on list order and failed only when the whole suite ran: ranking sorts by
    /// measured latency, and two servers on loopback trade places run to run. Ranking on headroom is
    /// the deterministic lever, and it makes the scenario a more honest one — see the test.
    const META_ROOMY: &str = r#"{"minClientVersion":"0.0.0","tunnelDurationMs":3600000,"heartbeatIntervalMs":30000,"powDifficulty":1,"maxConcurrentPerSource":3,"maxCreatesPerHourPerSource":20,"activeTunnels":0,"maxActiveTunnels":1000}"#;

    /// `/v1/meta` reporting one slot left, so this node ranks behind [`META_ROOMY`].
    const META_TIGHT: &str = r#"{"minClientVersion":"0.0.0","tunnelDurationMs":3600000,"heartbeatIntervalMs":30000,"powDifficulty":1,"maxConcurrentPerSource":3,"maxCreatesPerHourPerSource":20,"activeTunnels":99,"maxActiveTunnels":100}"#;

    /// A challenge at difficulty 1, so the solver finds a nonce immediately.
    ///
    /// Needed because `create_tunnel` fetches and solves one before it posts anything — which is also
    /// why a node that only answers `/v1/tunnels` never gets a `POST` at all. The first draft of these
    /// tests left it out and every one of them failed at the challenge step, which was the fake being
    /// wrong rather than the code.
    const CHALLENGE: &str =
        r#"{"challenge":"test.challenge","difficulty":1,"expiresAt":4102444800000}"#;

    /// A discovery cache path inside a scratch directory, so no test touches a real `~/.nport`.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nport-failover-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    /// **The rule that can lose a user's tunnel**, driven through the real provisioning path.
    ///
    /// A node answering `503 CAPACITY_EXHAUSTED` has told us it created nothing, so moving to the next
    /// candidate is safe. `may_try_another_node`'s unit tests assert the predicate; this asserts the
    /// loop actually uses it, which is the half `docs/ROADMAP.md`'s defect 25 is about.
    ///
    /// **The first node advertises the most room and then refuses**, which is not a contrived setup:
    /// `MAX_ACTIVE_TUNNELS` is checked before the claim, so `apps/api`'s global cap is soft and a burst
    /// can overshoot it between a probe and a create. Ranking on advertised headroom is also what makes
    /// the order here deterministic — sorting on measured latency put two loopback servers in whichever
    /// order the scheduler felt like, and the test passed alone and failed in the full suite.
    #[tokio::test]
    async fn a_full_node_is_skipped_and_the_next_one_serves() {
        let (full, full_seen) = routed(vec![
            ("/v1/challenge", leak(json("200 OK", CHALLENGE))),
            ("/v1/meta", leak(json("200 OK", META_ROOMY))),
            (
                "/v1/tunnels",
                leak(json(
                    "503 Service Unavailable",
                    r#"{"error":{"code":"CAPACITY_EXHAUSTED","message":"full","requestId":"r","docsUrl":"u"}}"#,
                )),
            ),
        ])
        .await;

        let lease = r#"{"subdomain":"myapp","url":"https://myapp.nport.dev","tunnelId":"11111111-2222-3333-4444-555555555555","tunnelToken":"not-a-real-token","ownerToken":"o","expiresAt":1767225600000}"#;
        let (spare, spare_seen) = routed(vec![
            ("/v1/challenge", leak(json("200 OK", CHALLENGE))),
            ("/v1/meta", leak(json("200 OK", META_TIGHT))),
            ("/v1/tunnels", leak(json("201 Created", lease))),
        ])
        .await;

        // The full node is listed first, so ranking cannot be what saves this.
        let nodes = format!(
            r#"{{"nodes":[{{"id":"aaa-full","url":"{full}","domain":"full.test","version":"3.0.0","status":"up","lastSeenAt":1}},{{"id":"bbb-spare","url":"{spare}","domain":"spare.test","version":"3.0.0","status":"up","lastSeenAt":1}}],"refreshAfterMs":300000}}"#
        );
        let (registry, _) = routed(vec![("/v1/nodes", leak(json("200 OK", &nodes)))]).await;

        let mut config = config(String::new());
        config.registry = Some(registry);
        // **Never the real `~/.nport`.** `core` no longer resolves a home directory at all, so a test
        // that forgot this would keep the list in memory rather than writing to a developer's cache.
        config.nodes_cache = Some(discovery::cache_path(&scratch("capacity")));
        // Provisioning succeeds and the token then fails to parse, which is where this stops — far
        // enough to prove which node served.
        let error = Tunnel::start(config, ClientKind::Cli, None).await.err();

        assert!(
            matches!(error, Some(StartError::Token)),
            "should have got as far as parsing a token: {error:?}"
        );
        assert!(
            full_seen
                .lock()
                .expect("lock")
                .iter()
                .any(|line| line.starts_with("POST /v1/tunnels")),
            "the full node should have been tried first"
        );
        assert!(
            spare_seen
                .lock()
                .expect("lock")
                .iter()
                .any(|line| line.starts_with("POST /v1/tunnels")),
            "the spare node should have served after the refusal"
        );
    }

    /// And the mirror image: a refusal about **the caller** must not be shopped around.
    ///
    /// Failing over on `CONCURRENCY_LIMIT` would multiply the per-source cap by the size of the
    /// directory, since each node counts a source independently — `docs/ARCHITECTURE.md` §7's controls
    /// defeated by the client politely trying again somewhere else.
    #[tokio::test]
    async fn a_cap_on_the_caller_is_not_shopped_to_another_node() {
        let (first, _) = routed(vec![
            ("/v1/challenge", leak(json("200 OK", CHALLENGE))),
            ("/v1/meta", leak(json("200 OK", META_ROOMY))),
            (
                "/v1/tunnels",
                leak(json(
                    "429 Too Many Requests",
                    r#"{"error":{"code":"CONCURRENCY_LIMIT","message":"too many","requestId":"r","docsUrl":"u"}}"#,
                )),
            ),
        ])
        .await;

        let (second, second_seen) = routed(vec![
            ("/v1/challenge", leak(json("200 OK", CHALLENGE))),
            ("/v1/meta", leak(json("200 OK", META_TIGHT))),
            (
                "/v1/tunnels",
                leak(json("201 Created", r#"{"subdomain":"x","url":"https://x.test","tunnelId":"11111111-2222-3333-4444-555555555555","tunnelToken":"t","ownerToken":"o","expiresAt":1}"#)),
            ),
        ])
        .await;

        let nodes = format!(
            r#"{{"nodes":[{{"id":"aaa","url":"{first}","domain":"a.test","version":"3.0.0","status":"up","lastSeenAt":1}},{{"id":"bbb","url":"{second}","domain":"b.test","version":"3.0.0","status":"up","lastSeenAt":1}}],"refreshAfterMs":300000}}"#
        );
        let (registry, _) = routed(vec![("/v1/nodes", leak(json("200 OK", &nodes)))]).await;

        let mut config = config(String::new());
        config.registry = Some(registry);
        config.nodes_cache = Some(discovery::cache_path(&scratch("concurrency")));
        let error = Tunnel::start(config, ClientKind::Cli, None).await.err();

        // The user's own cap, reported as such rather than worked around.
        assert!(
            matches!(
                &error,
                Some(StartError::Provision(api)) if api.code() == ErrorCode::ConcurrencyLimit
            ),
            "{error:?}"
        );
        assert!(
            !second_seen
                .lock()
                .expect("lock")
                .iter()
                .any(|line| line.starts_with("POST /v1/tunnels")),
            "the second node must not have been asked — that would double the cap"
        );
    }

    /// `--backend` skips discovery entirely, which is every self-hoster's path.
    #[tokio::test]
    async fn an_explicit_backend_asks_no_registry() {
        let (backend, seen) = routed(vec![
            ("/v1/challenge", leak(json("200 OK", CHALLENGE))),
            ("/v1/meta", leak(json("200 OK", META))),
            (
                "/v1/tunnels",
                leak(json("201 Created", r#"{"subdomain":"x","url":"https://x.test","tunnelId":"11111111-2222-3333-4444-555555555555","tunnelToken":"t","ownerToken":"o","expiresAt":1}"#)),
            ),
        ])
        .await;

        let mut config = config(backend);
        config.registry = None;
        let _ = Tunnel::start(config, ClientKind::Cli, None).await;

        let asked = seen.lock().expect("lock").clone();
        assert!(
            asked
                .iter()
                .any(|line| line.starts_with("POST /v1/tunnels")),
            "{asked:?}"
        );
        assert!(
            !asked.iter().any(|line| line.contains("/v1/nodes")),
            "nothing should have asked for a node list: {asked:?}"
        );
    }

    async fn collect(
        mut events: broadcast::Receiver<TunnelEvent>,
        wanted: usize,
    ) -> Vec<TunnelEvent> {
        let mut seen = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while seen.len() < wanted {
                match events.recv().await {
                    Ok(event) => seen.push(event),
                    Err(_) => break,
                }
            }
        })
        .await;
        seen
    }

    #[tokio::test]
    async fn a_lease_whose_token_cannot_be_parsed_is_released() {
        // `start`'s own documentation promises "nothing has been left behind on any of these
        // paths", and for the token-parse step that was false: a `?` returned the error and left
        // the name claimed for the full four hours. The connector-failure path two lines below it
        // released correctly, which is what made the gap invisible.
        //
        // Found by running the dev stack. The fake control plane minted a token with a non-UUID
        // tunnel id, so every `nport -s devcheck` claimed the name, failed, and left it held —
        // and the next attempt answered SUBDOMAIN_IN_USE with nothing to point at.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let deletes = Arc::new(AtomicUsize::new(0));

        let counted = Arc::clone(&deletes);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let counted = Arc::clone(&counted);
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match socket.read(&mut byte).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => head.extend_from_slice(&byte),
                        }
                    }
                    let request = String::from_utf8_lossy(&head).into_owned();

                    // **Drain the declared body before answering.** The create request carries
                    // JSON, and shutting the socket while the client is still writing it resets the
                    // connection — the client then reports `Unreachable` and never reaches the
                    // token at all. Not `read_to_end`: the client holds its write half open.
                    let length = request
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.trim()
                                .eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    let mut body = vec![0u8; length];
                    if length > 0 && socket.read_exact(&mut body).await.is_err() {
                        return;
                    }

                    // Difficulty 1 so the solver returns immediately; this test is about the
                    // release, not about proof of work.
                    let response = if request.starts_with("GET /v1/challenge") {
                        concat!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n",
                            "connection: close\r\n\r\n",
                            r#"{"challenge":"c.h","difficulty":1,"expiresAt":1785000000000}"#
                        )
                        .to_owned()
                    } else if request.starts_with("DELETE ") {
                        counted.fetch_add(1, Ordering::Relaxed);
                        "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n".to_owned()
                    } else {
                        // `tunnelToken` is not parseable — `not-a-token` is not even base64 JSON.
                        concat!(
                            "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\n",
                            "connection: close\r\n\r\n",
                            r#"{"expiresAt":1785000000000,"ownerToken":"owner","#,
                            r#""subdomain":"myapp","tunnelId":"t","tunnelToken":"not-a-token","#,
                            r#""url":"https://myapp.nport.link"}"#
                        )
                        .to_owned()
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        let error = Tunnel::start(config(format!("http://{addr}")), ClientKind::Cli, None)
            .await
            .expect_err("an unparseable token must fail");

        assert!(matches!(error, StartError::Token), "{error:?}");
        assert_eq!(
            deletes.load(Ordering::Relaxed),
            1,
            "the lease must be released, or the name is held for its full duration"
        );
    }

    #[tokio::test]
    async fn a_started_tunnel_announces_its_url_and_carries_no_credential() {
        // The desktop app forwards this stream into a WebView, so a token here would cross a
        // boundary it must never cross — and the URL is the one thing every consumer needs.
        let (backend, _) = control_plane("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
        let api = Api::new(&backend).expect("backend");

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysUp, HEARTBEAT_INTERVAL);
        let events = tunnel.events();

        assert_eq!(tunnel.url(), "https://myapp.nport.link");
        assert_eq!(tunnel.subdomain(), "myapp");
        assert_eq!(tunnel.expires_at(), 1_785_000_000_000);

        // Subscribed after `serve` sent `Provisioned`, which is exactly why the URL is on the type
        // as well as in the stream.
        let seen = collect(events, 1).await;
        let rendered = format!("{seen:?}").to_lowercase();
        assert!(!rendered.contains("owner"), "{rendered}");
        assert!(!rendered.contains("token"), "{rendered}");

        tunnel.shutdown().await;
    }

    #[tokio::test]
    async fn stopping_releases_the_lease() {
        // Skipping the delete is safe — the lease expires on its own — but not doing it holds a name
        // the user asked for by hand for the rest of its duration.
        let (backend, deletes) =
            control_plane("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
        let api = Api::new(&backend).expect("backend");

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysUp, HEARTBEAT_INTERVAL);
        let _ = collect(tunnel.events(), 1).await;
        tunnel.shutdown().await;

        assert_eq!(
            deletes.load(Ordering::Relaxed),
            1,
            "shutdown must release the lease, exactly once"
        );
    }

    #[tokio::test]
    async fn the_manager_events_reach_a_consumer_of_the_tunnel() {
        // A `Tunnel` has one stream. If the forwarder were missing, a CLI would show a URL and then
        // nothing — no connections, no failures, no ending.
        let (backend, _) = control_plane("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
        let api = Api::new(&backend).expect("backend");

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysUp, HEARTBEAT_INTERVAL);
        let seen = collect(tunnel.events(), 2).await;

        assert!(
            seen.iter()
                .any(|event| matches!(event, TunnelEvent::ConnectionUp { .. })),
            "expected a connection to be announced, saw {seen:?}"
        );
        tunnel.shutdown().await;
    }

    /// Fails every attempt in a way nothing can retry, so the pool gives up.
    struct AlwaysFatal;

    impl Connector for AlwaysFatal {
        type Conn = Held;
        async fn connect(&self, _index: ConnectionIndex, _rotate: bool) -> Result<Held, RpcError> {
            Err(RpcError::Malformed("unreadable".into()))
        }
    }

    #[tokio::test]
    async fn a_pool_that_gives_up_ends_the_tunnel_rather_than_leaving_it_looking_alive() {
        // Nobody asked it to stop and the lease is fine — there is simply nothing left to serve
        // with. Without this the tunnel sits with zero connections, the CLI never receives a
        // terminal event, and the process hangs looking healthy: defect R1's exact shape.
        let (backend, _) = control_plane("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
        let api = Api::new(&backend).expect("backend");

        let tunnel = Tunnel::serve(
            config(backend),
            api,
            lease(),
            AlwaysFatal,
            HEARTBEAT_INTERVAL,
        );
        let seen = collect(tunnel.events(), 3).await;

        assert!(
            seen.contains(&TunnelEvent::ShuttingDown {
                reason: ShutdownReason::ConnectionsExhausted
            }),
            "expected the exhaustion to be announced, saw {seen:?}"
        );
        assert!(
            seen.iter()
                .any(|event| matches!(event, TunnelEvent::Stopped { .. })),
            "a tunnel that ends must say so — it is the CLI's only signal to exit: {seen:?}"
        );
    }

    #[tokio::test]
    async fn a_lease_that_is_gone_is_not_reported_as_a_failure() {
        // Reaching the end of a four-hour lease is the system working as designed (defect R6). A
        // CLI should say "your time is up", not "error" — which is why this is a `ShutdownReason`
        // and not an `ErrorCode`.
        assert_ne!(
            ShutdownReason::LeaseExpired,
            ShutdownReason::ConnectionsExhausted
        );
        assert_ne!(ShutdownReason::LeaseExpired, ShutdownReason::Requested);
    }

    #[test]
    fn a_token_that_cannot_be_parsed_never_reaches_the_error() {
        // `TokenError` is written so no variant can quote any part of its input, and wrapping it in
        // a `#[source]` here would be the obvious place to undo that.
        let error = StartError::Token;
        let rendered = format!("{error} {error:?}");
        assert!(!rendered.contains("eyJ"), "{rendered}");
        assert_eq!(error.code(), ErrorCode::EdgeProtocolError);
    }

    #[test]
    fn the_beat_rate_comes_from_the_server() {
        // `GET /v1/meta` publishes `heartbeatIntervalMs` as a quarter of the grace period so a client
        // does not have to guess, and this value being hardcoded meant the server could not shorten
        // its own grace: the published number was read by nobody.
        assert_eq!(heartbeat_interval(Some(5_000)), Duration::from_secs(5));
        assert_eq!(heartbeat_interval(Some(45_000)), Duration::from_secs(45));
    }

    #[test]
    fn an_absent_or_nonsense_interval_falls_back() {
        // A `/v1/meta` that could not be read must not stop a tunnel that provisioned fine, and a
        // zero would spin the loop instead of pacing it.
        assert_eq!(heartbeat_interval(None), HEARTBEAT_INTERVAL);
        assert_eq!(heartbeat_interval(Some(0)), HEARTBEAT_INTERVAL);
    }

    #[test]
    fn the_server_cannot_talk_us_into_an_absurd_rate() {
        // Trusting the published value is right; trusting it unboundedly is not. An hour would
        // silently disable renewal, which looks exactly like the lease expiring on its own.
        assert_eq!(
            heartbeat_interval(Some(3_600_000)),
            MAX_HEARTBEAT_INTERVAL,
            "clamped from above"
        );
        assert_eq!(
            heartbeat_interval(Some(1)),
            MIN_HEARTBEAT_INTERVAL,
            "clamped from below"
        );
    }

    #[test]
    fn the_heartbeat_has_room_for_misses() {
        // The fallback is used when the server does not say, so it still has to be safe against the
        // documented default grace of 120 s. An interval that left no margin would turn one lost
        // packet into a lost tunnel.
        assert!(HEARTBEAT_INTERVAL * 3 < Duration::from_secs(120));

        // And the same property has to hold for what the server asks for, since `heartbeatIntervalMs`
        // is a quarter of whatever grace it is running: four beats per window, three misses of room.
        for grace_ms in [30_000_u64, 60_000, 120_000, 600_000] {
            let beat = heartbeat_interval(Some(grace_ms / 4));
            assert!(
                beat * 3 < Duration::from_millis(grace_ms),
                "grace {grace_ms}ms leaves no room at a {beat:?} beat"
            );
        }
    }
}
