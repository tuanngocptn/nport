# Contributing

Thanks for helping. NPort is MIT-licensed and maintained by [Nick Pham](https://github.com/tuanngocptn).

**The project is mid-rewrite.** `v3-new-architech` holds the documentation set, both workspaces, and a partly-built `crates/protocol`; nothing tunnels yet. v2 is on `main` and still shipping. Check `docs/ROADMAP.md` for what phase we are in before starting work — and if you want to contribute code right now, say so in an issue first, because the protocol spike (Phase 1) gates almost everything else.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node | 24 (`.nvmrc`); 22.12+ works | dev only; the published CLI needs no Node |
| pnpm | pinned in `packageManager`, via Corepack | workspace manager |
| Rust | pinned in `rust-toolchain.toml` | CLI, connector, desktop backend |
| `capnp` | 1.x, from your package manager | `crates/protocol` generates from the vendored schemas at build time |
| wrangler | via pnpm | Workers dev and deploy |
| Tauri prerequisites | per [tauri.app](https://tauri.app/start/prerequisites/) | only for `apps/desktop` |

```bash
corepack enable
pnpm install          # JS dependencies and the git hooks
```

Rust comes separately: install [rustup](https://rustup.rs), and the first `cargo` command in this repo installs the exact pinned toolchain for you. Version pins and why they are exact: ADR-0022.

```bash
brew install capnp                        # macOS
sudo apt-get install -y capnproto         # Debian/Ubuntu
choco install capnproto                   # Windows
```

You do **not** need a Cloudflare account to work on most of the repo. You do for `apps/api` deploys and for live-edge protocol tests.

## Dev loop

```bash
pnpm dev:api                        # wrangler dev, local DOs
pnpm dev:web                        # next dev with Worker bindings
pnpm dev:desktop                    # tauri dev
cargo run -p nport -- 3000 -s test  # the CLI
cargo run -p nport -- 3000 -s test --backend http://localhost:8787   # against local API
```

Before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test && cargo clippy && cargo test
pnpm codegen && cargo xtask codegen   # must leave the tree clean
```

`lefthook` runs formatting and the fast checks on commit. Do not bypass it with `--no-verify` unless you are fixing the hook.

In Claude Code sessions, a `Stop` hook (`.claude/hooks/require-tests.sh`) additionally refuses to end a turn that changed source in an area without touching that area's tests, and test authoring is delegated to a Sonnet-pinned subagent (ADR-0023). It does not affect ordinary `git` use.

## Where to work

`CLAUDE.md`'s routing table is the fastest way to find the right file. Two things to know before your first PR:

- **`packages/contract` is the API authority.** Adding or changing an endpoint, field, or error code starts there, then `pnpm codegen`. Editing a generated file directly will fail CI.
- **`crates/core` is headless.** No printing, no exiting. If you need to tell the user something, add a `TunnelEvent` variant and render it in `crates/cli`.

Style rules live in `docs/conventions/typescript.md` and `docs/conventions/rust.md`. Biome and clippy enforce most of them, so lint output is usually the fastest answer.

## Commits

Conventional commits — `git-cliff` builds the changelog from them, so the subject line ends up in release notes.

```
type(scope): brief description
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
Scopes: `api`, `web`, `desktop`, `cli`, `core`, `protocol`, `contract`, `ci`, `docs`.

```
feat(cli): add --transport flag to force http2
fix(api): verify CNAME target before deleting a DNS record
docs(protocol): record the interfaceId used for registerConnection
```

Anything scoped `protocol` should explain *why* in the body. Those are the commits future maintainers will read most carefully.

## Branches

`feature/`, `fix/`, `docs/`, `refactor/`, `protocol/` — e.g. `protocol/quic-handshake`, `fix/subdomain-normalization`.

## Pull requests

```bash
git remote add upstream https://github.com/tuanngocptn/nport.git
git fetch upstream && git rebase upstream/v3-new-architech
git push origin feature/my-thing
```

Checklist:

- [ ] lint, typecheck, and tests pass in both languages
- [ ] codegen leaves the tree clean
- [ ] tests added for new behaviour (`docs/TESTING.md` lists what must be covered)
- [ ] docs updated if you touched anything a doc's `applies_to:` globs cover — CI will comment if you missed one
- [ ] an ADR added to `docs/DECISIONS.md` for any architecture or dependency decision
- [ ] no `@generated` file hand-edited
- [ ] no secret, token, or raw IP in code, tests, or logs

CI runs Biome, `tsc`, Vitest, `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo deny`, and the codegen drift gate. Rust builds on Linux for pull requests, and on macOS and Windows too for pushes to a long-lived branch.

## Contributing to `crates/protocol`

Highest-risk directory in the repo. Read `docs/PROTOCOL.md` and `crates/protocol/CLAUDE.md` first — both, fully, not skimmed.

Non-negotiable:

- **Never guess a constant.** Read it from the pinned cloudflared commit and cite `file:symbol` in a comment.
- Any wire-format change needs an updated golden fixture and a reviewed `insta` snapshot.
- Any protocol change updates `docs/PROTOCOL.md` in the **same commit**.
- `src/h2.rs` must keep compiling even while unused — it is the ADR-0017 fallback.

Live-edge tests need a real tunnel token and outbound UDP 7844:

```bash
cargo test -p nport-protocol -- --ignored
```

Protocol changes are CODEOWNER-reviewed and will take longer to merge. That is intentional.

## Translations

en, vi, and es. Catalogues live in `crates/cli`; add or correct strings there. Keep messages actionable — "port 3000 is not accepting connections; start your server first" beats "connection failed".

Adding a new language means updating the language enum, the catalogue, and the locale-detection tests. Open an issue first so we can check it is a language with enough users to keep current — a stale translation is worse than English.

## Reporting bugs

Use the issue templates. For a tunnel failure, include: the `requestId` from the error, the error code, `nport --version`, your OS and architecture, and whether `--transport http2` changes anything. That last one immediately distinguishes a QUIC/UDP-blocking network from a real bug, and saves a round trip.

Security issues: **do not open an issue.** See `SECURITY.md`.

## Contact

`tuanngocptn@gmail.com` · Made with ❤️ in Vietnam
