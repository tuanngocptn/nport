//! Who starts, who waits, who gives up — the pool's decisions, with no I/O in sight.
//!
//! `docs/PROTOCOL.md` §4 fixes the shape: four HA connections, connection 0 must register before
//! 1..N-1 start, and the rest follow one per second. Everything after that is reacting to losses.
//!
//! **Pure on purpose.** Every rule here is a function of stored state and one observation, so the
//! whole policy is testable without a socket, a timer, or an edge. The task that owns sockets asks
//! this what to do and does it; it never encodes a rule itself. That split is what let the five
//! concurrency bugs in `apps/api` be *found* — a decision buried inside an I/O loop is one nobody can
//! test in isolation.

use std::time::Duration;

use nport_contract::ErrorCode;
use nport_protocol::rpc::RpcError;

use crate::event::{ConnectionIndex, ShutdownReason, TunnelEvent};
use crate::retry::{self, Disposition, RetryBudget};

/// Connections in the pool.
///
/// cloudflared: `supervisor/supervisor.go`. Four is upstream's default and the edge expects it; a
/// different number is not a tuning knob, it is a protocol deviation.
pub const CONNECTIONS: u8 = 4;

/// Gap between starting connection *n* and *n+1*, once 0 has registered.
///
/// cloudflared: `supervisor/supervisor.go` → `registrationInterval`.
pub const REGISTRATION_INTERVAL: Duration = Duration::from_secs(1);

/// What the I/O layer should do next for one connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Dial and register, after waiting.
    ///
    /// `rotate` says whether to move to a different edge address first — the difference between
    /// recovering and looping forever on an `EDUPCONN`.
    Connect { after: Duration, rotate: bool },
    /// Stop trying this index. The pool may still be serving on the others.
    GiveUp { code: ErrorCode },
    /// Nothing to do: this index is connected, or not started yet.
    Idle,
}

/// One connection's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Not started. Only connection 0 leaves this on its own; the rest wait for 0 to register.
    Waiting,
    Connecting,
    Registered,
    GaveUp,
}

/// The pool's decisions for one tunnel.
///
/// Holds no sockets and spawns nothing. The caller owns both.
#[derive(Debug)]
pub struct Supervisor {
    states: Vec<State>,
    budgets: Vec<RetryBudget>,
    /// Whether connection 0 has ever registered, which is what releases the rest (§4).
    lead_registered: bool,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new(CONNECTIONS)
    }
}

impl Supervisor {
    #[must_use]
    pub fn new(connections: u8) -> Self {
        let count = usize::from(connections);
        Self {
            states: vec![State::Waiting; count],
            budgets: vec![RetryBudget::default(); count],
            lead_registered: false,
        }
    }

    /// The indices that may start right now, and when.
    ///
    /// Only connection 0 until it registers. **This ordering is not politeness**: §4 says the edge
    /// expects the lead connection to establish the tunnel before its siblings appear, and starting
    /// all four at once is how a pool ends up with three refusals and one survivor.
    #[must_use]
    pub fn start_plan(&self) -> Vec<(ConnectionIndex, Duration)> {
        if !self.lead_registered {
            return match self.states.first() {
                Some(State::Waiting) => vec![(0, Duration::ZERO)],
                _ => Vec::new(),
            };
        }
        self.states
            .iter()
            .enumerate()
            .skip(1)
            .filter(|(_, state)| **state == State::Waiting)
            .map(|(index, _)| {
                // Staggered, not simultaneous: one per second after the lead.
                #[allow(clippy::cast_possible_truncation)]
                let index = index as ConnectionIndex;
                (index, REGISTRATION_INTERVAL * u32::from(index))
            })
            .collect()
    }

    /// Records that an index is dialling.
    pub fn connecting(&mut self, index: ConnectionIndex) {
        if let Some(state) = self.states.get_mut(usize::from(index)) {
            if *state != State::GaveUp {
                *state = State::Connecting;
            }
        }
    }

    /// Records a successful registration. Resets that index's retry budget.
    pub fn registered(&mut self, index: ConnectionIndex, colo: String) -> Vec<TunnelEvent> {
        let Some(state) = self.states.get_mut(usize::from(index)) else {
            return Vec::new();
        };
        *state = State::Registered;
        if let Some(budget) = self.budgets.get_mut(usize::from(index)) {
            budget.succeed();
        }
        if index == 0 {
            self.lead_registered = true;
        }
        vec![TunnelEvent::ConnectionUp { index, colo }]
    }

