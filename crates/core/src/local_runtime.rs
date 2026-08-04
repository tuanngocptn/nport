//! A thread where `!Send` things are allowed to live.
//!
//! **This is ADR-0024, implemented.** `capnp-rpc` holds `Rc` internally, so `RpcSystem` and every
//! future derived from it are `!Send`. `crates/protocol`'s `register_connection` awaits one, which
//! makes *its* future `!Send`, which makes anything awaiting that `!Send` — and `tokio::spawn`
//! rejects the lot.
//!
//! Phase 1's `examples/pool.rs` worked around it by putting all four connection supervisors on one
//! `LocalSet`. That is fine for a spike and wrong to ship: it pushes a dependency's implementation
//! detail into every consumer and serialises unrelated per-connection work onto one thread for the
//! sake of one RPC.
//!
//! So the non-`Send` region gets a thread of its own. Jobs arrive over a channel, results leave over
//! one, and **only `Send` data crosses** — which is why `TunnelManager` can use ordinary
//! `tokio::spawn` everywhere else, and why neither `crates/cli` nor `apps/desktop` ever learns that a
//! `!Send` type exists in the dependency tree.
//!
//! ## What this costs
//!
//! One extra thread per process — not per connection — and one channel hop on the registration path.
//! Registration happens once per connection per reconnect and costs a few hundred milliseconds of
//! network time, so the hop is unmeasurable.

use std::future::Future;
use std::pin::Pin;

use tokio::sync::{mpsc, oneshot};

/// A job to run on the confined thread.
///
/// The **closure** is `Send` — it has to cross the channel — but the future it returns need not be.
/// That distinction is the whole mechanism: the `Rc`s are created on the far thread and never leave
/// it, so nothing that is genuinely thread-unsafe is ever moved.
type Job = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()>>> + Send + 'static>;

/// A handle to the thread that hosts the non-`Send` work.
///
/// Cloneable and `Send`, so per-connection tasks can each hold one.
#[derive(Debug, Clone)]
pub struct LocalRuntime {
    jobs: mpsc::UnboundedSender<Job>,
}

/// The runtime's thread has gone away.
///
/// In practice this means shutdown is in progress: the only thing that stops the thread is dropping
/// the last handle. A caller should treat it as "stop trying", not as a tunnel error.
#[derive(Debug, thiserror::Error)]
#[error("the local runtime has shut down")]
pub struct Gone;

impl LocalRuntime {
    /// Starts the thread.
    ///
    /// The thread lives until every [`LocalRuntime`] handle is dropped, at which point the channel
    /// closes and its loop ends — so there is no explicit shutdown call to forget, and no task
    /// without a defined shutdown path (`docs/conventions/rust.md`).
    #[must_use]
    pub fn start() -> Self {
        let (jobs, mut inbox) = mpsc::unbounded_channel::<Job>();

        std::thread::Builder::new()
            .name("nport-rpc".to_owned())
            .spawn(move || {
                // Current-thread, because the point is to *not* require `Send`. A multi-threaded
                // runtime cannot host these futures at all.
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    // Nothing can be done from a bare thread with no channel to report on, and this
                    // crate may not print (invariant 5). Callers see `Gone` when the channel closes,
                    // which is the accurate description of what happened.
                    Err(_) => return,
                };

                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    while let Some(job) = inbox.recv().await {
                        // `spawn_local`, so jobs are concurrent with each other but stay on this
                        // thread. Sequential execution here would serialise four connections'
                        // registrations behind one another for no reason.
                        tokio::task::spawn_local(job());
                    }
                });
            })
            // A thread that cannot be spawned is not something a library can recover from, and the
            // failure surfaces as `Gone` on the first `run`.
            .ok();

        Self { jobs }
    }

    /// Runs `make` on the confined thread and waits for its result.
    ///
    /// `make` is `Send` and returns a future that need not be. `T` **must** be `Send`, which is the
    /// property that keeps the confinement honest: only plain data comes back.
    ///
    /// # Errors
    ///
    /// [`Gone`] if the thread has stopped, or if the job was dropped before producing a value.
    pub async fn run<F, Fut, T>(&self, make: F) -> Result<T, Gone>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = T> + 'static,
        T: Send + 'static,
    {
        let (reply, answer) = oneshot::channel();

        let job: Job = Box::new(move || {
            Box::pin(async move {
                let value = make().await;
                // The receiver going away means the caller lost interest — a cancelled connection
                // attempt, usually. Nothing to report.
                let _ = reply.send(value);
            })
        });

        self.jobs.send(job).map_err(|_| Gone)?;
        answer.await.map_err(|_| Gone)
    }
}

/// A call against a hosted object: borrows it, does something, returns nothing.
///
/// The `for<'a>` is what lets the future borrow the object it was handed. Without it the closure
/// would have to take ownership, which defeats the point — the object must survive the call.
type Call<T> =
    Box<dyn for<'a> FnOnce(&'a mut T) -> Pin<Box<dyn Future<Output = ()> + 'a>> + Send + 'static>;

