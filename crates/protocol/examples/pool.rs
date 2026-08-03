//! Phase 1 sub-step 7: the four-connection pool — **G1 criterion 4**.
//!
//! Staggered start, per-index edge rotation, reconnect with backoff, and a summary at the end
//! that says whether the run actually held up.
//!
//! ```text
//! NPORT_POOL_MINUTES=30 NPORT_POOL_KILL_EVERY=300 \
//!   ./crates/protocol/tests/live/pool.sh builtin pool-spike
//! ```
//!
//! Throwaway, like `spike.rs`. The supervision policy here — how many connections, how long
//! to back off, when to give up — is `crates/core`'s job, not `crates/protocol`'s
//! (`crates/CLAUDE.md`). This file exists to find out whether the policy in `docs/PROTOCOL.md`
//! §4 and §12 survives contact with the live edge, not to be the implementation of it.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "support/capture.rs"]
mod capture;
#[path = "support/proxy.rs"]
mod proxy;

use nport_protocol::edge::{self, AddressPool};
use nport_protocol::quic::{self, KeyExchange};
use nport_protocol::rpc::{self, RpcError};
use nport_protocol::token::{Endpoint, TunnelToken};

/// Connections in the pool.
///
/// cloudflared: `cmd/cloudflared/tunnel/cmd.go` → `HaConnections` default.
const CONNECTIONS: u8 = 4;

/// Gap between starting connection *n* and connection *n+1*, after 0 has registered.
///
/// cloudflared: `supervisor/supervisor.go` → `registrationInterval`.
const REGISTRATION_INTERVAL: Duration = Duration::from_secs(1);

/// Backoff base. Doubles per consecutive failure for one index, capped.
///
/// cloudflared: `supervisor/supervisor.go` → `tunnelRetryDuration`.
const RETRY_BASE: Duration = Duration::from_secs(10);

/// Ceiling on the backoff, so a long outage does not turn into a 40-minute sleep.
const RETRY_CAP: Duration = Duration::from_secs(60);

/// Consecutive failures on one index before it gives up for good.
///
/// cloudflared: `--retries` default. Counts *consecutive* failures — any successful
/// registration resets it, so a connection that flaps all day never exhausts it.
const MAX_RETRIES: u32 = 5;

/// How long connection 0 gets to register before the run is declared a failure. Nothing else
/// starts until it does (§4), so there is no point continuing past this.
const FIRST_CONNECTION_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Debug, Default)]
struct Stats {
    exchanges: AtomicU64,
    registrations: AtomicU64,
    dial_failures: AtomicU64,
    registration_failures: AtomicU64,
    connection_losses: AtomicU64,
    forced_kills: AtomicU64,
}

/// What a supervisor should do about a failure. The classification is
/// `docs/PROTOCOL.md` §12; the actions are this file's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Disposition {
    /// Move to a different edge address.
    Rotate,
    /// Try the same address again — the tunnel is probably still propagating.
    Retry,
    /// Nothing a retry will fix.
    Fatal,
}

