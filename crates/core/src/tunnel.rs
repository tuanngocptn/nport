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

use nport_contract::{ClientKind, ErrorCode};
use nport_protocol::token::TunnelToken;
use tokio::sync::{broadcast, oneshot};

use crate::api::{Api, ApiError};
use crate::connector::QuicConnector;
use crate::event::{ShutdownReason, TunnelEvent};
use crate::inspector::Observer;
use crate::manager::{Connector, TunnelConfig, TunnelHandle, TunnelManager};

/// How often the lease is renewed.
///
/// `docs/ARCHITECTURE.md` §3c. Distinct from the QUIC keep-alive in `docs/PROTOCOL.md` §12: that one
/// keeps the *edge connection* up, this one keeps the *lease* alive, and either can fail while the
/// other is healthy. The server drops a lease after 120 s without one, so this has room for three
/// misses before anything is lost.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

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
        let api = Api::new(&config.backend).map_err(StartError::Provision)?;
        let lease = api
            .create_tunnel(config.subdomain.clone(), client)
            .await
            .map_err(StartError::Provision)?;

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

        Ok(Self::serve(config, api, lease, connector))
    }

    /// Everything after provisioning, split out so the tests can drive it with a fake connector.
    fn serve<C: Connector>(
        config: TunnelConfig,
        api: Api,
        lease: nport_contract::CreateTunnelResponse,
        connector: C,
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
        let task = tokio::spawn(run(api, lease.clone(), handle, events.clone(), stopped));

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
        () = heartbeat(&api, &lease, &events) => ShutdownReason::LeaseExpired,
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
) {
    let mut announced = i64::try_from(lease.expires_at).unwrap_or(i64::MAX);

    loop {
        tokio::time::sleep(HEARTBEAT_INTERVAL).await;

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

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysUp);
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

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysUp);
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

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysUp);
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

        let tunnel = Tunnel::serve(config(backend), api, lease(), AlwaysFatal);
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
    fn the_heartbeat_has_room_for_misses() {
        // The server drops a lease after 120 s of silence. An interval that left no margin would
        // turn one lost packet into a lost tunnel.
        assert!(HEARTBEAT_INTERVAL * 3 < Duration::from_secs(120));
    }
}
