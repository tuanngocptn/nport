//! Turning events into lines.
//!
//! Every sentence the user reads is decided here or in [`crate::i18n`]. `crates/core` sends codes
//! and facts; this file is where they become words, and it is the only place that knows the
//! difference between a terminal and a WebView.
//!
//! **No colour, no spinner, no cursor games.** The output has to be identical in a terminal, in CI,
//! in Docker, and through a pipe (ADR-0019), and anything that redraws a line is unreadable in the
//! last three. A tunnel that logs cleanly into a file is worth more than one that animates.

use std::fmt::Write as _;

use nport_contract::ErrorCode;
use nport_core::event::{ShutdownReason, TunnelEvent};

use crate::i18n::{Lang, Message, describe, text};

/// How much the CLI says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verbosity {
    /// Everything: the URL, then each connection as it comes and goes.
    Normal,
    /// The URL on stdout and nothing else, for `$(nport 3000 --quiet)`.
    Quiet,
}

/// Renders the CLI's output.
#[derive(Debug, Clone, Copy)]
pub struct Renderer {
    lang: Lang,
    verbosity: Verbosity,
}

/// Where a rendered line belongs.
///
/// The URL goes to **stdout** and everything else to **stderr**, so `nport 3000 --quiet` can be
/// captured in a shell substitution while progress and failures still reach the user's screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

impl Renderer {
    #[must_use]
    pub fn new(lang: Lang, verbosity: Verbosity) -> Self {
        Self { lang, verbosity }
    }

    /// The lines for an event, each with the stream it belongs on. Empty when nothing is shown.
    ///
    /// Returning the text rather than printing it is what makes every case below testable without a
    /// terminal — and the reason this file has tests at all.
    ///
    /// **A list rather than one line, because `Provisioned` spans both streams.** It used to return a
    /// single stdout string holding the URL *and* three lines of banner, which quietly broke the one
    /// promise [`Stream`] documents: `URL=$(nport 3000)` came back with four lines in it. The URL is
    /// data and the banner is chatter, and they belong on different file descriptors.
    #[must_use]
    pub fn event(&self, event: &TunnelEvent, port: u16) -> Vec<(Stream, String)> {
        match event {
            TunnelEvent::Provisioned { url, .. } if self.verbosity == Verbosity::Quiet => {
                vec![(Stream::Stdout, url.clone())]
            }
            TunnelEvent::Provisioned {
                url, expires_at, ..
            } => {
                // The URL alone on stdout, so a shell substitution works **without** `--quiet` — and
                // `--quiet` goes back to meaning "spare me the banner" rather than being the only way
                // to script this.
                let mut banner = String::new();
                let _ = write!(
                    banner,
                    "  {} http://localhost:{port}",
                    text(self.lang, Message::Forwarding)
                );
                let _ = write!(
                    banner,
                    "\n  {} {}",
                    text(self.lang, Message::Expires),
                    local_time(*expires_at)
                );
                let _ = write!(banner, "\n  {}", text(self.lang, Message::StopHint));
                vec![(Stream::Stdout, url.clone()), (Stream::Stderr, banner)]
            }

            _ if self.verbosity == Verbosity::Quiet => Vec::new(),

            TunnelEvent::ConnectionUp { index, colo } => vec![(
                Stream::Stderr,
                format!(
                    "{} {index} ({colo})",
                    text(self.lang, Message::ConnectionUp)
                ),
            )],
            TunnelEvent::ConnectionLost { index } => vec![(
                Stream::Stderr,
                format!("{} {index}", text(self.lang, Message::ConnectionLost)),
            )],
            TunnelEvent::ConnectionRetrying {
                index,
                attempt,
                delay,
            } => vec![(
                Stream::Stderr,
                format!(
                    "{} {index} ({attempt}) — {}s",
                    text(self.lang, Message::Retrying),
                    delay.as_secs()
                ),
            )],
            TunnelEvent::ConnectionGaveUp { index, code } => {
                vec![(Stream::Stderr, format!("{index}: {}", self.error(*code)))]
            }
            TunnelEvent::ShuttingDown { reason } => vec![(
                Stream::Stderr,
                match reason {
                    // Not a failure: the four hours are up, and saying "error" would be wrong
                    // (defect R6).
                    ShutdownReason::LeaseExpired => text(self.lang, Message::LeaseEnded).to_owned(),
                    ShutdownReason::ConnectionsExhausted => self.error(ErrorCode::TunnelLost),
                    ShutdownReason::Requested => text(self.lang, Message::ShuttingDown).to_owned(),
                    // `ShutdownReason` is `#[non_exhaustive]` so `apps/desktop` can lag a release.
                    // A reason this build has never heard of still gets a line rather than silence:
                    // a tunnel that stops with no explanation is the worst possible ending.
                    _ => text(self.lang, Message::ShuttingDown).to_owned(),
                },
            )],
            TunnelEvent::Stopped { drained } => vec![(
                Stream::Stderr,
                if *drained {
                    text(self.lang, Message::Stopped).to_owned()
                } else {
                    // The grace period ran out with requests still in flight. Saying so is the whole
                    // reason `drained` is on the event.
                    format!(
                        "{} — {}",
                        text(self.lang, Message::Stopped),
                        self.error(ErrorCode::ShutdownTimeout)
                    )
                },
            )],
            // `TunnelEvent` is `#[non_exhaustive]`; an event this build does not render is silence
            // here and a compile error nowhere, which is why `crates/CLAUDE.md` says to add the arm
            // in both consumers.
            _ => Vec::new(),
        }
    }

