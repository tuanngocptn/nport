//! The `nport` binary: argument parsing, terminal rendering, config file, i18n, signals.
//!
//! **Not implemented.** Phase 2b in `docs/ROADMAP.md`.
//!
//! This is the only crate that formats text for humans, and the only one that knows the
//! user's language. See the CLI-specific rules in `crates/CLAUDE.md` — `--help` and
//! `--version` must work before any config read, locale resolution, or network call,
//! and nothing may ever prompt (ADR-0019).

#![forbid(unsafe_code)]

fn main() -> std::process::ExitCode {
    eprintln!(
        "nport {}: not implemented yet — see docs/ROADMAP.md",
        env!("CARGO_PKG_VERSION")
    );
    std::process::ExitCode::FAILURE
}
