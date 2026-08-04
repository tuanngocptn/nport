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

    /// The line for an event, or `None` when it should not be shown.
    ///
    /// Returning the text rather than printing it is what makes every case below testable without a
    /// terminal — and the reason this file has tests at all.
    #[must_use]
    pub fn event(&self, event: &TunnelEvent, port: u16) -> Option<(Stream, String)> {
        match event {
            TunnelEvent::Provisioned { url, .. } if self.verbosity == Verbosity::Quiet => {
                Some((Stream::Stdout, url.clone()))
            }
            TunnelEvent::Provisioned {
                url, expires_at, ..
            } => {
                let mut line = String::new();
                let _ = write!(line, "{url}");
                let _ = write!(
                    line,
                    "\n  {} http://localhost:{port}",
                    text(self.lang, Message::Forwarding)
                );
                let _ = write!(
                    line,
                    "\n  {} {}",
                    text(self.lang, Message::Expires),
                    local_time(*expires_at)
                );
                let _ = write!(line, "\n  {}", text(self.lang, Message::StopHint));
                Some((Stream::Stdout, line))
            }

            _ if self.verbosity == Verbosity::Quiet => None,

            TunnelEvent::ConnectionUp { index, colo } => Some((
                Stream::Stderr,
                format!(
                    "{} {index} ({colo})",
                    text(self.lang, Message::ConnectionUp)
                ),
            )),
            TunnelEvent::ConnectionLost { index } => Some((
                Stream::Stderr,
                format!("{} {index}", text(self.lang, Message::ConnectionLost)),
            )),
            TunnelEvent::ConnectionRetrying {
                index,
                attempt,
                delay,
            } => Some((
                Stream::Stderr,
                format!(
                    "{} {index} ({attempt}) — {}s",
                    text(self.lang, Message::Retrying),
                    delay.as_secs()
                ),
            )),
            TunnelEvent::ConnectionGaveUp { index, code } => {
                Some((Stream::Stderr, format!("{index}: {}", self.error(*code))))
            }
            TunnelEvent::ShuttingDown { reason } => Some((
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
            )),
            TunnelEvent::Stopped { drained } => Some((
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
            )),
            _ => None,
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

    #[test]
    fn quiet_prints_the_url_on_stdout_and_nothing_else() {
        // `URL=$(nport 3000 --quiet)` has to work, which means exactly one line on stdout and no
        // decoration anywhere near it.
        let renderer = renderer(Verbosity::Quiet);

        assert_eq!(
            renderer.event(&provisioned(), 3000),
            Some((Stream::Stdout, "https://myapp.nport.link".to_owned()))
        );
        assert_eq!(
            renderer.event(
                &TunnelEvent::ConnectionUp {
                    index: 0,
                    colo: "hkg09".to_owned()
                },
                3000
            ),
            None
        );
    }

    #[test]
    fn the_url_goes_to_stdout_and_progress_to_stderr() {
        // The split that makes a shell substitution possible while a human still sees what happened.
        let renderer = renderer(Verbosity::Normal);

        let (stream, line) = renderer.event(&provisioned(), 3000).expect("a line");
        assert_eq!(stream, Stream::Stdout);
        assert!(line.starts_with("https://myapp.nport.link"), "{line}");
        assert!(line.contains("localhost:3000"), "{line}");

        let (stream, _) = renderer
            .event(
                &TunnelEvent::ConnectionUp {
                    index: 1,
                    colo: "hkg09".to_owned(),
                },
                3000,
            )
            .expect("a line");
        assert_eq!(stream, Stream::Stderr);
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
            .expect("a line")
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
            .expect("a line")
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
        let line = Renderer::new(Lang::Vi, Verbosity::Normal).error(ErrorCode::DnsConflict);
        assert!(line.contains("nport.link/errors/dns-conflict"), "{line}");
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
            .expect("a line")
            .1;
        assert!(line.contains("20s"), "{line}");
        assert!(line.contains('3'), "{line}");
    }
}
