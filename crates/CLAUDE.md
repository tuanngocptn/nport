# crates/

The Rust workspace: the connector, the tunnel manager, and the CLI. Style rules are in `docs/conventions/rust.md`; this file covers layering and the crate-specific rules that document cannot.

**Status: Phase 2b is code-complete and live-verified** on macOS, Linux and Windows against deployed staging (`docs/ROADMAP.md`). `protocol` speaks the wire, `core` provisions, connects, proxies, inspects and tears down, and `nport` is a working CLI.

## Crates

| Crate | Lib name | Responsibility |
| --- | --- | --- |
| `protocol` | `nport_protocol` | Cloudflare connector wire protocol. See `crates/protocol/CLAUDE.md` |
| `core` | `nport_core` | `TunnelManager`: discover → provision → connect → proxy → teardown. Connection pool, reconnect, local proxy, event stream, optional inspector. **Headless.** |
| `cli` | bin `nport`, lib `nport` | Argument parsing, terminal rendering, config file, i18n, signals. The lib exists so `xtask` can read `Args`'s clap definition — `main.rs` holds `main` and nothing else |
| `contract` | `nport_contract` | API types and `ErrorCode`, **generated** from `packages/contract` into `src/generated.rs` — never hand-edit that file. `src/lib.rs` and `src/subdomain.rs` are hand-written; see the crate README |
| `xtask` | — | `cargo xtask codegen \| fixtures \| npm-packages \| verify-docs`. Depends on `nport` to generate `schema/cli.json`; outside the layering graph |

## Layering

```
protocol → core → { cli, desktop }
contract → core
```

**One-directional, no exceptions.** `crates/core` must never depend on `crates/cli` — the single most likely architectural regression here, because the temptation to print a nice message from inside `core` is constant.

`core` is **headless**: no `println!`, no `eprintln!`, no `process::exit`, no TTY detection, no progress bars, no prompts. Its surface is:

```rust
TunnelManager::spawn(config) -> TunnelHandle
handle.events() -> broadcast::Receiver<TunnelEvent>
```

`crates/cli` renders events to a terminal. `apps/desktop` forwards the same events to a WebView. If you want to communicate something from `core`, **add a `TunnelEvent` variant** — then handle it in both consumers, or the CLI silently drops it.

The reason is concrete: a stray `println!` in `core` corrupts the desktop app's IPC channel, and `process::exit` from a library makes the GUI vanish without a dialog.

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
9. **`core` never reads the environment.** No `HOME`, no `std::env`. `crates/cli` resolves paths and passes them in — `TunnelConfig::nodes_cache` is the example, and the reason is concrete: a library reading `HOME` writes to a developer's real `~/.nport` from inside a test, which the first draft of the failover tests did.
10. **Failover never happens after `POST /v1/tunnels` has been sent.** `discovery::may_try_another_node` is the whole decision: a node saying *it* cannot serve is a reason to move on; a node saying *you* may not is not, because per-source caps are per node and shopping around multiplies them.

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

**Add a CLI flag** — `crates/cli/src/args.rs` → thread it into the `TunnelConfig` in `core` if it affects behaviour → add i18n strings for all three languages → test the parse, including adjacent-flag cases like `-s -l vi` → `cargo xtask codegen`, which regenerates `schema/cli.json` from the clap definition. CI fails on drift, so a flag added without it is caught.

**Add a `TunnelEvent`** — the enum in `core` → the exhaustive match in `event.rs`'s tests → render it in `crates/cli/src/render.rs` and add it to `renders_something_for_every_variant` → forward it in `apps/desktop/src-tauri/src/events.rs`, which now exists. **The compiler will not remind you**: `TunnelEvent` is `#[non_exhaustive]`, so a consumer in another crate needs a wildcard arm — the CLI's is `_ => Vec::new()` and the desktop's returns `None`, and both render an unhandled variant as nothing. Each has a test that is the substitute: `event.rs`'s fails to compile when the enum grows, `renders_something_for_every_variant` and `every_variant_this_build_knows_translates` fail at runtime. **Add a language** — the language enum, the catalogue in `crates/cli`, and locale-detection tests. Open an issue first (`docs/CONTRIBUTING.md`). **Change the API client** — regenerate `crates/contract` from `packages/contract`; never hand-edit the generated types.

## Gotchas

- **`apps/desktop/src-tauri` is also a workspace member**, so `cargo clippy` from the root includes it.
- **`crates/contract/src/generated.rs` is generated.** Edits are overwritten and CI fails on drift. The crate is *not* wholly generated, which the table above used to imply: `lib.rs` holds the error envelope and `subdomain.rs` holds normalization, because a typed `ErrorCode` and NFKC are not things JSON Schema can say. `subdomain.rs` takes its **constants** from codegen and reimplements only the rules — so a reserved name is added in `packages/contract` and nowhere else, while a rule change means editing both sides and adding a case to `packages/contract/fixtures/subdomains.json`, which both test suites read.
- **`crates/protocol` has `nport-core` as a dev-dependency**, so its examples can call the real proxy instead of keeping a second copy that drifts. Cargo permits the cycle and it stays out of `nport-protocol`'s library graph. If it ever appears outside `[dev-dependencies]`, that is the regression.
- **An internal path dependency needs `version` as well as `path`.** Path-only is a wildcard requirement and `deny.toml` denies wildcards — but the failure is invisible until something actually *depends* on the crate, because cargo-deny only inspects the resolved graph. Three of these sat declared-but-unused for weeks and only broke CI the day one was used. `cargo-deny` is CI-only, so check `cargo metadata` shows a real `req` before pushing a Cargo.toml change.
- **`crates/core` is linked in-process by the desktop app**, so a panic there kills the GUI. Return errors; do not panic. **A length the origin sent is arithmetic that can overflow and a buffer that can grow forever** — `size + 2` on a `usize::MAX` chunk header panicked, and the size line itself had no ceiling. Every bound the response decoder relies on is a named constant in `proxy.rs` (`MAX_RESPONSE_HEAD`, `MAX_CHUNK_SIZE_LINE`); a new one belongs there, checked before the allocation rather than after.
- **A proxy relays what the origin actually said, so its parsers are lenient where the grammar is.** `ResponseHead::parse` split on `": "` and so dropped every header written `Name:value`, which the grammar permits — and dropping `Transfer-Encoding` puts chunk-size lines in the browser as page content. When one format is parsed in two places, diff the parsers: this one disagreed with the test fake in `tunnel.rs`, which was right. **The yardstick is curl, not the RFC** — it accepts a bare-LF head and a spaceless colon, so a user's hand-rolled server has already proved to them that it works, and anything stricter reads as our bug. Toward the origin always write CRLF; reading from it, accept what curl accepts — in **every** parser, not just the one that prompted the change: the head fix landed a commit before the chunk-framing one because the same bare-LF origin frames its chunks the same way.
- **The tunnel token must never reach argv, a log line, a config file, or a `Debug` output.** v2 passed it as a command-line argument, visible via `ps` to every local user.
- Windows process handling differs: no shell wrapper, and terminate the child directly. v2's `kill()` hit a shell on Windows and `cloudflared` outlived it.