    /// Records a connection that dropped after having been registered.
    ///
    /// **Not a failure**, and it does not touch the retry budget: the edge recycles connections as a
    /// matter of course, and a healthy long-running tunnel does this all day. Counting it would
    /// exhaust the budget of the connections that work hardest.
    pub fn lost(&mut self, index: ConnectionIndex) -> (Vec<TunnelEvent>, Action) {
        if self.states.get(usize::from(index)) == Some(&State::GaveUp) {
            return (Vec::new(), Action::Idle);
        }
        if let Some(state) = self.states.get_mut(usize::from(index)) {
            *state = State::Connecting;
        }
        (
            vec![TunnelEvent::ConnectionLost { index }],
            // Immediately, and without rotating. The address was working a moment ago, and the pool
            // is down a connection until this returns — a backoff here costs capacity for nothing.
            Action::Connect {
                after: Duration::ZERO,
                rotate: false,
            },
        )
    }

    /// Records a failed dial or registration, and decides what happens next.
    ///
    /// `jitter` is the caller's random fraction in `0.0..=1.0`; see [`retry::backoff`].
    pub fn failed(
        &mut self,
        index: ConnectionIndex,
        error: &RpcError,
        jitter: f64,
    ) -> (Vec<TunnelEvent>, Action) {
        let slot = usize::from(index);
        if self.states.get(slot) == Some(&State::GaveUp) {
            return (Vec::new(), Action::Idle);
        }

        let disposition = retry::classify(error);
        let code = retry::code_for(error);

        if disposition == Disposition::Fatal {
            // Nothing a retry can fix. `EDGE_PROTOCOL_ERROR` arrives here, and spinning on it would
            // bury the one signal that says Cloudflare changed the protocol.
            if let Some(state) = self.states.get_mut(slot) {
                *state = State::GaveUp;
            }
            return (
                vec![TunnelEvent::ConnectionGaveUp { index, code }],
                Action::GiveUp { code },
            );
        }

        let Some(budget) = self.budgets.get_mut(slot) else {
            return (Vec::new(), Action::Idle);
        };
        let attempt = budget.fail();
        if budget.exhausted() {
            if let Some(state) = self.states.get_mut(slot) {
                *state = State::GaveUp;
            }
            return (
                vec![TunnelEvent::ConnectionGaveUp { index, code }],
                Action::GiveUp { code },
            );
        }

        let after = retry::backoff(attempt, jitter);
        (
            vec![TunnelEvent::ConnectionRetrying {
                index,
                attempt,
                delay: after,
            }],
            Action::Connect {
                after,
                rotate: disposition == Disposition::Rotate,
            },
        )
    }

    /// How many connections are currently carrying traffic.
    #[must_use]
    pub fn healthy(&self) -> usize {
        self.states
            .iter()
            .filter(|state| **state == State::Registered)
            .count()
    }

    /// Whether every connection has given up, which is the only genuinely bad ending.
    #[must_use]
    pub fn exhausted(&self) -> bool {
        self.states.iter().all(|state| *state == State::GaveUp)
    }

    /// The shutdown reason if the pool can no longer serve, or `None` while any connection remains.
    #[must_use]
    pub fn terminal_reason(&self) -> Option<ShutdownReason> {
        self.exhausted()
            .then_some(ShutdownReason::ConnectionsExhausted)
    }
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

    fn transient() -> RpcError {
        refused("busy", true)
    }

    #[test]
    fn only_the_lead_connection_starts_first() {
        // §4: the edge expects connection 0 to establish the tunnel before its siblings appear.
        // Starting all four at once is how a pool ends up with three refusals and one survivor.
        let supervisor = Supervisor::default();
        assert_eq!(supervisor.start_plan(), vec![(0, Duration::ZERO)]);
    }

    #[test]
    fn the_rest_start_staggered_once_the_lead_registers() {
        let mut supervisor = Supervisor::default();
        supervisor.connecting(0);
        supervisor.registered(0, "hkg09".to_owned());

        assert_eq!(
            supervisor.start_plan(),
            vec![
                (1, REGISTRATION_INTERVAL),
                (2, REGISTRATION_INTERVAL * 2),
                (3, REGISTRATION_INTERVAL * 3),
            ]
        );
    }