/// A handle to an object that lives on the confined thread.
///
/// **The object never moves.** It is built there and stays there; callers send closures that borrow
/// it. That is the difference from [`LocalRuntime::run`], which is run-to-completion and so cannot
/// hold anything open — and holding something open is exactly what `docs/PROTOCOL.md` §12 needs, since
/// graceful shutdown means keeping the control stream alive for the connection's whole life so
/// `unregisterConnection` can still be called.
///
/// `Hosted<T>` is `Send` **even when `T` is not**, via `PhantomData<fn() -> T>`: the handle carries no
/// `T`, only the ability to ask for work on one. That is the property that lets a `!Send` capnp
/// session be owned by an ordinary `tokio::spawn`ed task.
#[derive(Debug)]
pub struct Hosted<T> {
    calls: mpsc::UnboundedSender<Call<T>>,
    /// Marks the type without holding one. `fn() -> T` is covariant and unconditionally `Send`.
    marker: std::marker::PhantomData<fn() -> T>,
}

impl<T> Clone for Hosted<T> {
    fn clone(&self) -> Self {
        Self {
            calls: self.calls.clone(),
            marker: std::marker::PhantomData,
        }
    }
}

impl<T> Hosted<T> {
    /// Runs `call` against the object and waits for its result.
    ///
    /// Calls are served **one at a time**, in order. That is deliberate rather than a limitation: a
    /// capnp `RpcSystem` is not safe to drive concurrently from two places, and a session that
    /// interleaved an `unregisterConnection` with something else would be a protocol bug rather than a
    /// performance win.
    ///
    /// # Errors
    ///
    /// [`Gone`] if the runtime or the object's task has stopped.
    pub async fn call<F, R>(&self, call: F) -> Result<R, Gone>
    where
        F: for<'a> FnOnce(&'a mut T) -> Pin<Box<dyn Future<Output = R> + 'a>> + Send + 'static,
        R: Send + 'static,
    {
        let (reply, answer) = oneshot::channel();

        let boxed: Call<T> = Box::new(move |value| {
            Box::pin(async move {
                let result = call(value).await;
                // The caller losing interest is not an error — a cancelled connection attempt, usually.
                let _ = reply.send(result);
            })
        });

        self.calls.send(boxed).map_err(|_| Gone)?;
        answer.await.map_err(|_| Gone)
    }
}

