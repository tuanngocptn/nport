# xtask

Repository automation, run as `cargo xtask <command>`. Not published.

| Command | Purpose |
| --- | --- |
| `codegen` | Generate `crates/contract` from the OpenAPI document and the Tauri IPC bindings. Must leave the tree clean |
| `fixtures` | Capture golden byte fixtures for `crates/protocol` from real edge traffic |
| `npm-packages` | Generate the nine npm `package.json` files from the single version in `crates/cli/Cargo.toml` |
| `verify-docs` | Check that every path in a repo-map block exists, every error code round-trips, and every markdown link resolves |

**Not implemented.** Phase 0 and Phase 1 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).

`verify-docs` is what keeps a `CLAUDE.md` from confidently pointing at a file that was renamed six months ago.