    /// A plain message, in the user's language.
    #[must_use]
    pub fn say(&self, message: Message) -> &'static str {
        text(self.lang, message)
    }

    /// A user-facing line for an error code.
    ///
    /// An untranslated code renders as the code itself plus its documentation URL. That is a worse
    /// line than a sentence and a much better one than a guess: the page behind the URL is generated
    /// from the same registry, so it is current in a way a stale hand-written translation is not.
    #[must_use]
    pub fn error(&self, code: ErrorCode) -> String {
        match describe(self.lang, code) {
            Some(sentence) => format!("{sentence} [{code}]"),
            None => format!(
                "[{code}] — {}: https://nport.link/errors/{}",
                text(self.lang, Message::SeeMore),
                code.slug()
            ),
        }
    }
}

/// Formats an epoch-millisecond expiry as something a person can read.
///
/// Deliberately crude — `HH:MM` in UTC, with no date library. A timezone database is a large
/// dependency and a large surprise in a static binary, and the number this renders is
/// **server-authoritative and advisory** (invariant 3): nothing depends on it being precise, because
/// nothing here enforces it.
fn local_time(expires_at: i64) -> String {
    if expires_at <= 0 {
        return "—".to_owned();
    }
    let seconds = expires_at / 1000;
    let minutes = seconds / 60;
    format!("{:02}:{:02} UTC", (minutes / 60) % 24, minutes % 60)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn renderer(verbosity: Verbosity) -> Renderer {
        Renderer::new(Lang::En, verbosity)
    }

    fn provisioned() -> TunnelEvent {
        TunnelEvent::Provisioned {
            url: "https://myapp.nport.link".to_owned(),
            subdomain: "myapp".to_owned(),
            expires_at: 1_785_000_000_000,
        }
    }

    /// Everything the renderer would put on one stream, joined as the terminal would show it.
    fn on(renderer: &Renderer, event: &TunnelEvent, stream: Stream) -> String {
        renderer
            .event(event, 3000)
            .into_iter()
            .filter(|(where_it_goes, _)| *where_it_goes == stream)
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Every variant must produce output in `Normal`, because the fallthrough is silent.
    ///
    /// `event`'s last arm is `_ => Vec::new()`, which `#[non_exhaustive]` on `TunnelEvent` forces —
    /// so a variant added in `crates/core` compiles here and renders as nothing at all. The compile-time
    /// half of this guard lives in `crates/core/src/event.rs`
    /// (`every_variant_is_accounted_for_by_the_consumers`), which stops compiling when the enum grows;
    /// this half checks the arms actually say something. Keep the list in step with that match.
    #[test]
    fn renders_something_for_every_variant() {
        let renderer = renderer(Verbosity::Normal);
        let events = [
            provisioned(),
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
                code: ErrorCode::EdgeRegistrationRefused,
            },
            TunnelEvent::ShuttingDown {
                reason: ShutdownReason::Requested,
            },
            TunnelEvent::Stopped { drained: true },
        ];

        for event in &events {
            let rendered = renderer.event(event, 3000);
            assert!(
                !rendered.is_empty(),
                "{event:?} rendered nothing — it fell through `_ => Vec::new()`"
            );
            assert!(
                rendered.iter().all(|(_, line)| !line.trim().is_empty()),
                "{event:?} rendered a blank line"
            );
        }
    }

    /// Every `ShutdownReason` must produce its own sentence, not the generic one.
    #[test]
    fn renders_a_distinct_reason_for_every_shutdown() {
        let renderer = renderer(Verbosity::Normal);
        let reasons = [
            ShutdownReason::Requested,
            ShutdownReason::LeaseExpired,
            ShutdownReason::ConnectionsExhausted,
        ];

        let rendered: Vec<String> = reasons
            .iter()
            .map(|reason| {
                on(
                    &renderer,
                    &TunnelEvent::ShuttingDown { reason: *reason },
                    Stream::Stderr,
                )
            })
            .collect();

        for (reason, line) in reasons.iter().zip(&rendered) {
            assert!(!line.trim().is_empty(), "{reason:?} rendered nothing");
        }
        let unique: std::collections::BTreeSet<&String> = rendered.iter().collect();
        assert_eq!(
            unique.len(),
            reasons.len(),
            "two reasons rendered identically, so one fell through the `_` arm: {rendered:?}"
        );
    }

    #[test]
    fn quiet_prints_the_url_on_stdout_and_nothing_else() {
        // `URL=$(nport 3000 --quiet)` has to work, which means exactly one line on stdout and no
        // decoration anywhere near it.
        let renderer = renderer(Verbosity::Quiet);

        assert_eq!(
            renderer.event(&provisioned(), 3000),
            vec![(Stream::Stdout, "https://myapp.nport.link".to_owned())]
        );
        assert!(
            renderer
                .event(
                    &TunnelEvent::ConnectionUp {
                        index: 0,
                        colo: "hkg09".to_owned()
                    },
                    3000
                )
                .is_empty()
        );
    }

    #[test]
    fn the_url_is_the_only_thing_on_stdout() {
        // **The regression this replaces:** the banner used to be one stdout string carrying the URL
        // *and* three lines of decoration, so `URL=$(nport 3000)` came back with four lines in it —
        // while the doc comment on `Stream` promised the opposite. `--quiet` hid the problem by
        // suppressing the extras, which made the only working way to script this the flag rather than
        // the default.
        let renderer = renderer(Verbosity::Normal);

        assert_eq!(
            on(&renderer, &provisioned(), Stream::Stdout),
            "https://myapp.nport.link",
            "stdout carries the URL and nothing else"
        );

        let banner = on(&renderer, &provisioned(), Stream::Stderr);
        assert!(banner.contains("localhost:3000"), "{banner}");
        assert!(banner.contains("Ctrl+C"), "{banner}");
        assert!(
            !banner.contains("https://"),
            "the URL must not be repeated: {banner}"
        );
    }

    #[test]
    fn progress_never_reaches_stdout() {
        // Every non-`Provisioned` event is chatter, and chatter on stdout is what corrupts a pipe.
        let renderer = renderer(Verbosity::Normal);
        for event in [
            TunnelEvent::ConnectionUp {
                index: 1,
                colo: "hkg09".to_owned(),
            },
            TunnelEvent::ConnectionLost { index: 1 },
            TunnelEvent::ShuttingDown {
                reason: ShutdownReason::Requested,
            },
            TunnelEvent::Stopped { drained: true },
        ] {
            assert_eq!(
                on(&renderer, &event, Stream::Stdout),
                "",
                "{event:?} put something on stdout"
            );
        }
    }

    #[test]
    fn a_lease_ending_is_not_worded_as_a_failure() {
        // Reaching the end of a four-hour lease is the system working as designed. v2 could not tell
        // the difference because it enforced the limit itself (defect R6).
        let line = renderer(Verbosity::Normal)
            .event(
                &TunnelEvent::ShuttingDown {
                    reason: ShutdownReason::LeaseExpired,
                },
                3000,
            )
            .remove(0)
            .1;
        assert!(!line.to_lowercase().contains("error"), "{line}");
        assert!(!line.contains('['), "a code has no place here: {line}");
    }

    #[test]
    fn an_incomplete_drain_says_so() {
        // `drained: false` means requests were cut off mid-flight. A shutdown that reported success
        // there would look identical to a clean one, which is what `drained` exists to prevent.
        let line = renderer(Verbosity::Normal)
            .event(&TunnelEvent::Stopped { drained: false }, 3000)
            .remove(0)
            .1;
        assert!(line.contains("SHUTDOWN_TIMEOUT"), "{line}");
    }

    #[test]
    fn every_failure_line_carries_its_code() {
        // `docs/ERRORS.md`: the code is what a user quotes in a bug report and what a script matches
        // on. A sentence without one is unactionable.
        let renderer = renderer(Verbosity::Normal);
        assert!(
            renderer
                .error(ErrorCode::SubdomainInUse)
                .contains("SUBDOMAIN_IN_USE")
        );
        assert!(
            renderer
                .error(ErrorCode::DnsConflict)
                .contains("DNS_CONFLICT")
        );
    }

    #[test]
    fn an_untranslated_code_points_at_its_documentation() {
        // The fallback, and why it is acceptable: the page is generated from the same registry, so
        // it cannot go stale the way a hand-written translation can.
        // A code from `i18n::UNTRANSLATED`, so this stays a test of the fallback rather than of one
        // code's translation status.
        let line = Renderer::new(Lang::Vi, Verbosity::Normal).error(ErrorCode::Internal);
        assert!(line.contains("nport.link/errors/internal"), "{line}");
    }

    #[test]
    fn a_retry_says_how_long_it_will_wait() {
        // A countdown a user can act on — "is it stuck, or is it waiting?" is the question this
        // answers, and the reason the event carries the delay at all.
        let line = renderer(Verbosity::Normal)
            .event(
                &TunnelEvent::ConnectionRetrying {
                    index: 2,
                    attempt: 3,
                    delay: Duration::from_secs(20),
                },
                3000,
            )
            .remove(0)
            .1;
        assert!(line.contains("20s"), "{line}");
        assert!(line.contains('3'), "{line}");
    }
}
