//! The `nport` CLI's modules, exposed as a library so its own definitions can be read.
//!
//! **This crate is a binary; the library exists for one reason.** `crates/xtask` generates the CLI flag
//! reference on the site from `Args`'s clap definition, and to do that it has to *have* `Args` — a
//! bin-only crate exports nothing, which is why three `CLAUDE.md` files could claim the reference was
//! generated while nothing generated it (defect 38). The alternatives were a hand-kept table that a test
//! compares against clap, or parsing `--help` output; the second is the message-string matching ADR-0018
//! exists to forbid, and the first is a second place to edit for a guarantee this gives for free.
//!
//! So the rule this crate follows is narrow: **`main.rs` holds `main` and nothing else worth importing,
//! and everything else lives here.** Nothing outside the workspace's own tooling should depend on it —
//! `publish = false`, and the layering in `docs/conventions/rust.md` is unchanged, because `xtask` is
//! not in the `protocol → core → {cli, desktop}` graph. It is a build tool that reads the tree.
//!
//! The headless rule still applies in the other direction: this crate may print, and `crates/core` may
//! not. A dependency from `core` to here would be the regression that matters.

#![forbid(unsafe_code)]

pub mod args;
pub mod config;
pub mod i18n;
pub mod render;
