//! `TunnelEvent` on its way to the WebView.
//!
//! `crates/core` is headless (invariant 5): it emits [`TunnelEvent`] and says nothing about how any
//! of it looks. This module is the desktop half of that arrangement — the CLI's half is
//! `crates/cli/src/render.rs`, which turns the same events into terminal lines.
//!
//! ## Why a separate type rather than serializing `TunnelEvent`
//!
//! Three reasons, and the third is the one that decides it.
//!
//! `TunnelEvent` does not derive `Serialize`, and adding it there would put a wire format in a crate
//! whose whole point is having no opinion about consumers. It carries a [`Duration`], which JSON has
//! no representation for. And it is `#[non_exhaustive]`, which means a `match` here needs a wildcard
//! arm and **a variant added upstream would silently forward as nothing** — the exact failure
//! `crates/CLAUDE.md` warns about for the CLI's `_ => Vec::new()`.
//!
//! A separate type does not fix that by itself; the test at the bottom does, by asserting every
//! variant this app knows about maps to a distinct payload. What the separate type buys is that the
//! *shape the frontend sees* is decided here, in one file, rather than falling out of whatever
//! `core`'s enum happens to look like — which is what `src/generated/bindings.ts` will be generated
//! from in the rest of Phase 4.
//!
//! ## What is deliberately not here
//!
//! No token, no `ownerToken`, no raw address. `TunnelEvent` carries none — its own docblock says an
//! event stream is the wrong place for a credential — so rule 6 costs nothing to honour and this
//! module never has to redact. If a variant ever arrives carrying one, it stops here.

use std::time::Duration;

use nport_contract::ErrorCode;
use nport_core::event::{ShutdownReason, TunnelEvent};
use serde::Serialize;

/// The Tauri event name the frontend listens on.
///
/// One channel for every tunnel event, discriminated by `type` in the payload, rather than an event
/// name per variant. A listener per variant means seven subscriptions that can drift out of sync,
/// and ordering between separate Tauri channels is not something to rely on — `ConnectionUp`
/// arriving before `Provisioned` would render a tunnel that is up before it exists.
pub const TUNNEL_EVENT: &str = "nport://tunnel";

/// A [`TunnelEvent`] in the shape the WebView receives.
///
/// `type` is the discriminator and fields are camelCase, because this is read by TypeScript. Both
/// are spelled out per variant rather than set once on the enum: `rename_all_fields` is a newer
/// serde attribute than the floor this workspace pins, and a per-variant `rename_all` says the same
/// thing in a way that cannot depend on the version resolving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UiEvent {
    /// The URL is live. The frontend shows it from here and nowhere else.
    #[serde(rename_all = "camelCase")]
    Provisioned {
        url: String,
        subdomain: String,
        /// Epoch milliseconds, server-authoritative. Displayed, never enforced (invariant 3).
        expires_at: i64,
    },

    #[serde(rename_all = "camelCase")]
    ConnectionUp { index: u8, colo: String },

    #[serde(rename_all = "camelCase")]
    ConnectionLost { index: u8 },

    /// Carries the delay as **milliseconds**, because JSON has no duration and a UI counting down
    /// needs a number it can subtract from rather than a formatted string.
    #[serde(rename_all = "camelCase")]
    ConnectionRetrying {
        index: u8,
        attempt: u32,
        delay_ms: u64,
    },

    /// The code travels as its registry spelling — `EDGE_CONNECT_FAILED`, not a sentence.
    ///
    /// `ErrorCode` serializes to exactly that string, so the frontend can key its own translations
    /// and deep-link to `nport.link/errors/<slug>` without this file knowing a word of English.
    /// Turning a code into prose is `crates/cli`'s job because only it knows the user's language;
    /// the WebView is the same case and will do the same thing with its own catalogue.
    #[serde(rename_all = "camelCase")]
    ConnectionGaveUp { index: u8, code: ErrorCode },

    #[serde(rename_all = "camelCase")]
    ShuttingDown { reason: UiShutdownReason },

    /// Always last; the stream ends after it. `drained: false` means in-flight requests were cut.
    #[serde(rename_all = "camelCase")]
    Stopped { drained: bool },
}

