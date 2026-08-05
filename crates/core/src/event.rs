//! What `crates/core` says, since it is not allowed to say anything else.
//!
//! Invariant 5: this crate is headless. No `println!`, no `eprintln!`, no progress bars, no
//! `process::exit`. Everything a user could possibly want to know leaves through this enum, and
//! `crates/cli` and `apps/desktop` decide what to do with it.
//!
//! The reason is concrete rather than stylistic. A stray `println!` here corrupts the desktop app's
//! IPC channel, and a `process::exit` from a library makes the GUI vanish with no dialog. v2 built
//! chalk-coloured English help text inside `Error.message` in its transport layer, which bypassed
//! i18n entirely and could never be rendered any other way (defect R20).
//!
//! ## Events carry codes, never prose
//!
//! Every failure variant carries an [`ErrorCode`] from the frozen registry, not a message. Only
//! `crates/cli` knows the user's language, so only `crates/cli` may turn a code into words
//! (`crates/CLAUDE.md` rule 3). A variant that carried a `String` for display would put English in
//! the wrong crate and be untranslatable by construction.
//!
//! ## Adding a variant
//!
//! Add it here, render it in `crates/cli`, and forward it in `apps/desktop`. All three, or it goes
//! nowhere — the CLI silently drops what it does not match.

use std::time::Duration;

use nport_contract::ErrorCode;

/// Which of the four HA connections an event is about.
///
/// `docs/PROTOCOL.md` §4: connection 0 must register before 1..N-1 start, and the index is also what
/// the address pool rotates and what upstream reuses a source port for. It is meaningful to a user
/// only as "3 of 4 healthy", which is exactly how the CLI renders it.
pub type ConnectionIndex = u8;

/// Everything `crates/core` can tell a consumer.
///
/// `#[non_exhaustive]` so adding a variant is not a breaking change for `apps/desktop`, which
/// matches it in a different repository cadence.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TunnelEvent {
    /// The lease exists and the public URL is live. Carries no token: the connector holds those, and
    /// an event stream is the wrong place for a credential — the desktop app forwards these to a
    /// WebView.
    Provisioned {
        url: String,
        subdomain: String,
        /// Server-authoritative expiry, epoch milliseconds. The client displays it and never
        /// enforces it (defect R6).
        expires_at: i64,
    },

    /// A connection registered and is carrying traffic.
    ConnectionUp {
        index: ConnectionIndex,
        /// The Cloudflare colo that answered, e.g. `hkg09`. Useful in a bug report and nowhere else.
        colo: String,
    },

    /// A connection dropped. Expected during normal operation — the edge recycles connections — so
    /// this is not on its own an error.
    ConnectionLost { index: ConnectionIndex },

    /// A connection is waiting before its next attempt.
    ///
    /// Carries the delay so a UI can count down rather than guess, and the attempt number so it can
    /// distinguish one blip from a persistent outage.
    ConnectionRetrying {
        index: ConnectionIndex,
        attempt: u32,
        delay: Duration,
    },

    /// A connection exhausted its retries, or failed in a way retrying cannot fix.
    ///
    /// The tunnel may still be serving on its other connections; [`TunnelEvent::Stopped`] is what
    /// says it is over.
    ConnectionGaveUp {
        index: ConnectionIndex,
        code: ErrorCode,
    },

    /// The tunnel is shutting down, and why.
    ///
    /// Emitted before the drain, so a UI can stop showing the URL as usable while in-flight requests
    /// finish.
    ShuttingDown { reason: ShutdownReason },

    /// The tunnel is fully torn down. Always the last event; the stream ends after it.
    ///
    /// `drained` says whether in-flight requests finished within the grace period. `false` means the
    /// connections were cut with work still on them — `docs/PROTOCOL.md` §12's drain did not complete,
    /// and the CLI should report `SHUTDOWN_TIMEOUT`. Carried rather than assumed, because a shutdown
    /// that silently dropped requests looks identical to a clean one from outside.
    Stopped { drained: bool },
}

