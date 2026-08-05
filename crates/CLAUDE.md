# crates/

The Rust workspace: the connector, the tunnel manager, and the CLI.

Style rules are in `docs/conventions/rust.md`. This file covers layering and the crate-specific rules that document cannot.

**Status: Phase 2b is code-complete.** `protocol` speaks the wire, `core` provisions, connects, proxies, inspects and tears down, and `nport` is a working CLI. Nothing has been run against the live control plane yet — `apps/api` is not deployed (`docs/ROADMAP.md`).

## Crates

| Crate | Lib name | Responsibility |
| --- | --- | --- |
| `protocol` | `nport_protocol` | Cloudflare connector wire protocol. See `crates/protocol/CLAUDE.md` |
| `core` | `nport_core` | `TunnelManager`: provision → connect → proxy → teardown. Connection pool, reconnect, local proxy, event stream, optional inspector. **Headless.** |
| `cli` | bin `nport` | Argument parsing, terminal rendering, config file, i18n, signals |
| `contract` | `nport_contract` | **GENERATED** from `packages/contract`. Never hand-edit |
| `xtask` | — | `cargo xtask codegen \| fixtures \| npm-packages \| verify-docs` |

## Layering

```
protocol → core → { cli, desktop }
contract → core
```

**One-directional, no exceptions.** `crates/core` must never depend on `crates/cli`. This is the single most likely architectural regression in the repo, because the temptation to print a nice message from inside `core` is constant.

`core` is **headless**: no `println!`, no `eprintln!`, no `process::exit`, no TTY detection, no progress bars, no prompts. Its public surface is:

```rust
TunnelManager::spawn(config) -> TunnelHandle
handle.events() -> broadcast::Receiver<TunnelEvent>
```

`crates/cli` renders events to a terminal. `apps/desktop` forwards the same events to a WebView. If you want to communicate something from `core`, **add a `TunnelEvent` variant** — then handle it in both consumers, or the CLI silently drops it.

The reason is concrete, not stylistic: a stray `println!` in `core` corrupts the desktop app's IPC channel, and `process::exit` from a library makes the GUI vanish without a dialog.

## Commands

```bash
pnpm smoke                              # the local stack end to end; see docs/TESTING.md
cargo run -p nport -- 3000 -s test
cargo run -p nport -- 3000 -s test --backend http://localhost:8787
cargo test                              # hermetic
cargo test -- --ignored                 # live edge; needs network + token
cargo clippy --all-targets -- -D warnings
cargo xtask codegen                     # must leave the tree clean
```

## Rules

1. `#![forbid(unsafe_code)]` in every crate.
2. `thiserror` in libraries, `anyhow` only in `crates/cli`'s `main`. A library returning `anyhow::Error` has thrown away its callers' ability to branch.
3. **Every user-reachable error maps to a code in `docs/ERRORS.md`.** Libraries carry codes; only `crates/cli` turns them into prose, because only it knows the user's language. A new code must be translated in all three languages **or** added to the `UNTRANSLATED` list in `i18n.rs`'s tests with the reason it is not a user's problem — a test fails otherwise, which is what stops a code from quietly rendering as `[CODE]`.
4. **Never format for humans below `crates/cli`.** v2 built chalk-coloured English help text inside `Error.message` in its API client, which bypassed i18n entirely.
5. Workspace dependencies only — declare in the root `[workspace.dependencies]`, reference with `{ workspace = true }`.
6. No blocking I/O in `async fn`. No lock held across an `.await`.
7. Every spawned task has a defined shutdown path.
8. **Never derive `Debug` on anything holding a token or secret.** Use a redacting wrapper that zeroizes on drop.

## CLI-specific rules

The v2 CLI got several basics wrong; these are the corrections, and they are all testable.

