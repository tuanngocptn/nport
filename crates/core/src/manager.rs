//! `TunnelManager`: the task that turns the supervisor's decisions into connections.
//!
//! The public surface `crates/CLAUDE.md` specifies, and nothing more:
//!
//! ```text
//! TunnelManager::spawn(config, connector) -> TunnelHandle
//! handle.events() -> broadcast::Receiver<TunnelEvent>
//! ```
//!
//! **This module owns sockets and timers. It owns no rules.** Every decision — who starts, how long
//! to wait, whether to rotate, when to give up — comes from [`crate::supervisor`], which is pure and
//! tested without a network. That division is deliberate: `apps/api` produced five reachable
//! concurrency bugs, every one of them inside an I/O loop where the decision could not be tested on
//! its own.
//!
//! ## Generic over a connector
//!
//! What it means to "connect" differs by transport (ADR-0017) and, more usefully here, can be faked.
//! The tests drive a connector that fails on schedule, so the whole supervision loop — backoff,
//! rotation, giving up, the pool surviving one dead connection — is exercised with no edge at all.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use nport_protocol::rpc::RpcError;
use tokio::sync::{broadcast, oneshot, watch};

use crate::event::{ConnectionIndex, ShutdownReason, TunnelEvent};
use crate::supervisor::{Action, CONNECTIONS, Supervisor};

/// How long connections get to unregister and drain before they are cut.
///
/// cloudflared: `--grace-period`, default 30s, hard maximum 3 min. `docs/PROTOCOL.md` §12 — graceful
/// shutdown is `unregisterConnection`, then hold the connection open so in-flight requests finish,
/// then close.
///
/// **The CLI should pass something shorter**, and §12 says so explicitly: a developer pressing Ctrl+C
/// expects a prompt exit, not half a minute of apparent hang. This constant matches upstream so the
/// library default is unsurprising; choosing the user-facing number is `crates/cli`'s job, which is
/// why §12 also says core must make this a config value rather than a constant.
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

/// How many events are buffered for a slow consumer before the oldest are dropped.
///
/// A lagging receiver loses events rather than blocking the tunnel — a CLI that stops reading must
/// never be able to stall traffic. 256 is far more than a human-paced consumer needs.
const EVENT_BUFFER: usize = 256;

/// What the user asked for.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// The local port to forward to. Probed before provisioning (`crates/CLAUDE.md` CLI rule 6).
    pub local_port: u16,
    /// The requested subdomain, or `None` to have one generated.
    pub subdomain: Option<String>,
    /// The control-plane base URL. Overridable for self-hosting (`docs/SELF_HOSTING.md`).
    ///
    /// Used directly when [`Self::registry`] is `None`, and as nothing at all when it is `Some` — the
    /// node comes from discovery then.
    pub backend: String,
    /// The registry to discover a node through, or `None` to use [`Self::backend`] directly.
    ///
    /// **`None` is the switch that keeps `--backend` and every self-hosted deployment untouched**
    /// (ADR-0031). Discovery is opt-in, and the opt-in is this field being set.
    pub registry: Option<String>,
    /// Where to cache the node list, or `None` to keep it in memory only.
    ///
    /// **This crate does not resolve a home directory**, deliberately: reading `HOME` from a library
    /// is how a test writes to a developer's real `~/.nport`, which is what the first draft of the
    /// failover tests did. `crates/cli` owns the environment and passes a path in.
    pub nodes_cache: Option<std::path::PathBuf>,
    /// A node id to pin, from `--node`. Ignored unless [`Self::registry`] is set.
    ///
    /// A pin that cannot be honoured is a hard failure rather than a silent fallback: the user named
    /// one node, and quietly using another would be the wrong kind of helpful.
    pub node: Option<String>,
    /// How long in-flight requests get to finish on shutdown. See [`DEFAULT_SHUTDOWN_GRACE`].
    pub shutdown_grace: Duration,
}

impl TunnelConfig {
    /// A config with the documented grace period.
    #[must_use]
    pub fn new(local_port: u16, subdomain: Option<String>, backend: String) -> Self {
        Self {
            local_port,
            subdomain,
            backend,
            registry: None,
            nodes_cache: None,
            node: None,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        }
    }
}