/// Why a tunnel is stopping.
///
/// Distinct from an error code because none of these is a failure — even `LeaseExpired` is the
/// system working as designed, and a CLI should say "your four hours are up", not "error".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ShutdownReason {
    /// The user asked: Ctrl+C, or a desktop stop button.
    Requested,
    /// The server-owned lease reached its end. Not a failure (defect R6).
    LeaseExpired,
    /// Every connection gave up. The one genuinely bad ending.
    ConnectionsExhausted,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fails to **compile** when a variant is added, which is the only place that can happen.
    ///
    /// `TunnelEvent` is `#[non_exhaustive]`, so `crates/cli` and `apps/desktop` must carry a wildcard
    /// arm and the compiler cannot tell them a new variant exists — the CLI's is `_ => Vec::new()`, so
    /// an unhandled variant renders as nothing at all. `crates/CLAUDE.md` states the rule ("all three,
    /// or it goes nowhere") and prose is all that enforced it. Inside the defining crate the attribute
    /// does not apply, so this match is exhaustive for real.
    ///
    /// When this stops compiling: add the variant here, render it in `crates/cli/src/render.rs`, add it
    /// to that file's `renders_something_for_every_variant` list, and forward it in `apps/desktop`
    /// once Phase 4 exists.
    #[test]
    fn every_variant_is_accounted_for_by_the_consumers() {
        fn assert_handled(event: &TunnelEvent) {
            match event {
                TunnelEvent::Provisioned { .. }
                | TunnelEvent::ConnectionUp { .. }
                | TunnelEvent::ConnectionLost { .. }
                | TunnelEvent::ConnectionRetrying { .. }
                | TunnelEvent::ConnectionGaveUp { .. }
                | TunnelEvent::ShuttingDown { .. }
                | TunnelEvent::Stopped { .. } => {}
            }
        }

        assert_handled(&TunnelEvent::Stopped { drained: true });
    }

    /// The same guard for [`ShutdownReason`], which the CLI maps to a sentence per variant.
    #[test]
    fn every_shutdown_reason_is_accounted_for() {
        fn assert_handled(reason: ShutdownReason) {
            match reason {
                ShutdownReason::Requested
                | ShutdownReason::LeaseExpired
                | ShutdownReason::ConnectionsExhausted => {}
            }
        }

        assert_handled(ShutdownReason::Requested);
    }

    #[test]
    fn a_failure_event_carries_a_code_and_no_prose() {
        // The property that keeps English out of this crate. If a variant ever grows a `message:
        // String`, translation becomes impossible for every consumer at once (defect R20).
        let event = TunnelEvent::ConnectionGaveUp {
            index: 2,
            code: ErrorCode::EdgeRegistrationRefused,
        };
        match event {
            TunnelEvent::ConnectionGaveUp { code, .. } => {
                assert_eq!(code, ErrorCode::EdgeRegistrationRefused);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn provisioned_carries_no_credential() {
        // Deliberately asserted rather than assumed: the desktop app forwards this stream into a
        // WebView, so a token here would cross a boundary it must never cross.
        let event = TunnelEvent::Provisioned {
            url: "https://myapp.nport.link".to_owned(),
            subdomain: "myapp".to_owned(),
            expires_at: 1_785_000_000_000,
        };
        let rendered = format!("{event:?}").to_lowercase();
        assert!(!rendered.contains("token"));
        assert!(!rendered.contains("secret"));
    }

    #[test]
    fn expiry_is_not_reported_as_a_failure() {
        // A four-hour limit reached is the system working. v2's CLI enforced this itself with a
        // `setTimeout`, so it could not tell the difference (defect R6).
        assert_ne!(
            ShutdownReason::LeaseExpired,
            ShutdownReason::ConnectionsExhausted
        );
    }
}
