//! Generates Rust bindings for the vendored Cap'n Proto schemas.
//!
//! Requires the `capnp` compiler on PATH — it is a build prerequisite for this crate,
//! not something cargo can install (`docs/CONTRIBUTING.md`).
//!
//! The schemas in `schema/` are copied verbatim from cloudflared at the commit pinned in
//! `docs/PROTOCOL.md` §1. They are read-only: type IDs are wire identity.

fn main() {
    // `go.capnp` is not listed: it declares only Go annotations and is pulled in as an
    // import by the two files below.
    capnpc::CompilerCommand::new()
        .src_prefix("schema")
        // The generated code refers to sibling modules absolutely, as
        // `crate::<parent>::<file>_capnp`. Without this it assumes the crate root and the
        // `schema` module below does not compile.
        .default_parent_module(vec!["schema".to_owned()])
        .file("schema/tunnelrpc.capnp")
        .file("schema/quic_metadata_protocol.capnp")
        .run()
        .expect("capnp codegen failed — is the `capnp` compiler installed?");
}