/// Tells a connection that the tunnel is stopping.
///
/// Handed to [`Connection::serve`] so the connection can do the §12 sequence itself —
/// `unregisterConnection`, let in-flight requests finish, then close. The manager cannot do that on
/// its behalf: only the connection holds the control stream, and only the transport knows what
/// "close" means.
#[derive(Debug, Clone)]
pub struct Shutdown(watch::Receiver<bool>);

impl Shutdown {
    /// Resolves when shutdown has been requested. Returns immediately if it already has.
    pub async fn requested(&mut self) {
        // `changed()` only fires on transitions, so an already-set flag has to be checked first or a
        // connection that starts serving after the request would wait forever.
        if *self.0.borrow() {
            return;
        }
        let _ = self.0.changed().await;
    }
}

/// A live connection to the edge, from the manager's point of view.
pub trait Connection: Send + 'static {
    /// The Cloudflare colo that answered. Useful in a bug report and nowhere else.
    fn colo(&self) -> String;

    /// Serves until the connection ends, or until `shutdown` fires and the drain completes.
    ///
    /// **On shutdown the implementation must unregister and drain, not just close.** Closing without
    /// `unregisterConnection` drops in-flight requests on the floor (`docs/PROTOCOL.md` §12), and the
    /// edge keeps routing to a connection that is no longer there. Returning means it is safe to cut.
    fn serve(self, shutdown: Shutdown) -> impl std::future::Future<Output = ()> + Send;
}

/// Dials and registers one connection.
///
/// Exists so the supervision loop can be driven without an edge — see the tests — and so a second
/// transport (ADR-0017) plugs in without touching this file.
pub trait Connector: Send + Sync + 'static {
    type Conn: Connection;

    /// Dials index `index`, rotating to a different edge address first if asked.
    fn connect(
        &self,
        index: ConnectionIndex,
        rotate: bool,
    ) -> impl std::future::Future<Output = Result<Self::Conn, RpcError>> + Send;
}

/// A running tunnel.
///
/// Dropping it does **not** stop the tunnel — call [`TunnelHandle::shutdown`]. Drop-as-stop reads
/// well until a caller holds the handle in a struct that gets moved, at which point the tunnel dies
/// for reasons nobody can see.
#[derive(Debug)]
pub struct TunnelHandle {
    events: broadcast::Sender<TunnelEvent>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl TunnelHandle {
    /// A new receiver. Each caller gets its own; events are broadcast, not consumed.
    #[must_use]
    pub fn events(&self) -> broadcast::Receiver<TunnelEvent> {
        self.events.subscribe()
    }

    /// Asks the tunnel to stop and waits for it.
    ///
    /// **Consumes the handle, which is how re-entrancy is prevented by construction.** v2's signal
    /// handler called an async cleanup it never awaited, with no guard, so a second Ctrl+C fired a
    /// second delete (defect R19). Here a second call does not compile.
    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            // The receiver is gone only if the tunnel already ended on its own, which is not an error.
            let _ = stop.send(());
        }
        let _ = self.task.await;
    }
}

/// Starts a tunnel and returns immediately.
pub struct TunnelManager;

impl TunnelManager {
    /// Spawns the supervision tasks and returns a handle.
    ///
    /// Returns as soon as the tasks are spawned; the caller learns what happened from the event
    /// stream, never from a return value. That is what lets one API serve both a CLI rendering a
    /// spinner and a GUI updating a list.
    #[must_use]
    pub fn spawn<C: Connector>(config: TunnelConfig, connector: C) -> TunnelHandle {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let (stop, stopped) = oneshot::channel();

        let task = tokio::spawn(run(config, Arc::new(connector), events.clone(), stopped));

        TunnelHandle {
            events,
            stop: Some(stop),
            task,
        }
    }
}

