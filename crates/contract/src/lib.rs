//! Rust mirror of the NPort control-plane API: request and response types, and the
//! error-code enum.
//!
//! **Not implemented.** Phase 1.5 in `docs/ROADMAP.md`.
//!
//! The types in this crate are **generated** from `schema/nport-api.openapi.json` via
//! `typify`, which is itself generated from `packages/contract` (ADR-0009). This file
//! is the hand-written shell that will declare the generated module; everything with a
//! `@generated` banner is off-limits to hand edits and CI fails on drift (invariant 6).

#![forbid(unsafe_code)]