1. **`clap` for parsing.** Port accepted both positionally and as `-p/--port`. v2 had positional only, so `nport -s app 3000` silently tunnelled port 8080.
2. **`--help` and `--version` always work**, immediately, before any config read, any locale resolution, or any network call. v2's `nport -v` hung on a fresh install behind an interactive prompt.
3. **Unknown flags are an error**, not silently ignored.
4. **Never prompt. Ever.** No TTY assumption anywhere — the CLI must work identically in CI, Docker, and pipes (ADR-0019).
5. **Locale is detected**: `--lang` → `NPORT_LANG` → config → `$LC_ALL`/`$LC_MESSAGES`/`$LANG` / `GetUserDefaultLocaleName` → `en`.
6. **Probe the local port before provisioning.** Failing fast with `LOCAL_PORT_CLOSED` beats creating a tunnel to nothing.
7. **Shutdown is structured and re-entrant.** A second Ctrl+C must not fire a second delete. v2's signal handler called an async cleanup and never awaited it.
8. Config is `~/.nport/config.toml`, read lazily, and a corrupt file is a clear error — never a silent default. **Report it through the renderer, not with `{error}`**: the language must be resolved without the config's contribution, since the config is what failed, and printing `thiserror`'s Display there is defect R20 reappearing inside `crates/cli`. `NPORT_HOME` overrides the location, which is the seam `pnpm smoke` uses.

## Common tasks

**Add a CLI flag** — `crates/cli/src/args.rs` → thread it into the `TunnelConfig` in `core` if it affects behaviour → add i18n strings for all three languages → test the parse, including adjacent-flag cases like `-s -l vi` → `pnpm codegen` to refresh the generated flag reference on the site.

**Add a `TunnelEvent`** — the enum in `core` → render it in `crates/cli` → forward it in `apps/desktop/src-tauri/src/events.rs`. All three, or it goes nowhere.

**Add a language** — the language enum, the catalogue in `crates/cli`, and locale-detection tests. Open an issue first (`docs/CONTRIBUTING.md`).

**Change the API client** — regenerate `crates/contract` from `packages/contract`; never hand-edit the generated types.

## Gotchas

- **`apps/desktop/src-tauri` is also a workspace member**, so `cargo clippy` from the root includes it.
- **`crates/contract` is generated.** Edits are overwritten and CI fails on drift.
- **`crates/protocol` has `nport-core` as a dev-dependency**, so its examples can call the real proxy instead of keeping a second copy that drifts. Cargo permits the cycle and it stays out of `nport-protocol`'s library graph. If it ever appears outside `[dev-dependencies]`, that is the regression.
- **An internal path dependency needs `version` as well as `path`.** Path-only is a wildcard requirement and `deny.toml` denies wildcards — but the failure is invisible until something actually *depends* on the crate, because cargo-deny only inspects the resolved graph. Three of these sat declared-but-unused for weeks and only broke CI the day one was used. `cargo-deny` is CI-only, so check `cargo metadata` shows a real `req` before pushing a Cargo.toml change.
- **`crates/core` is linked in-process by the desktop app**, so a panic there kills the GUI. Return errors; do not panic. **A length the origin sent is arithmetic that can overflow and a buffer that can grow forever** — `size + 2` on a `usize::MAX` chunk header panicked, and the size line itself had no ceiling. Every bound the response decoder relies on is a named constant in `proxy.rs` (`MAX_RESPONSE_HEAD`, `MAX_CHUNK_SIZE_LINE`); a new one belongs there, checked before the allocation rather than after.
- **A proxy relays what the origin actually said, so its parsers are lenient where the grammar is.** `ResponseHead::parse` split on `": "` and so dropped every header written `Name:value`, which the grammar permits — and dropping `Transfer-Encoding` puts chunk-size lines in the browser as page content. When one format is parsed in two places, diff the parsers: this one disagreed with the test fake in `tunnel.rs`, which was right. **The yardstick is curl, not the RFC** — it accepts a bare-LF head and a spaceless colon, so a user's hand-rolled server has already proved to them that it works, and anything stricter reads as our bug. Toward the origin always write CRLF; reading from it, accept what curl accepts.
- **The tunnel token must never reach argv, a log line, a config file, or a `Debug` output.** v2 passed it as a command-line argument, visible via `ps` to every local user.
- Windows process handling differs: no shell wrapper, and terminate the child directly. v2's `kill()` hit a shell on Windows and `cloudflared` outlived it.