/// Classifies a registration failure per §12.
fn classify(error: &RpcError) -> Disposition {
    match error {
        // `EDUPCONN` means this address already has a connection with our index; retrying it
        // loops forever. A cause containing `Unauthorized` is usually a freshly created
        // tunnel that has not propagated yet, so the same address will start working.
        RpcError::Refused { cause, .. } if cause.contains("EDUPCONN") => Disposition::Rotate,
        RpcError::Refused { cause, .. } if cause.contains("Unauthorized") => Disposition::Retry,
        RpcError::Refused { should_retry, .. } => {
            if *should_retry {
                Disposition::Retry
            } else {
                Disposition::Fatal
            }
        }
        RpcError::OpenStream(_) | RpcError::Capnp(_) | RpcError::Timeout => Disposition::Rotate,
        // An uninterpretable response is an edge protocol change (risks P4/P5). Rotating
        // would just find another edge that speaks the same new protocol.
        RpcError::Malformed(_) => Disposition::Fatal,
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> std::process::ExitCode {
    let minutes: u64 = env_u64("NPORT_POOL_MINUTES").unwrap_or(30);
    let kill_every = env_u64("NPORT_POOL_KILL_EVERY").map(Duration::from_secs);
    let run_for = Duration::from_secs(minutes * 60);

    println!("nport connection pool — {CONNECTIONS} connections for {minutes} min");
    if let Some(every) = kill_every {
        println!(
            "forced disconnect every {}s (a local close: it proves detection, rotation, and\n\
             re-registration, but the trigger is ours — pull the network for the real thing)",
            every.as_secs()
        );
    }
    println!();

    let Ok(raw_token) = std::env::var("NPORT_TUNNEL_TOKEN") else {
        println!("✗ set NPORT_TUNNEL_TOKEN (never pass it in argv)");
        return std::process::ExitCode::FAILURE;
    };
    let token = match TunnelToken::parse(&raw_token) {
        Ok(token) => Arc::new(token),
        Err(error) => {
            println!("✗ token did not parse: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let origin = match resolve_origin().await {
        Ok(origin) => origin,
        Err(error) => {
            println!("✗ {error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    // SRV is what cloudflared actually does; the direct shortcut is the fallback here rather
    // than the other way round, because a 30-minute run should exercise the real path.
    let regions = match edge::discover_srv(Endpoint::Global).await {
        Ok(regions) => regions,
        Err(error) => {
            println!("! SRV discovery failed ({error}), falling back to A/AAAA");
            match edge::discover_direct(Endpoint::Global).await {
                Ok(regions) => regions,
                Err(error) => {
                    println!("✗ edge discovery failed: {error}");
                    return std::process::ExitCode::FAILURE;
                }
            }
        }
    };
    let pool = match AddressPool::new(regions) {
        Ok(pool) => Arc::new(Mutex::new(pool)),
        Err(error) => {
            println!("✗ {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    println!(
        "pool ready across {} regions\n",
        pool.lock().expect("uncontended").regions()
    );

    let stats = Arc::new(Stats::default());
    let live: Arc<Mutex<HashMap<u8, quinn::Connection>>> = Arc::new(Mutex::new(HashMap::new()));
    // One connector ID for the process, as cloudflared does — it identifies the connector,
    // not the connection.
    let client_id = uuid::Uuid::new_v4();
    let deadline = Instant::now() + run_for;
    let started = Instant::now();

    // ── Why a LocalSet ───────────────────────────────────────────────────────────────
    // `capnp-rpc` holds `Rc` internally, so the future returned by `register_connection`
    // is **not `Send`** — and because a supervisor awaits it, neither is `supervise`.
    // `tokio::spawn` rejects it outright.
    //
    // rpc.rs anticipated this for a long-lived control stream and understated it: it applies
    // to registration itself, so no amount of dropping the control stream afterwards avoids
    // it. All four supervisors therefore share one OS thread. That is fine here — they only
    // register and accept streams, and every exchange is `tokio::spawn`ed onto the
    // multi-threaded runtime, so proxying is unaffected.
    //
    // `crates/core` should not inherit this shape. Confine the RPC to a dedicated
    // current-thread runtime and hand back the (`Send`) `ConnectionDetails`, so callers can
    // spawn per-connection tasks normally.
    let local = tokio::task::LocalSet::new();

    // A progress line a minute, so a 30-minute run is watchable and a stall is obvious.
    // Both of these only touch `Arc` and `quinn::Connection`, which are `Send`.
    let heartbeat = tokio::spawn(heartbeat(Arc::clone(&live), Arc::clone(&stats), deadline));
    let killer = kill_every.map(|every| {
        tokio::spawn(forced_disconnects(
            every,
            Arc::clone(&live),
            Arc::clone(&stats),
            deadline,
        ))
    });

    let outcomes = local
        .run_until({
            let stats = Arc::clone(&stats);
            async move {
                // Connection 0 registers alone and must succeed before anything else starts (§4).
                let first = loop {
                    if started.elapsed() > FIRST_CONNECTION_DEADLINE {
                        println!("✗ connection 0 never registered — nothing else may start (§4)");
                        return Vec::new();
                    }
                    match establish(0, &pool, &token, client_id).await {
                        Ok(established) => break established,
                        Err(error) => {
                            println!("  [0] {error} — retrying");
                            tokio::time::sleep(RETRY_BASE).await;
                        }
                    }
                };
                println!(
                    "✓ connection 0 registered on {} ({}), colo {}\n",
                    first.peer, first.region, first.colo
                );
                stats.registrations.fetch_add(1, Ordering::Relaxed);

                let mut handles = vec![tokio::task::spawn_local(supervise(
                    0,
                    Some(first),
                    Arc::clone(&pool),
                    Arc::clone(&token),
                    client_id,
                    origin,
                    Arc::clone(&stats),
                    Arc::clone(&live),
                    deadline,
                ))];

                for index in 1..CONNECTIONS {
                    tokio::time::sleep(REGISTRATION_INTERVAL).await;
                    handles.push(tokio::task::spawn_local(supervise(
                        index,
                        None,
                        Arc::clone(&pool),
                        Arc::clone(&token),
                        client_id,
                        origin,
                        Arc::clone(&stats),
                        Arc::clone(&live),
                        deadline,
                    )));
                }

                let mut outcomes = Vec::new();
                for handle in handles {
                    if let Ok(outcome) = handle.await {
                        outcomes.push(outcome);
                    }
                }
                outcomes
            }
        })
        .await;

    heartbeat.abort();
    if let Some(killer) = killer {
        killer.abort();
    }

    report(&stats, &outcomes, started.elapsed(), run_for)
}

/// One live, registered connection.
struct Established {
    connection: quinn::Connection,
    endpoint: quinn::Endpoint,
    peer: SocketAddr,
    region: String,
    colo: String,
}

/// The result of supervising one index for the whole run.
#[derive(Debug, Default)]
struct Outcome {
    index: u8,
    registrations: u32,
    rotations: u32,
    gave_up: bool,
    /// Total time this index spent with a registered connection.
    connected: Duration,
}

/// Claims an address, dials it, and registers. One attempt, no retry — the caller owns policy.
async fn establish(
    index: u8,
    pool: &Arc<Mutex<AddressPool>>,
    token: &TunnelToken,
    client_id: uuid::Uuid,
) -> Result<Established, String> {
    // The lock is taken, used, and dropped — never held across the await below.
    let (peer, region) = {
        let mut pool = pool.lock().expect("pool mutex is never poisoned");
        let peer = pool.claim(index).map_err(|e| e.to_string())?;
        let region = pool.region_of(peer).unwrap_or("unknown").to_owned();
        (peer, region)
    };

    // A fresh endpoint per attempt here; `supervise` reuses one across reconnects, which is
    // what keeps the source port stable (§4, `portForConnIndex`).
    let endpoint = quic::bind_endpoint(peer, KeyExchange::PostQuantumPreferred)
        .map_err(|e| format!("bind for {peer} failed: {e}"))?;
    let connection = quic::connect_on(&endpoint, peer, KeyExchange::PostQuantumPreferred)
        .await
        .map_err(|e| format!("dial {peer} failed: {e}"))?;

    let version = concat!("nport/", env!("CARGO_PKG_VERSION"));
    let details = rpc::register_connection(&connection, token, index, client_id, version)
        .await
        .map_err(|e| format!("registration on {peer} refused: {e}"))?;

    Ok(Established {
        connection,
        endpoint,
        peer,
        region,
        colo: details.location_name,
    })
}

/// Keeps one connection index registered and serving until the deadline.
#[expect(
    clippy::too_many_arguments,
    reason = "a throwaway example; crates/core will pass a context struct"
)]
async fn supervise(
    index: u8,
    mut ready: Option<Established>,
    pool: Arc<Mutex<AddressPool>>,
    token: Arc<TunnelToken>,
    client_id: uuid::Uuid,
    origin: SocketAddr,
    stats: Arc<Stats>,
    live: Arc<Mutex<HashMap<u8, quinn::Connection>>>,
    deadline: Instant,
) -> Outcome {
    let mut outcome = Outcome {
        index,
        ..Outcome::default()
    };
    // Held for the index's whole life so every reconnect leaves from the same source port.
    // Seeded from `ready` when the caller already established one — connection 0 registers in
    // `main` before the others start (§4), and dropping its endpoint here would make its first
    // reconnect rebind, quietly skipping the behaviour this variable exists for.
    let mut endpoint: Option<quinn::Endpoint> = ready
        .as_ref()
        .map(|established| established.endpoint.clone());
    let mut consecutive_failures = 0u32;

    while Instant::now() < deadline {
        let established = match ready.take() {
            Some(established) => established,
            None => {
                let (peer, region) = {
                    let mut pool = pool.lock().expect("uncontended");
                    let peer = match pool.claim(index) {
                        Ok(peer) => peer,
                        Err(error) => {
                            println!("  [{index}] no address available: {error}");
                            break;
                        }
                    };
                    let region = pool.region_of(peer).unwrap_or("unknown").to_owned();
                    (peer, region)
                };

                // Rebind only when the family changes: reusing the socket is the entire
                // point, and `AddressPool` prefers IPv4 so this is rare.
                let reusable = endpoint
                    .as_ref()
                    .and_then(|e| e.local_addr().ok())
                    .is_some_and(|local| local.is_ipv4() == peer.is_ipv4());
                if !reusable {
                    match quic::bind_endpoint(peer, KeyExchange::PostQuantumPreferred) {
                        Ok(bound) => endpoint = Some(bound),
                        Err(error) => {
                            println!("  [{index}] bind failed: {error}");
                            break;
                        }
                    }
                }
                let socket = endpoint.as_ref().expect("just bound");

                match quic::connect_on(socket, peer, KeyExchange::PostQuantumPreferred).await {
                    Ok(connection) => {
                        let version = concat!("nport/", env!("CARGO_PKG_VERSION"));
                        match rpc::register_connection(
                            &connection,
                            &token,
                            index,
                            client_id,
                            version,
                        )
                        .await
                        {
                            Ok(details) => Established {
                                connection,
                                endpoint: socket.clone(),
                                peer,
                                region,
                                colo: details.location_name,
                            },
                            Err(error) => {
                                stats.registration_failures.fetch_add(1, Ordering::Relaxed);
                                consecutive_failures += 1;
                                let disposition = classify(&error);
                                println!(
                                    "  [{index}] registration failed on {peer}: {error} → {disposition:?}"
                                );
                                if disposition == Disposition::Fatal
                                    || consecutive_failures >= MAX_RETRIES
                                {
                                    outcome.gave_up = true;
                                    break;
                                }
                                if disposition == Disposition::Rotate {
                                    rotate(&pool, index, &mut outcome);
                                }
                                backoff(consecutive_failures, deadline).await;
                                continue;
                            }
                        }
                    }
                    Err(error) => {
                        stats.dial_failures.fetch_add(1, Ordering::Relaxed);
                        consecutive_failures += 1;
                        println!("  [{index}] dial {peer} failed: {error}");
                        // §12: a dial error always rotates. Upstream falls back to HTTP/2
                        // after `--max-edge-addr-retries`; that is ADR-0017's ladder and
                        // Phase 2b's job.
                        rotate(&pool, index, &mut outcome);
                        if consecutive_failures >= MAX_RETRIES {
                            outcome.gave_up = true;
                            break;
                        }
                        backoff(consecutive_failures, deadline).await;
                        continue;
                    }
                }
            }
        };

        // Registered. A successful registration resets the failure count, so a connection
        // that flaps every ten minutes never exhausts MAX_RETRIES.
        consecutive_failures = 0;
        outcome.registrations += 1;
        stats.registrations.fetch_add(1, Ordering::Relaxed);
        println!(
            "  [{index}] up on {} ({}), colo {}",
            established.peer, established.region, established.colo
        );

        live.lock()
            .expect("uncontended")
            .insert(index, established.connection.clone());
        let since = Instant::now();
        let reason = serve(&established.connection, origin, &stats, deadline).await;
        outcome.connected += since.elapsed();
        live.lock().expect("uncontended").remove(&index);

        match reason {
            Ended::Deadline => {
                // Graceful: §12 wants unregisterConnection then a drain, which needs the
                // control stream kept open — see the note in rpc.rs about LocalSet. The
                // spike closes directly and the lease is deleted by the driver script.
                established.connection.close(0u32.into(), b"pool done");
                established.endpoint.wait_idle().await;
                pool.lock().expect("uncontended").release(index);
                break;
            }
            Ended::Lost(error) => {
                stats.connection_losses.fetch_add(1, Ordering::Relaxed);
                println!(
                    "  [{index}] connection lost after {:.0?}: {error}",
                    since.elapsed()
                );
                // §12: an idle timeout rotates. So does anything else at this level — if the
                // connection died, the address it died on is the prime suspect.
                rotate(&pool, index, &mut outcome);

                // **No backoff here**, deliberately. Backoff belongs to *failing to
                // establish*; a connection that registered and later died is a different
                // event, and the pool is down a quarter of its capacity for every second
                // spent waiting. `consecutive_failures` was reset by the successful
                // registration, so if the immediate reconnect attempt also fails the normal
                // backoff takes over from there.
                //
                // The one-second floor exists only to bound a pathological register-and-die
                // loop; without it that becomes a hot loop against the edge.
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }

    outcome
}

/// Why a serve loop stopped.
enum Ended {
    Deadline,
    Lost(quinn::ConnectionError),
}

/// Accepts and proxies exchanges until the connection dies or the deadline passes.
async fn serve(
    connection: &quinn::Connection,
    origin: SocketAddr,
    stats: &Arc<Stats>,
    deadline: Instant,
) -> Ended {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ended::Deadline;
        }
        tokio::select! {
            () = tokio::time::sleep(remaining) => return Ended::Deadline,
            accepted = connection.accept_bi() => match accepted {
                Ok((send, recv)) => {
                    stats.exchanges.fetch_add(1, Ordering::Relaxed);
                    tokio::spawn(async move {
                        if let Err(error) = proxy::handle_exchange(send, recv, origin).await {
                            println!("  ✗ exchange failed: {error}");
                        }
                    });
                }
                Err(error) => return Ended::Lost(error),
            },
        }
    }
}

fn rotate(pool: &Arc<Mutex<AddressPool>>, index: u8, outcome: &mut Outcome) {
    if let Err(error) = pool.lock().expect("uncontended").rotate(index) {
        println!("  [{index}] rotation found nothing: {error}");
    } else {
        outcome.rotations += 1;
    }
}

/// Exponential backoff from [`RETRY_BASE`], capped, and never past the deadline.
async fn backoff(attempt: u32, deadline: Instant) {
    let scaled = RETRY_BASE
        .saturating_mul(1u32 << attempt.min(3))
        .min(RETRY_CAP);
    let wait = scaled.min(deadline.saturating_duration_since(Instant::now()));
    // No jitter: one process with four connections has nothing to de-synchronise against.
    // `crates/core` needs it — thousands of clients reconnecting after an edge blip is
    // exactly the thundering herd jitter exists for.
    tokio::time::sleep(wait).await;
}

/// Closes one connection periodically so the reconnect path is exercised on purpose.
///
/// **This is a local close, not an edge-initiated one.** It proves detection, rotation, and
/// re-registration work; it does not prove the QUIC idle-timeout path, which needs the
/// network to actually go away. Toggle Wi-Fi for that.
async fn forced_disconnects(
    every: Duration,
    live: Arc<Mutex<HashMap<u8, quinn::Connection>>>,
    stats: Arc<Stats>,
    deadline: Instant,
) {
    let mut turn = 0u8;
    while Instant::now() < deadline {
        let wait = every.min(deadline.saturating_duration_since(Instant::now()));
        if wait.is_zero() {
            break;
        }
        tokio::time::sleep(wait).await;
        if Instant::now() >= deadline {
            break;
        }

        let index = turn % CONNECTIONS;
        turn = turn.wrapping_add(1);
        let victim = live.lock().expect("uncontended").get(&index).cloned();
        if let Some(connection) = victim {
            println!("  ! forcing a disconnect on connection {index}");
            connection.close(1u32.into(), b"forced disconnect");
            stats.forced_kills.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn heartbeat(
    live: Arc<Mutex<HashMap<u8, quinn::Connection>>>,
    stats: Arc<Stats>,
    deadline: Instant,
) {
    let started = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if Instant::now() >= deadline {
            return;
        }
        let up: Vec<u8> = {
            let live = live.lock().expect("uncontended");
            let mut indices: Vec<u8> = live.keys().copied().collect();
            indices.sort_unstable();
            indices
        };
        println!(
            "  · {:.0?} elapsed — {}/{CONNECTIONS} up {:?}, {} exchanges, {} losses",
            started.elapsed(),
            up.len(),
            up,
            stats.exchanges.load(Ordering::Relaxed),
            stats.connection_losses.load(Ordering::Relaxed),
        );
    }
}

fn report(
    stats: &Stats,
    outcomes: &[Outcome],
    elapsed: Duration,
    target: Duration,
) -> std::process::ExitCode {
    println!("\n── summary ──────────────────────────────────────────────");
    println!("ran for                  {elapsed:.0?} of {target:.0?}");
    println!(
        "registrations            {}",
        stats.registrations.load(Ordering::Relaxed)
    );
    println!(
        "exchanges served         {}",
        stats.exchanges.load(Ordering::Relaxed)
    );
    println!(
        "connection losses        {} ({} of them forced)",
        stats.connection_losses.load(Ordering::Relaxed),
        stats.forced_kills.load(Ordering::Relaxed)
    );
    println!(
        "dial / registration failures  {} / {}",
        stats.dial_failures.load(Ordering::Relaxed),
        stats.registration_failures.load(Ordering::Relaxed)
    );

    let supervised: Vec<&Outcome> = outcomes.iter().filter(|o| o.registrations > 0).collect();
    for outcome in &supervised {
        // Availability per index, which is the number criterion 4 actually cares about.
        let share = if elapsed.is_zero() {
            0.0
        } else {
            outcome.connected.as_secs_f64() / elapsed.as_secs_f64() * 100.0
        };
        println!(
            "  [{}] {} registration(s), {} rotation(s), connected {:.0?} ({share:.1}%){}",
            outcome.index,
            outcome.registrations,
            outcome.rotations,
            outcome.connected,
            if outcome.gave_up { " — GAVE UP" } else { "" }
        );
    }

    // The verdict, spelled out rather than left to the reader: criterion 4 is four
    // connections sustained for the target duration across a forced disconnect.
    let all_four = supervised.len() == usize::from(CONNECTIONS);
    let none_gave_up = supervised.iter().all(|o| !o.gave_up);
    let long_enough = elapsed + Duration::from_secs(30) >= target;
    let recovered = stats.connection_losses.load(Ordering::Relaxed) == 0
        || stats.registrations.load(Ordering::Relaxed) > u64::from(CONNECTIONS);

    println!();
    for (label, passed) in [
        ("all four connections registered", all_four),
        ("no connection gave up", none_gave_up),
        ("ran the full duration", long_enough),
        ("re-registered after every loss", recovered),
    ] {
        println!("  {} {label}", if passed { "✓" } else { "✗" });
    }

    if all_four && none_gave_up && long_enough && recovered {
        println!("\n✓ G1 criterion 4 met");
        std::process::ExitCode::SUCCESS
    } else {
        println!("\n✗ G1 criterion 4 NOT met");
        std::process::ExitCode::FAILURE
    }
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

/// The local origin: `NPORT_SPIKE_ORIGIN` if set, otherwise the built-in one.
async fn resolve_origin() -> Result<SocketAddr, String> {
    if let Ok(value) = std::env::var("NPORT_SPIKE_ORIGIN") {
        let target = if value.contains(':') {
            value
        } else {
            format!("127.0.0.1:{value}")
        };
        let address: SocketAddr = target
            .parse()
            .map_err(|_| format!("NPORT_SPIKE_ORIGIN is not an address: {target}"))?;
        // R18: probe before provisioning anything.
        tokio::net::TcpStream::connect(address)
            .await
            .map_err(|e| format!("nothing is listening on {address}: {e}"))?;
        println!("forwarding to {address} (pre-flight probe ok)");
        return Ok(address);
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not bind a local origin: {e}"))?;
    let address = listener
        .local_addr()
        .map_err(|e| format!("bound listener has no address: {e}"))?;
    tokio::spawn(proxy::serve_origin(listener));
    println!("built-in origin on {address}");
    Ok(address)
}
