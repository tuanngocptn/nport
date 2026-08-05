# Rust conventions

Applies to `crates/*` and `apps/desktop/src-tauri`.

## Edition and toolchain

Edition 2024, MSRV 1.85. `rust-toolchain.toml` pins an **exact** stable version — not `stable`. A clippy or codegen change landing mid-protocol-spike is noise nobody needs; bump it deliberately.

`cargo clippy` runs with `-D warnings` in CI. `cargo fmt` is not optional.

## Safety

```rust
#![forbid(unsafe_code)]
```

In every crate. A network-facing protocol client has no need for `unsafe`, and `quinn`/`rustls`/`capnp` mean you never reach for it.

## Naming

| Element | Convention | Example |
| --- | --- | --- |
| Files and modules | `snake_case` | `connect.rs`, `edge.rs` |
| Types, traits, enum variants | `PascalCase` | `TunnelManager`, `ConnectionType` |
| Functions, methods, locals | `snake_case` | `register_connection` |
| Constants and statics | `SCREAMING_SNAKE_CASE` | `KEEP_ALIVE_INTERVAL` |
| Crates | `kebab-case` dir, `snake_case` lib | `crates/protocol` → `nport_protocol` |

## Errors

`thiserror` in libraries, `anyhow` only in `crates/cli`'s `main`. A library that returns `anyhow::Error` has thrown away its callers' ability to branch.

```rust
#[derive(Debug, thiserror::Error)]
pub enum EdgeError {
    #[error("no edge address resolved")]
    NoAddress,
    #[error("registration refused: {cause}")]
    RegistrationRefused { cause: String, retry_after: Option<Duration> },
}
```

Every error that can reach a user maps to a code in `docs/ERRORS.md`. Do not format messages for humans inside a library — that is `crates/cli`'s job, and it is the only place that knows the user's language.

Never `unwrap()` or `expect()` on anything that can fail at runtime. In tests, freely.

## Async

Tokio, multi-threaded runtime. **No blocking I/O inside an `async fn`** — no `std::fs`, no `std::net`, no `Mutex` held across an `.await`. Use `tokio::task::spawn_blocking` when you must.

Prefer `tokio::sync::Mutex` only when a lock genuinely must be held across an await point; otherwise `std::sync::Mutex` with a tight scope is faster and clearer.

Every spawned task must have a defined shutdown path. A task nobody can cancel is a leak.

## Dependencies

Declared once in the workspace root:

```toml
# Cargo.toml
[workspace.dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "macros", "signal"] }

# crates/core/Cargo.toml
[dependencies]
tokio = { workspace = true }
```

Adding a dependency to a crate without adding it to `workspace.dependencies` first will drift versions. `cargo deny check` enforces the licence allowlist and RUSTSEC advisories.

## Layering

```
protocol → core → { cli, desktop }
contract → core
```

One-directional. **`crates/core` must never depend on `crates/cli`** — this is the most likely architectural regression in the repo. `core` is headless: no `println!`, no `eprintln!`, no `process::exit`, no TTY detection, no `dialoguer`. It emits `TunnelEvent`s; the CLI and the desktop app render them however they like.

If you find yourself wanting to print from `core`, add an event variant instead.

## Secrets in types

Credential material gets a wrapper that redacts on `Debug`/`Display` and zeroizes on drop:

```rust
pub struct TunnelToken(Zeroizing<String>);

impl fmt::Debug for TunnelToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TunnelToken(<redacted>)")
    }
}
```

Never `#[derive(Debug)]` on a struct holding a token or secret. Never log one, at any level.

**In `crates/contract` this is generated, not remembered.** `cargo xtask codegen` omits the `Debug` derive for any struct with a `*Token` field and emits a redacting impl instead, so `{:?}` prints `<redacted>` for the credential and the real value for everything else. Keyed on the field *name*, so a credential added to the contract tomorrow is covered without anyone editing a list here. Do not hand-edit the result — invariant 6.

## Tests

Unit tests inline in `#[cfg(test)] mod tests`. Integration tests in `tests/`. `insta` for snapshots of every wire encoder, `proptest` for codec roundtrips. See `docs/TESTING.md`.

Test names say what they assert: `rejects_subdomain_with_trailing_hyphen`, not `test_subdomain_2`.

## Comments

Comment *why*, not *what*. In `crates/protocol`, every non-obvious constant carries a citation into the pinned cloudflared source:

```rust
/// The edge closes idle connections after 5s, so this must stay well below it.
/// cloudflared: quic/constants.go → MaxIdlePingPeriod
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(1);
```

That citation is the difference between a value someone can verify and a magic number nobody dares touch.