/// Why a tunnel stopped, as the WebView sees it.
///
/// Mirrored rather than reused for the same reason as [`UiEvent`]: `ShutdownReason` is
/// `#[non_exhaustive]` and not `Serialize`. **None of these is a failure** — even `leaseExpired` is
/// the system working as designed, and a UI that painted it red would be lying about a four-hour
/// limit the user was told about up front.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UiShutdownReason {
    /// The user asked — a stop button, or the app quitting.
    Requested,
    /// The server-owned lease reached its end.
    LeaseExpired,
    /// Every connection gave up. The one genuinely bad ending.
    ConnectionsExhausted,
}

impl UiEvent {
    /// Translates a core event, or `None` for a variant this build does not know.
    ///
    /// **`None` is the honest answer to a variant added upstream**, and the reason this returns an
    /// `Option` rather than a `UiEvent::Unknown`: a payload the frontend cannot match on is noise it
    /// would have to filter anyway, and inventing a placeholder makes a missing feature look like a
    /// delivered one. `every_variant_this_build_knows_translates` below is what stops that `None`
    /// from being reached by a variant that *should* have been handled.
    #[must_use]
    pub fn from_core(event: &TunnelEvent) -> Option<Self> {
        Some(match event {
            TunnelEvent::Provisioned {
                url,
                subdomain,
                expires_at,
            } => Self::Provisioned {
                url: url.clone(),
                subdomain: subdomain.clone(),
                expires_at: *expires_at,
            },
            TunnelEvent::ConnectionUp { index, colo } => Self::ConnectionUp {
                index: *index,
                colo: colo.clone(),
            },
            TunnelEvent::ConnectionLost { index } => Self::ConnectionLost { index: *index },
            TunnelEvent::ConnectionRetrying {
                index,
                attempt,
                delay,
            } => Self::ConnectionRetrying {
                index: *index,
                attempt: *attempt,
                delay_ms: duration_ms(*delay),
            },
            TunnelEvent::ConnectionGaveUp { index, code } => Self::ConnectionGaveUp {
                index: *index,
                code: *code,
            },
            TunnelEvent::ShuttingDown { reason } => Self::ShuttingDown {
                reason: UiShutdownReason::from_core(*reason)?,
            },
            TunnelEvent::Stopped { drained } => Self::Stopped { drained: *drained },
            // `TunnelEvent` is `#[non_exhaustive]`; this arm is required and is the one place a new
            // variant lands. The test below fails when that happens for a variant we do know.
            _ => return None,
        })
    }
}

impl UiShutdownReason {
    /// `None` for a reason this build does not know — see [`UiEvent::from_core`].
    #[must_use]
    fn from_core(reason: ShutdownReason) -> Option<Self> {
        Some(match reason {
            ShutdownReason::Requested => Self::Requested,
            ShutdownReason::LeaseExpired => Self::LeaseExpired,
            ShutdownReason::ConnectionsExhausted => Self::ConnectionsExhausted,
            _ => return None,
        })
    }
}

