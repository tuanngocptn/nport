//! When to try again, where, and when to stop.
//!
//! Pure policy, deliberately. Every decision here is a function of an error and a counter, so the
//! whole of it is testable without a network — and the orchestration that owns sockets and timers
//! never has to encode a rule. `crates/protocol` is not the place for this either: it "speaks the
//! wire and nothing else", and retrying is lifecycle policy (`crates/CLAUDE.md`).
//!
//! The classification is `docs/PROTOCOL.md` §12's, and getting it wrong is expensive in a specific
//! way: retrying an `EDUPCONN` against the same address loops forever, because the edge is telling
//! us *that address already has our connection index*.

use std::time::Duration;

use nport_contract::ErrorCode;
use nport_protocol::rpc::RpcError;

/// Backoff base, doubling per consecutive failure for one index.
///
/// cloudflared: `supervisor/supervisor.go` → `tunnelRetryDuration`.
pub const RETRY_BASE: Duration = Duration::from_secs(10);

/// Ceiling on the backoff, so a long outage does not become a 40-minute sleep.
pub const RETRY_CAP: Duration = Duration::from_secs(60);

/// Consecutive failures on one index before it gives up.
///
/// cloudflared: the `--retries` default. **Consecutive** — any successful registration resets the
/// count, so a connection that flaps all day never exhausts it. A cumulative count would kill a
/// perfectly healthy long-running tunnel on a bad network.
pub const MAX_RETRIES: u32 = 5;

/// What to do about a failed registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Move to a different edge address.
    Rotate,
    /// Try the same address again — the tunnel is probably still propagating.
    Retry,
    /// Nothing a retry will fix.
    Fatal,
}

/// Classifies a registration failure per `docs/PROTOCOL.md` §12.
#[must_use]
pub fn classify(error: &RpcError) -> Disposition {
    match error {
        // `EDUPCONN` means this address already has a connection with our index. Retrying the same
        // address loops forever; only rotation makes progress.
        RpcError::Refused { cause, .. } if cause.contains("EDUPCONN") => Disposition::Rotate,
        // A freshly created tunnel takes time to propagate, and the edge reports that as an
        // authorization failure. The *same* address starts working shortly, so rotating would just
        // spread the confusion across the fleet.
        RpcError::Refused { cause, .. } if cause.contains("Unauthorized") => Disposition::Retry,
        RpcError::Refused { should_retry, .. } => {
            if *should_retry {
                Disposition::Retry
            } else {
                Disposition::Fatal
            }
        }
        RpcError::OpenStream(_) | RpcError::Capnp(_) | RpcError::Timeout => Disposition::Rotate,
        // An uninterpretable response is what an edge protocol change looks like from here (risks
        // P4 and P5). Rotating would only find another edge speaking the same new protocol, so this
        // should surface rather than spin.
        RpcError::Malformed(_) => Disposition::Fatal,
    }
}

/// The error code a user should see when a connection gives up.
///
/// Codes, not prose — only `crates/cli` knows the user's language.
#[must_use]
pub fn code_for(error: &RpcError) -> ErrorCode {
    match error {
        RpcError::Refused { .. } => ErrorCode::EdgeRegistrationRefused,
        // The single most important mapping in this function. `EDGE_PROTOCOL_ERROR` is the one whose
        // documented action is "**Likely a Cloudflare protocol change.** Upgrade NPort" — and since
        // NPort now owns the connector, that is the failure with the largest blast radius in the
        // system (`docs/ARCHITECTURE.md` §5). Folding it into a generic connect failure would hide
        // exactly the signal `protocol-canary.yml` exists to catch.
        RpcError::Malformed(_) => ErrorCode::EdgeProtocolError,
        RpcError::OpenStream(_) | RpcError::Capnp(_) | RpcError::Timeout => {
            ErrorCode::EdgeConnectFailed
        }
    }
}

/// Consecutive-failure budget for one connection index.
#[derive(Debug, Clone, Copy, Default)]
pub struct RetryBudget {
    consecutive: u32,
}

impl RetryBudget {
    /// Records a failure and reports the attempt number, starting at 1.
    pub fn fail(&mut self) -> u32 {
        self.consecutive = self.consecutive.saturating_add(1);
        self.consecutive
    }

    /// Records a success. **Resets the count** — see [`MAX_RETRIES`].
    pub fn succeed(&mut self) {
        self.consecutive = 0;
    }

    /// Whether this index has run out.
    #[must_use]
    pub fn exhausted(&self) -> bool {
        self.consecutive >= MAX_RETRIES
    }

    #[must_use]
    pub fn attempts(&self) -> u32 {
        self.consecutive
    }
}