    #[test]
    fn a_lost_connection_reconnects_immediately_and_does_not_rotate() {
        // The address was working a moment ago, and the pool is down a connection until this
        // returns. Backing off here would cost capacity to solve a problem that may not exist.
        let mut supervisor = Supervisor::default();
        supervisor.registered(0, "hkg09".to_owned());

        let (events, action) = supervisor.lost(0);
        assert_eq!(events, vec![TunnelEvent::ConnectionLost { index: 0 }]);
        assert_eq!(
            action,
            Action::Connect {
                after: Duration::ZERO,
                rotate: false
            }
        );
    }

    #[test]
    fn a_loss_does_not_spend_the_retry_budget() {
        // The edge recycles connections as a matter of course. Counting those would exhaust the
        // budget of exactly the connections that work hardest.
        let mut supervisor = Supervisor::default();
        supervisor.registered(0, "hkg09".to_owned());
        for _ in 0..20 {
            supervisor.lost(0);
            supervisor.registered(0, "hkg09".to_owned());
        }
        assert!(!supervisor.exhausted());
        assert_eq!(supervisor.healthy(), 1);
    }

    #[test]
    fn a_duplicate_connection_error_rotates() {
        let mut supervisor = Supervisor::default();
        let (_, action) = supervisor.failed(1, &refused("EDUPCONN", true), 1.0);
        match action {
            Action::Connect { rotate, .. } => assert!(rotate, "EDUPCONN must rotate or it loops"),
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn a_propagating_tunnel_retries_the_same_address() {
        let mut supervisor = Supervisor::default();
        let (_, action) = supervisor.failed(1, &refused("Unauthorized", false), 1.0);
        match action {
            Action::Connect { rotate, .. } => assert!(!rotate),
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn an_unreadable_response_gives_up_at_once_rather_than_spinning() {
        // `EDGE_PROTOCOL_ERROR` is the signal that Cloudflare changed the protocol — the failure
        // with the largest blast radius in the system. Retrying it would bury the one thing worth
        // paging about.
        let mut supervisor = Supervisor::default();
        let (events, action) = supervisor.failed(2, &RpcError::Malformed("bad tag".into()), 1.0);

        assert_eq!(
            action,
            Action::GiveUp {
                code: ErrorCode::EdgeProtocolError
            }
        );
        assert_eq!(
            events,
            vec![TunnelEvent::ConnectionGaveUp {
                index: 2,
                code: ErrorCode::EdgeProtocolError
            }]
        );
    }

    #[test]
    fn retries_back_off_and_then_give_up() {
        let mut supervisor = Supervisor::default();
        let mut delays = Vec::new();

        loop {
            let (_, action) = supervisor.failed(0, &transient(), 1.0);
            match action {
                Action::Connect { after, .. } => delays.push(after),
                Action::GiveUp { .. } => break,
                Action::Idle => panic!("a failure must never be idle"),
            }
        }

        // Increasing, and it stopped rather than retrying forever.
        assert!(delays.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(delays.len() as u32, retry::MAX_RETRIES - 1);
    }

    #[test]
    fn one_dead_connection_does_not_end_the_tunnel() {
        // Three of four is a degraded tunnel, not a stopped one. Ending here would turn a routine
        // edge problem into an outage for the user.
        let mut supervisor = Supervisor::default();
        supervisor.registered(0, "hkg09".to_owned());
        supervisor.registered(1, "hkg09".to_owned());
        supervisor.registered(2, "hkg09".to_owned());
        supervisor.failed(3, &RpcError::Malformed("bad".into()), 1.0);

        assert_eq!(supervisor.healthy(), 3);
        assert!(!supervisor.exhausted());
        assert_eq!(supervisor.terminal_reason(), None);
    }

    #[test]
    fn losing_every_connection_is_the_one_terminal_state() {
        let mut supervisor = Supervisor::default();
        for index in 0..CONNECTIONS {
            supervisor.failed(index, &RpcError::Malformed("bad".into()), 1.0);
        }
        assert!(supervisor.exhausted());
        assert_eq!(
            supervisor.terminal_reason(),
            Some(ShutdownReason::ConnectionsExhausted)
        );
    }

    #[test]
    fn a_connection_that_gave_up_stays_given_up() {
        // At-least-once delivery and racing tasks mean a late event can arrive for a dead index.
        // Resurrecting it would restart a connection nobody is supervising.
        let mut supervisor = Supervisor::default();
        supervisor.failed(1, &RpcError::Malformed("bad".into()), 1.0);

        assert_eq!(supervisor.lost(1), (Vec::new(), Action::Idle));
        assert_eq!(supervisor.failed(1, &transient(), 1.0).1, Action::Idle);
        supervisor.connecting(1);
        assert_eq!(supervisor.healthy(), 0);
    }
}
