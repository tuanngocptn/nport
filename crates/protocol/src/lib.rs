//! Cloudflare Tunnel connector wire protocol: edge discovery, QUIC and HTTP/2
//! transports, Cap'n Proto registration RPC, and per-stream request framing.
//!
//! **Not implemented.** Phase 1 in `docs/ROADMAP.md`, and it gates the entire rewrite.
//!
//! Read `docs/PROTOCOL.md` in full — not skimmed — and `crates/protocol/CLAUDE.md`
//! before adding anything here. Every constant carries a `file:symbol` citation into
//! the pinned cloudflared commit; a value without one is deleted in review.

#![forbid(unsafe_code)]