/// How long to wait before attempt `attempt` (1-based), given a jitter fraction in `0.0..=1.0`.
///
/// **Jitter is not optional here, and this is the difference from the spike.** One process with four
/// connections has nothing to de-synchronise against, so `examples/pool.rs` skipped it. A released
/// client does not have that luxury: an edge blip disconnects thousands of clients at once, and
/// without jitter every one of them retries on the same schedule and re-creates the outage. The
/// spike says so in a comment; this is that comment turned into code.
///
/// The fraction is a parameter rather than drawn here so the function stays pure and the tests stay
/// deterministic. The caller supplies randomness.
#[must_use]
pub fn backoff(attempt: u32, jitter_fraction: f64) -> Duration {
    // Doubling, capped. `attempt` is 1-based, so attempt 1 waits the base.
    let shift = attempt.saturating_sub(1).min(3);
    let scaled = RETRY_BASE.saturating_mul(1u32 << shift).min(RETRY_CAP);

    // Full jitter: a uniform draw across `0..=scaled`, rather than `scaled ± a bit`. Partial jitter
    // still leaves a peak; full jitter spreads the herd across the whole window, which is the point.
    let fraction = jitter_fraction.clamp(0.0, 1.0);
    scaled.mul_f64(fraction)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(cause: &str, should_retry: bool) -> RpcError {
        RpcError::Refused {
            cause: cause.to_owned(),
            should_retry,
            retry_after: None,
        }
    }

    #[test]
    fn duplicate_connection_rotates_rather_than_retrying() {
        // Retrying the same address on EDUPCONN loops forever: the edge is saying *this* address
        // already holds our index.
        assert_eq!(classify(&refused("EDUPCONN", true)), Disposition::Rotate);
    }

    #[test]
    fn an_unauthorized_tunnel_retries_the_same_address() {
        // A freshly created tunnel has not propagated. The same address starts working shortly, so
        // rotating would spread the confusion instead of waiting it out.
        assert_eq!(
            classify(&refused("Unauthorized: tunnel not found", false)),
            Disposition::Retry
        );
    }

    #[test]
    fn a_refusal_honours_the_edges_own_retry_advice() {
        assert_eq!(classify(&refused("busy", true)), Disposition::Retry);
        assert_eq!(classify(&refused("banned", false)), Disposition::Fatal);
    }

    #[test]
    fn a_timeout_rotates() {
        assert_eq!(classify(&RpcError::Timeout), Disposition::Rotate);
    }

    #[test]
    fn an_uninterpretable_response_is_fatal_and_maps_to_the_protocol_code() {
        // This is the edge changing the protocol under us — the largest blast radius in the system.
        // Rotating would only find another edge speaking the same new protocol, and reporting it as
        // a connect failure would hide the signal entirely.
        let error = RpcError::Malformed("unknown union tag".into());
        assert_eq!(classify(&error), Disposition::Fatal);
        assert_eq!(code_for(&error), ErrorCode::EdgeProtocolError);
    }

    #[test]
    fn a_success_resets_the_budget() {
        // Consecutive, not cumulative. A connection that flaps all day must never exhaust its
        // retries, or a bad network kills a healthy long-running tunnel.
        let mut budget = RetryBudget::default();
        for _ in 0..MAX_RETRIES - 1 {
            budget.fail();
        }
        assert!(!budget.exhausted());
        budget.succeed();
        assert_eq!(budget.attempts(), 0);
        assert!(!budget.exhausted());
    }

    #[test]
    fn the_budget_runs_out_after_the_documented_number_of_failures() {
        let mut budget = RetryBudget::default();
        for attempt in 1..=MAX_RETRIES {
            assert_eq!(budget.fail(), attempt);
        }
        assert!(budget.exhausted());
    }

    #[test]
    fn backoff_doubles_and_then_stops_at_the_cap() {
        // Jitter fixed at 1.0 to see the envelope. The cap exists so a long outage does not turn
        // into a 40-minute sleep that outlives the outage itself.
        assert_eq!(backoff(1, 1.0), RETRY_BASE);
        assert_eq!(backoff(2, 1.0), RETRY_BASE * 2);
        assert_eq!(backoff(3, 1.0), RETRY_BASE * 4);
        assert_eq!(backoff(9, 1.0), RETRY_CAP);
    }

    #[test]
    fn backoff_is_fully_jittered() {
        // Full jitter, not `scaled ± a bit`: an edge blip disconnects thousands of clients at once,
        // and a partial-jitter peak still re-creates the outage on retry. The spike skipped this
        // because one process has nothing to de-synchronise against; a released client does.
        assert_eq!(backoff(3, 0.0), Duration::ZERO);
        assert_eq!(backoff(3, 0.5), (RETRY_BASE * 4) / 2);
        assert!(backoff(3, 0.25) < backoff(3, 0.75));
    }

    #[test]
    fn a_jitter_fraction_outside_the_range_cannot_extend_the_wait() {
        // Defensive: a caller passing 5.0 must not sleep five times the cap.
        assert_eq!(backoff(9, 5.0), RETRY_CAP);
        assert_eq!(backoff(9, -1.0), Duration::ZERO);
    }
}
