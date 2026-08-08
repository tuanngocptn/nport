# Contributing

Thanks for helping. NPort is MIT-licensed and maintained by [Nick Pham](https://github.com/tuanngocptn).

**The project is mid-rewrite.** `v3-new-architect` holds the documentation set, both workspaces, and a partly-built `crates/protocol`; nothing tunnels yet. v2 is on `main` and still shipping. Check `docs/ROADMAP.md` for what phase we are in before starting work — and if you want to contribute code right now, say so in an issue first, because the protocol spike (Phase 1) gates almost everything else.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node | 24 (`.nvmrc`); 22.12+ works | dev only; the published CLI needs no Node |
| pnpm | pinned in `packageManager`, via Corepack | workspace manager |
| Rust | pinned in `rust-toolchain.toml` | CLI, connector, desktop backend |
| `capnp` | 1.x, from your package manager | `crates/protocol` generates from the vendored schemas at build time |
| wrangler | via pnpm | Workers dev and deploy |
| Tauri prerequisites | per [tauri.app](https://tauri.app/start/prerequisites/) | `apps/desktop`, and therefore `pnpm dev` |

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

macOS and Windows carry a WebView in the OS. **Linux does not**, and `apps/desktop/src-tauri` is a workspace member, so a plain `cargo clippy` at the repo root builds it and fails without the headers — as a `pkg-config` error from `gobject-sys`, several hundred lines into a normal-looking build:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

You do **not** need a Cloudflare account to work on most of the repo, including running the whole stack locally — see the dev loop below. You do for `apps/node` deploys, for a genuine end-to-end tunnel, and for live-edge protocol tests.

## Dev loop

```bash
pnpm dev        # the whole backend, the site, and the desktop window, together
pnpm dev:cli    # in a second terminal: tunnel the local site through the local gateway
```

| Port | Surface | |
| --- | --- | --- |
| **8787** | `apps/gateway` | the front door — **point clients here** |
| 8788 | `apps/node` | provisioning. No route in production; reachable here only because `wrangler dev` gives everything one |
| 8789 | `apps/registry` | the directory |
| 3000 | `apps/web` | the site |
| 1420 | `apps/desktop` | Vite, behind the native window |

**Three Workers, and only the first one is for clients** (ADR-0049). The node and the registry sit behind service bindings, which wrangler resolves between concurrent `wrangler dev` sessions. Pointing a client at 8788 gets `INTERNAL`, correctly: no gateway, no caller identity, and the node fails closed rather than inventing one.

Each is startable alone — `pnpm dev:gateway`, `dev:node`, `dev:registry`, `dev:web`, `dev:desktop` — which is usually what you want, because the first `tauri dev` compiles several hundred Rust crates and everything else is ready in under a second. The gateway alone answers `/v1/health` and nothing else, since its bindings have nothing to resolve to.

Ports are pinned in each app's `dev` script rather than left to wrangler, whose default is 8787 for all three; `turbo run dev` starts them at once, so which two failed to bind would otherwise be a race.

A preflight runs first. It creates `.dev.vars` for all three Workers if any is missing, says which ports are already taken — **including each `wrangler dev`'s inspector port**, because a leaked `workerd` holding only one of those makes wrangler die naming a port nothing else mentions — and prints what is starting. It never refuses to start the stack: a preflight that blocks on a warning is one people route around, and then they lose the warnings too.

**Neither `apps/web` nor `apps/desktop` is a scaffold any more.** The site is 2c code-complete and waiting on a deploy; the app has four of its five screens and talks to `crates/core` for real. Both still come up under `pnpm dev` with the rest of the stack, which is what the scaffolds existed for. `docs/ROADMAP.md` is the live status, and each app's `CLAUDE.md` says what it owes.

### Provisioning without a Cloudflare account

`apps/node/.dev.vars` and `apps/gateway/.dev.vars` are created from their examples on first run. Both are gitignored, hold no real secret, and `wrangler deploy` never uploads them — which is what makes them the right place for settings that must never exist in production.

**The registry needs its own `POW_SECRET`, and it must differ from the node's.** Both services issue and verify proof-of-work challenges with the same algorithm, so one shared key makes a challenge issued by the node redeemable at the registry — enrolling a node into the directory would then cost whatever the cheapest tunnel create in the world costs. The two examples carry different values, Terraform keeps two independent `random_password` resources, and `pnpm deploy:check` fails if they ever come from one.

**Both must agree on `MIN_CLIENT_VERSION`.** The gateway *enforces* the floor and the node *publishes* it on `GET /v1/meta`, so a mismatch means a client reads one number and is refused by another. Both examples say `0.0.0`, because the local build calls itself `3.0.0-dev` and the gate sorts a pre-release below its release. `pnpm deploy:check` holds the same pair equal in the committed configs.

**`pnpm smoke`** drives that whole stack end to end and asserts on it — worth running before a push, and required after touching `src/cloudflare/dev-fake.ts` or the CLI's output, neither of which any other tier covers (`docs/TESTING.md` § Smoke tests).

**`FAKE_CLOUDFLARE="1"`** routes every Cloudflare call to an in-memory fake (`apps/node/src/cloudflare/dev-fake.ts`), so `POST /v1/tunnels` succeeds with no credentials. What it buys is most of the system, and a full run looks like this:

```
challenge 200 → tunnels 201 → the URL banner → a real QUIC dial to Cloudflare's edge
→ EDGE_REGISTRATION_REFUSED → jittered retries → gives up → TUNNEL_LOST
→ heartbeat 200 throughout → DELETE 204, lease released
```

Everything there is real except the credential. The edge is the **actual** Cloudflare edge, discovered and dialled over QUIC; it refuses the fake token at registration, which is where a fake run is supposed to stop. The retries, the give-up, and the release are the production paths doing their job, not a fault. **That ending is expected — do not report it.**

The fake's token is shaped to be *parseable* on purpose: `t` is a UUID and `s` decodes to at least 32 bytes, because `TunnelToken::parse` checks both. Get either wrong and the client fails at parsing while reporting `EDGE_PROTOCOL_ERROR`, so a run appears to have reached the edge when it never left the process.

**`MIN_CLIENT_VERSION="3.0.0-dev"`** lowers the client-version floor to what the workspace builds. `wrangler.jsonc` sets `3.0.0` for production and `crates/cli` is `3.0.0-dev`, which semver orders *below* it — so without this the local CLI is refused by the local control plane with `CLIENT_TOO_OLD`. **Do not "fix" that in `src/middleware/client-gate.ts`.** The ordering is deliberate: it is what stops every `3.0.0-beta.N` client sailing through once the floor moves to `3.0.0`. `3.0.0-dev` rather than `0.0.0`, so the gate still runs and a real 2.x client is still refused.

For an **actual** tunnel, put a real scoped token in `.dev.vars` — `Cloudflare Tunnel Write` and `DNS Write`, against a zone you own, and never a production one. Account-owned, like every other token here (ADR-0043). The fake stands down on its own when `CF_API_TOKEN` looks real, so there is nothing else to switch off.

If gated routes start answering `INTERNAL` while `/v1/health` stays green, your `.dev.vars` is **stale** rather than missing — it predates a key the example has since gained, so nothing recreated it. The preflight diffs the two and names what is absent. It reports rather than merges, because appending to a file that might hold your real token is not a thing a script should do unasked.

Before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test && cargo clippy && cargo test
pnpm codegen && cargo xtask codegen   # must leave the tree clean
```

`lefthook` runs formatting and the fast checks on commit. Do not bypass it with `--no-verify` unless you are fixing the hook.

In Claude Code sessions, a `Stop` hook (`.claude/hooks/require-tests.sh`) additionally refuses to end a turn that changed source in an area without touching that area's tests, and test authoring is delegated to a Sonnet-pinned subagent (ADR-0023). It does not affect ordinary `git` use.

The repo is also wired for [CodeGraph](https://github.com/colbymchenry/codegraph), which indexes every symbol and call edge into a local SQLite graph so an agent answers "who calls this" from the index instead of grepping. `.mcp.json`, `.claude/CLAUDE.md`, the `UserPromptSubmit` hook, and `codegraph.json` are all committed, so it is set up for you — **it is optional**, and the hook exits silently when the binary is absent. To use it:

```bash
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
codegraph init          # once per clone; the index lives in .codegraph/ and is gitignored
```

`codegraph.json` excludes `docs/mockup/` — a vendored export, excluded from every other check too — and the `server/`, `website/`, and `bin/` directories a v2 checkout leaves behind.

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
git fetch upstream && git rebase upstream/v3-new-architect
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
- **`src/h2.rs` is not written yet** (ADR-0017 Fallback 1). When it is, it must be declared in `lib.rs` so `cargo clippy --all-targets` compiles it even while nothing calls it — an undeclared module is invisible to the build, which is the only way the fallback can rot unnoticed.

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
