//! Cloudflare Tunnel connector wire protocol: edge discovery, QUIC and HTTP/2
//! transports, Cap'n Proto registration RPC, and per-stream request framing.
//!
//! **Phase 1, in progress.** `docs/ROADMAP.md` tracks which sub-steps are done.
//!
//! Read `docs/PROTOCOL.md` in full — not skimmed — and `crates/protocol/CLAUDE.md`
//! before adding anything here. Every constant carries a `file:symbol` citation into
//! the pinned cloudflared commit; a value without one is deleted in review.

#![forbid(unsafe_code)]

pub mod edge;
pub mod token;

/// Generated from `schema/`. Not our code, so not our lint standards — but it is our
/// wire identity, so the type IDs in it matter more than anything we wrote by hand.
#[allow(
    clippy::all,
    clippy::pedantic,
    dead_code,
    unreachable_pub,
    unused_qualifications,
    missing_docs
)]
pub mod schema {
    pub mod tunnelrpc_capnp {
        include!(concat!(env!("OUT_DIR"), "/tunnelrpc_capnp.rs"));
    }

    pub mod quic_metadata_protocol_capnp {
        include!(concat!(env!("OUT_DIR"), "/quic_metadata_protocol_capnp.rs"));
    }
}
