//! `TunnelManager`: provision → connect → proxy → teardown, plus the connection pool,
//! reconnect logic, local proxy, event stream, and the optional traffic inspector.
//!
//! **Phase 2b, in progress.** `proxy` is the origin-side half; `TunnelManager` and the event
//! stream are next (`docs/ROADMAP.md`).
//!
//! This crate is **headless** (invariant 5). It emits `TunnelEvent`s; `crates/cli` and
//! `apps/desktop` render them. The lints below make that mechanical rather than a rule
//! someone has to remember: a stray `println!` here corrupts the desktop app's IPC
//! channel, and `process::exit` from a library makes the GUI vanish without a dialog.
//! If you want to say something from `core`, add a `TunnelEvent` variant.

#![forbid(unsafe_code)]
#![deny(clippy::print_stdout, clippy::print_stderr, clippy::exit)]

pub mod event;
pub mod proxy;
pub mod retry;