/// Milliseconds, saturating rather than wrapping.
///
/// `Duration::as_millis` is `u128` and every retry delay in `core` is seconds, so the clamp is
/// unreachable in practice. It is here because the alternative is `as u64`, which is a silent wrap
/// on a value that arrives from a backoff calculation — and a countdown that renders a delay of
/// four milliseconds when the real one is fifty days is worse than one that renders the clamp.
fn duration_ms(delay: Duration) -> u64 {
    u64::try_from(delay.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant this build knows translates to a payload, and the payloads are distinct.
    ///
    /// **This is the substitute for a compiler error.** `TunnelEvent` is `#[non_exhaustive]`, so
    /// `from_core`'s wildcard arm means a variant added in `crates/core` compiles here and forwards
    /// as nothing — the desktop equivalent of the CLI's `_ => Vec::new()`. `crates/core/src/event.rs`
    /// carries a match that stops compiling when the enum grows and names the three consumers to
    /// update; this test is what that instruction points at for this one.
    ///
    /// Distinctness matters as much as totality: two variants mapping to the same payload is a
    /// copy-paste in the arm above, and it renders as the wrong thing rather than as nothing, which
    /// is harder to notice.
    #[test]
    fn every_variant_this_build_knows_translates() {
        let events = [
            TunnelEvent::Provisioned {
                url: "https://a.nport.link".to_owned(),
                subdomain: "a".to_owned(),
                expires_at: 1,
            },
            TunnelEvent::ConnectionUp {
                index: 0,
                colo: "hkg09".to_owned(),
            },
            TunnelEvent::ConnectionLost { index: 1 },
            TunnelEvent::ConnectionRetrying {
                index: 2,
                attempt: 3,
                delay: Duration::from_secs(4),
            },
            TunnelEvent::ConnectionGaveUp {
                index: 3,
                code: ErrorCode::EdgeConnectFailed,
            },
            TunnelEvent::ShuttingDown {
                reason: ShutdownReason::Requested,
            },
            TunnelEvent::Stopped { drained: true },
        ];

        let payloads: Vec<String> = events
            .iter()
            .map(|event| {
                let ui = UiEvent::from_core(event).unwrap_or_else(|| {
                    panic!("no UiEvent for {event:?} — forward it in from_core")
                });
                serde_json::to_string(&ui).expect("serialize")
            })
            .collect();

        let mut unique = payloads.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), payloads.len(), "two variants share a payload");
    }

    /// The wire shape the frontend is written against, pinned.
    ///
    /// Asserted as whole JSON rather than field by field because the discriminator, the key casing
    /// and the unit-variant spelling are all part of the contract, and each has its own way of going
    /// wrong silently — a `rename_all` dropped from one variant is invisible in a field-by-field
    /// test that only checks the fields it remembers.
    #[test]
    fn the_payload_is_camel_case_and_tagged() {
        let provisioned = UiEvent::from_core(&TunnelEvent::Provisioned {
            url: "https://myapp.nport.link".to_owned(),
            subdomain: "myapp".to_owned(),
            expires_at: 1_786_000_000_000,
        })
        .expect("known variant");

        assert_eq!(
            serde_json::to_string(&provisioned).expect("serialize"),
            r#"{"type":"provisioned","url":"https://myapp.nport.link","subdomain":"myapp","expiresAt":1786000000000}"#
        );

        let retrying = UiEvent::from_core(&TunnelEvent::ConnectionRetrying {
            index: 2,
            attempt: 3,
            delay: Duration::from_millis(1500),
        })
        .expect("known variant");

        assert_eq!(
            serde_json::to_string(&retrying).expect("serialize"),
            r#"{"type":"connectionRetrying","index":2,"attempt":3,"delayMs":1500}"#
        );
    }

    /// The code reaches the frontend as its registry spelling, not as a Rust variant name.
    ///
    /// `EdgeConnectFailed` would be useless to a UI keying translations or building an
    /// `nport.link/errors/<slug>` link, and it is exactly what a hand-written `format!("{code:?}")`
    /// would have produced.
    #[test]
    fn an_error_code_travels_as_its_registry_name() {
        let gave_up = UiEvent::from_core(&TunnelEvent::ConnectionGaveUp {
            index: 0,
            code: ErrorCode::EdgeRegistrationRefused,
        })
        .expect("known variant");

        let json = serde_json::to_string(&gave_up).expect("serialize");
        assert!(
            json.contains(r#""code":"EDGE_REGISTRATION_REFUSED""#),
            "{json}"
        );
    }

    /// Every shutdown reason translates, for the same reason the events do.
    #[test]
    fn every_shutdown_reason_this_build_knows_translates() {
        for reason in [
            ShutdownReason::Requested,
            ShutdownReason::LeaseExpired,
            ShutdownReason::ConnectionsExhausted,
        ] {
            assert!(
                UiShutdownReason::from_core(reason).is_some(),
                "no UiShutdownReason for {reason:?}"
            );
        }
    }

    /// A delay too large for `u64` milliseconds clamps instead of wrapping.
    #[test]
    fn an_absurd_retry_delay_clamps_rather_than_wrapping() {
        assert_eq!(duration_ms(Duration::from_millis(1500)), 1500);
        assert_eq!(duration_ms(Duration::MAX), u64::MAX);
    }
}