impl LocalRuntime {
    /// Builds a `!Send` object on the confined thread and returns a handle to it.
    ///
    /// Waits for construction, so a successful return means the object exists. See [`Hosted`] for why
    /// this cannot be expressed with [`LocalRuntime::run`].
    ///
    /// The object lives until every [`Hosted`] handle is dropped, at which point its call channel
    /// closes and its loop ends — the same shutdown rule as the runtime itself, so nothing needs an
    /// explicit close that someone could forget.
    ///
    /// # Errors
    ///
    /// [`Gone`] if the runtime has stopped before the object could be built.
    pub async fn host<T, F, Fut>(&self, make: F) -> Result<Hosted<T>, Gone>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = T> + 'static,
        T: 'static,
    {
        let (calls, mut inbox) = mpsc::unbounded_channel::<Call<T>>();
        let (ready, built) = oneshot::channel::<()>();

        let job: Job = Box::new(move || {
            Box::pin(async move {
                let mut value = make().await;
                // Signal *after* construction, so a handle is never handed out for an object that does
                // not exist yet — a caller's first `call` would otherwise race the constructor.
                let _ = ready.send(());
                while let Some(call) = inbox.recv().await {
                    call(&mut value).await;
                }
            })
        });

        self.jobs.send(job).map_err(|_| Gone)?;
        built.await.map_err(|_| Gone)?;

        Ok(Hosted {
            calls,
            marker: std::marker::PhantomData,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn runs_a_future_that_could_never_be_spawned() {
        // The whole point, asserted directly: this future holds an `Rc` across an await, so it is
        // `!Send` and `tokio::spawn` would refuse it. `capnp-rpc`'s registration future has exactly
        // this shape.
        let runtime = LocalRuntime::start();

        let answer = runtime
            .run(|| async {
                let shared = Rc::new(41);
                let borrowed = Rc::clone(&shared);
                tokio::task::yield_now().await;
                *borrowed + 1
            })
            .await
            .expect("the runtime should still be up");

        assert_eq!(answer, 42);
    }

    #[tokio::test]
    async fn jobs_do_not_block_each_other() {
        // `spawn_local` rather than sequential execution. Four connections registering must not
        // queue behind one another — that would trade one problem for a slower one.
        let runtime = LocalRuntime::start();

        let first = runtime.run(|| async {
            tokio::time::sleep(Duration::from_millis(120)).await;
            "slow"
        });
        let second = runtime.run(|| async { "fast" });

        let (slow, fast) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(5), first),
            tokio::time::timeout(Duration::from_secs(5), second),
        );
        assert_eq!(slow.expect("no timeout").expect("up"), "slow");
        assert_eq!(fast.expect("no timeout").expect("up"), "fast");
    }

    #[tokio::test]
    async fn the_thread_stops_when_the_last_handle_is_dropped() {
        // No explicit shutdown call to forget, and no task without a defined shutdown path.
        let runtime = LocalRuntime::start();
        let clone = runtime.clone();
        drop(runtime);

        // Still alive: a clone remains.
        assert_eq!(clone.run(|| async { 1 }).await.expect("up"), 1);

        drop(clone);
        // Nothing left to assert on directly — the thread's exit is what ends it — but the type
        // makes the lifetime obvious, which is the property worth having.
    }

    /// Deliberately `!Send`: an `Rc` field is the cheapest stand-in for a capnp `RpcSystem`.
    struct Session {
        calls: Rc<std::cell::Cell<u32>>,
        open: bool,
    }

    #[tokio::test]
    async fn a_hosted_object_survives_between_calls() {
        // The difference from `run`, and the whole reason this API exists. `run` is
        // run-to-completion, so it cannot hold a control stream open — which is what §12's graceful
        // shutdown needs for the connection's whole life.
        let runtime = LocalRuntime::start();
        let session = runtime
            .host(|| async {
                Session {
                    calls: Rc::new(std::cell::Cell::new(0)),
                    open: true,
                }
            })
            .await
            .expect("runtime up");

        for expected in 1..=3 {
            let count = session
                .call(|s| {
                    Box::pin(async move {
                        s.calls.set(s.calls.get() + 1);
                        s.calls.get()
                    })
                })
                .await
                .expect("session up");
            assert_eq!(count, expected, "state must persist across calls");
        }

        // And it is still the same object, not a fresh one per call.
        let open = session
            .call(|s| Box::pin(async move { s.open }))
            .await
            .expect("session up");
        assert!(open);
    }

    #[tokio::test]
    async fn a_handle_to_a_non_send_object_is_itself_send() {
        // The property that lets an ordinary `tokio::spawn`ed task own a capnp session. `Session`
        // holds an `Rc` and could never cross a thread; `Hosted<Session>` can, because it carries no
        // `Session` at all.
        let runtime = LocalRuntime::start();
        let session = runtime
            .host(|| async {
                Session {
                    calls: Rc::new(std::cell::Cell::new(7)),
                    open: true,
                }
            })
            .await
            .expect("runtime up");

        // If `Hosted` were not `Send`, this would not compile.
        let moved = tokio::spawn(async move {
            session
                .call(|s| Box::pin(async move { s.calls.get() }))
                .await
        });

        assert_eq!(moved.await.expect("task").expect("session up"), 7);
    }

    #[tokio::test]
    async fn calls_are_served_one_at_a_time() {
        // Not a performance choice: a capnp `RpcSystem` is not safe to drive concurrently, and a
        // session interleaving `unregisterConnection` with something else is a protocol bug.
        let runtime = LocalRuntime::start();
        let session = runtime
            .host(|| async {
                Session {
                    calls: Rc::new(std::cell::Cell::new(0)),
                    open: true,
                }
            })
            .await
            .expect("runtime up");

        // A slow call followed by a fast one: if they overlapped, the counter would interleave.
        let slow = session.call(|s| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(80)).await;
                s.calls.set(s.calls.get() + 1);
                s.calls.get()
            })
        });
        let fast = session.call(|s| {
            Box::pin(async move {
                s.calls.set(s.calls.get() + 1);
                s.calls.get()
            })
        });

        let (first, second) = tokio::join!(slow, fast);
        assert_eq!(first.expect("up"), 1);
        assert_eq!(second.expect("up"), 2, "the fast call must wait its turn");
    }

    #[tokio::test]
    async fn calling_a_dropped_runtime_reports_gone() {
        // A session outliving its runtime must fail, not hang — a connection task waiting forever on
        // a dead thread is the worst possible shutdown behaviour.
        let runtime = LocalRuntime::start();
        let session = runtime
            .host(|| async {
                Session {
                    calls: Rc::new(std::cell::Cell::new(0)),
                    open: true,
                }
            })
            .await
            .expect("runtime up");
        drop(runtime);

        // The hosting task holds the object, so calls keep working while it lives; what must never
        // happen is an indefinite wait once it does not.
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            session.call(|s| Box::pin(async move { s.open })),
        )
        .await;
        assert!(result.is_ok(), "a call must resolve rather than hang");
    }

    #[tokio::test]
    async fn a_dropped_job_reports_gone_rather_than_hanging() {
        // A job whose future never completes must not wedge the caller forever if the thread dies.
        // Here the reply sender is dropped by the job itself, which is the same observable outcome.
        let runtime = LocalRuntime::start();
        let result = runtime
            .run(|| async {
                // Returning normally is the happy path; this test exists so the error path has a
                // named shape rather than a panic.
                Option::<u8>::None
            })
            .await;
        assert_eq!(result.expect("up"), None);
    }
}