async fn run<C: Connector>(
    config: TunnelConfig,
    connector: Arc<C>,
    events: broadcast::Sender<TunnelEvent>,
    stopped: oneshot::Receiver<()>,
) {
    let supervisor = Arc::new(Mutex::new(Supervisor::new(CONNECTIONS)));
    let (draining, drain_signal) = watch::channel(false);

    // The start plan is the supervisor's, not this loop's: only connection 0 may start until it
    // registers (§4). Each index then runs its own task, which is what ADR-0024's thread boundary
    // bought — these are ordinary `tokio::spawn`s.
    let mut tasks = Vec::new();
    for index in 0..CONNECTIONS {
        tasks.push(tokio::spawn(supervise(
            index,
            Arc::clone(&connector),
            Arc::clone(&supervisor),
            events.clone(),
            Shutdown(drain_signal.clone()),
        )));
    }

    // Whichever comes first: the caller asking to stop, or every connection giving up.
    let reason = tokio::select! {
        _ = stopped => ShutdownReason::Requested,
        () = watch_for_exhaustion(&supervisor) => ShutdownReason::ConnectionsExhausted,
    };

    let _ = events.send(TunnelEvent::ShuttingDown { reason });

    // Ask, then wait — do not abort. Aborting a task mid-`serve` cuts the connection without
    // `unregisterConnection`, which drops in-flight requests on the floor and leaves the edge routing
    // to a connection that is gone (`docs/PROTOCOL.md` §12). The first version of this function did
    // exactly that, while the `Transport::close` docs said not to.
    let _ = draining.send(true);

    let drained = tokio::time::timeout(config.shutdown_grace, async {
        for task in &mut tasks {
            let _ = task.await;
        }
    })
    .await
    .is_ok();

    if !drained {
        // The grace period is a deadline, not a suggestion: a connection that will not finish must
        // not hold the process open forever. `Stopped { drained: false }` is how the CLI learns to
        // report `SHUTDOWN_TIMEOUT`.
        for task in tasks {
            task.abort();
        }
    }

    let _ = events.send(TunnelEvent::Stopped { drained });
}

/// Resolves once every connection has given up. Never resolves while any remain.
async fn watch_for_exhaustion(supervisor: &Mutex<Supervisor>) {
    loop {
        {
            // Scoped tightly and never held across the await below — a lock across an await is
            // forbidden (`docs/conventions/rust.md`), and here it would also deadlock the tasks that
            // need it to record their own outcomes.
            let guard = supervisor.lock().expect("supervisor lock poisoned");
            if guard.exhausted() {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// One connection index, for the life of the tunnel.
async fn supervise<C: Connector>(
    index: ConnectionIndex,
    connector: Arc<C>,
    supervisor: Arc<Mutex<Supervisor>>,
    events: broadcast::Sender<TunnelEvent>,
    shutdown: Shutdown,
) {
    // Wait for this index's turn. Connection 0 goes first; the rest are staggered behind it (§4).
    loop {
        let delay = {
            let guard = supervisor.lock().expect("supervisor lock poisoned");
            guard
                .start_plan()
                .into_iter()
                .find(|(planned, _)| *planned == index)
                .map(|(_, delay)| delay)
        };
        match delay {
            Some(delay) => {
                // The staggered start (§4) is up to three seconds for the last index, and it has to
                // be interruptible for the same reason the poll below is: the drain waits for every
                // task, so an index asleep waiting its turn would burn the whole grace period doing
                // nothing. Missing this was the second half of the same bug.
                let mut waiting = shutdown.clone();
                tokio::select! {
                    () = tokio::time::sleep(delay) => break,
                    () = waiting.requested() => return,
                }
            }
            // Not yet cleared to start: the lead has not registered. Poll rather than signal,
            // because the wait is bounded by one registration and this costs nothing.
            //
            // Shutdown has to be observable here too. An index still waiting its turn holds no
            // connection, but the join below waits for *every* task — so without this, stopping a
            // tunnel whose lead never came up would burn the whole grace period on nothing.
            None => {
                if *shutdown.0.borrow() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    let mut rotate = false;
    loop {
        supervisor
            .lock()
            .expect("supervisor lock poisoned")
            .connecting(index);

        let outcome = connector.connect(index, rotate).await;

        let (emitted, action) = match outcome {
            Ok(connection) => {
                let colo = connection.colo();
                {
                    let mut guard = supervisor.lock().expect("supervisor lock poisoned");
                    for event in guard.registered(index, colo) {
                        let _ = events.send(event);
                    }
                }
                // Serves until the connection ends or the drain completes. Not holding the lock
                // here is the point.
                connection.serve(shutdown.clone()).await;
                if *shutdown.0.borrow() {
                    // Drained on purpose. Reconnecting now would re-register a connection the edge
                    // has just been told to forget.
                    return;
                }
                supervisor
                    .lock()
                    .expect("supervisor lock poisoned")
                    .lost(index)
            }
            Err(error) => {
                let jitter = jitter_fraction();
                supervisor
                    .lock()
                    .expect("supervisor lock poisoned")
                    .failed(index, &error, jitter)
            }
        };

        for event in emitted {
            let _ = events.send(event);
        }

        match action {
            Action::Connect {
                after,
                rotate: next,
            } => {
                rotate = next;
                tokio::time::sleep(after).await;
            }
            Action::GiveUp { .. } | Action::Idle => return,
        }
    }
}

/// A pseudo-random fraction in `0.0..1.0` for backoff jitter.
///
/// Uses `RandomState`, which is seeded differently per instance, rather than adding a `rand`
/// dependency for one number. Jitter needs to be *spread*, not cryptographically unpredictable — its
/// whole job is stopping thousands of clients retrying in lockstep after an edge blip.
fn jitter_fraction() -> f64 {
    use std::hash::{BuildHasher as _, Hasher as _};

    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u8(0);
    // The top 53 bits map exactly onto f64's mantissa, so this is uniform in [0, 1).
    #[allow(clippy::cast_precision_loss)]
    let value = (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64;
    value
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A connection that ends as soon as it is served.
    struct Instant;

    impl Connection for Instant {
        fn colo(&self) -> String {
            "test01".to_owned()
        }
        async fn serve(self, _shutdown: Shutdown) {}
    }

    /// A connection that stays up until the test ends.
    struct Held;

    impl Connection for Held {
        fn colo(&self) -> String {
            "test01".to_owned()
        }
        /// Serves until asked to stop, then "drains" instantly — a well-behaved connection.
        async fn serve(self, mut shutdown: Shutdown) {
            shutdown.requested().await;
        }
    }

    /// Ignores the shutdown signal entirely, the way a wedged connection would.
    struct Stuck;

    impl Connection for Stuck {
        fn colo(&self) -> String {
            "test01".to_owned()
        }
        async fn serve(self, _shutdown: Shutdown) {
            std::future::pending::<()>().await;
        }
    }

    struct NeverDrains;

    impl Connector for NeverDrains {
        type Conn = Stuck;
        async fn connect(&self, _index: ConnectionIndex, _rotate: bool) -> Result<Stuck, RpcError> {
            Ok(Stuck)
        }
    }

    /// Registers every index and holds.
    struct AlwaysUp;

    impl Connector for AlwaysUp {
        type Conn = Held;
        async fn connect(&self, _index: ConnectionIndex, _rotate: bool) -> Result<Held, RpcError> {
            Ok(Held)
        }
    }

    /// Fails every attempt in a way nothing can retry.
    struct AlwaysFatal;

    impl Connector for AlwaysFatal {
        type Conn = Instant;
        async fn connect(
            &self,
            _index: ConnectionIndex,
            _rotate: bool,
        ) -> Result<Instant, RpcError> {
            Err(RpcError::Malformed("unreadable".into()))
        }
    }

    /// Fails only index 3, fatally. The rest stay up.
    #[derive(Default)]
    struct OneBadIndex {
        attempts: AtomicUsize,
    }

    impl Connector for OneBadIndex {
        type Conn = Held;
        async fn connect(&self, index: ConnectionIndex, _rotate: bool) -> Result<Held, RpcError> {
            self.attempts.fetch_add(1, Ordering::Relaxed);
            if index == 3 {
                Err(RpcError::Malformed("unreadable".into()))
            } else {
                Ok(Held)
            }
        }
    }

    fn config() -> TunnelConfig {
        TunnelConfig {
            local_port: 3000,
            subdomain: Some("test".to_owned()),
            backend: "https://api.nport.link".to_owned(),
            // Discovery off: these exercise a node directly, which is also every self-hosted
            // deployment's path (`registry: None` is the switch, ADR-0031).
            registry: None,
            nodes_cache: None,
            node: None,
            // Milliseconds, not the deployed 30 seconds: these tests assert the deadline is honoured,
            // and waiting half a minute to prove it would be its own kind of bug.
            shutdown_grace: Duration::from_millis(300),
        }
    }

    async fn collect(
        mut events: broadcast::Receiver<TunnelEvent>,
        wanted: usize,
    ) -> Vec<TunnelEvent> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Duration::from_secs(5);
        let _ = tokio::time::timeout(deadline, async {
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
    async fn every_connection_comes_up_and_is_announced() {
        let handle = TunnelManager::spawn(config(), AlwaysUp);
        let events = handle.events();

        let seen = collect(events, usize::from(CONNECTIONS)).await;
        let up = seen
            .iter()
            .filter(|event| matches!(event, TunnelEvent::ConnectionUp { .. }))
            .count();

        assert_eq!(up, usize::from(CONNECTIONS));
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn a_requested_shutdown_says_so_and_then_stops() {
        let handle = TunnelManager::spawn(config(), AlwaysUp);
        let mut events = handle.events();

        // Let the pool come up first, so the shutdown is not racing the start plan.
        let _ = collect(handle.events(), 1).await;
        handle.shutdown().await;

        let mut reasons = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let TunnelEvent::ShuttingDown { reason } = event {
                reasons.push(reason);
            }
        }
        assert!(
            reasons.contains(&ShutdownReason::Requested),
            "expected a Requested shutdown, saw {reasons:?}"
        );
    }

    #[tokio::test]
    async fn losing_every_connection_ends_the_tunnel_on_its_own() {
        // Nobody asked it to stop; it stopped because there is nothing left to serve with. The CLI
        // needs this to exit non-zero rather than hang looking healthy.
        let handle = TunnelManager::spawn(config(), AlwaysFatal);
        let events = handle.events();

        let seen = collect(events, usize::from(CONNECTIONS) + 2).await;

        assert!(
            seen.contains(&TunnelEvent::ShuttingDown {
                reason: ShutdownReason::ConnectionsExhausted
            }),
            "expected exhaustion, saw {seen:?}"
        );
        assert!(
            seen.iter()
                .any(|event| matches!(event, TunnelEvent::Stopped { .. }))
        );
    }

    #[tokio::test]
    async fn one_dead_connection_does_not_end_the_tunnel() {
        // Three of four is degraded, not stopped. Ending here would turn a routine edge problem into
        // an outage the user did not have.
        let handle = TunnelManager::spawn(config(), OneBadIndex::default());
        let events = handle.events();

        let seen = collect(events, 4).await;

        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, TunnelEvent::ShuttingDown { .. })),
            "a single dead index must not stop the tunnel: {seen:?}"
        );
        assert!(
            seen.iter()
                .any(|event| matches!(event, TunnelEvent::ConnectionUp { .. }))
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn a_graceful_shutdown_lets_connections_drain() {
        // The bug this replaced: shutdown called `task.abort()`, cutting connections without
        // `unregisterConnection`. That drops in-flight requests on the floor and leaves the edge
        // routing to a connection that is gone (§12) — the exact thing `Transport::close`'s own docs
        // say must never happen.
        let handle = TunnelManager::spawn(config(), AlwaysUp);
        let mut events = handle.events();
        let _ = collect(handle.events(), 1).await;

        handle.shutdown().await;

        let mut stopped = None;
        while let Ok(event) = events.try_recv() {
            if let TunnelEvent::Stopped { drained } = event {
                stopped = Some(drained);
            }
        }
        assert_eq!(
            stopped,
            Some(true),
            "a connection that observes the signal must drain within the grace period"
        );
    }

    #[tokio::test]
    async fn a_connection_that_will_not_drain_does_not_hold_the_process_open() {
        // The grace period is a deadline, not a suggestion. `drained: false` is how the CLI learns to
        // report SHUTDOWN_TIMEOUT rather than claiming a clean stop.
        let handle = TunnelManager::spawn(config(), NeverDrains);
        let mut events = handle.events();
        let _ = collect(handle.events(), 1).await;

        let stopping = tokio::time::timeout(Duration::from_secs(5), handle.shutdown()).await;
        assert!(
            stopping.is_ok(),
            "shutdown must not hang on a wedged connection"
        );

        let mut stopped = None;
        while let Ok(event) = events.try_recv() {
            if let TunnelEvent::Stopped { drained } = event {
                stopped = Some(drained);
            }
        }
        assert_eq!(stopped, Some(false));
    }

    #[test]
    fn jitter_is_spread_across_the_window() {
        // Not a randomness test — just that it is not a constant. A jitter function returning the
        // same number every time would silently restore the thundering herd it exists to prevent.
        let draws: Vec<f64> = (0..64).map(|_| jitter_fraction()).collect();
        assert!(draws.iter().all(|value| (0.0..1.0).contains(value)));
        let distinct = draws
            .iter()
            .filter(|value| (**value - draws[0]).abs() > f64::EPSILON)
            .count();
        assert!(distinct > 0, "jitter must vary, got {draws:?}");
    }
}
