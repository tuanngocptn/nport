# CLAUDE.md

Guidance for Claude Code working in this repository. Read this file first; it tells you where everything else is.

## Project

NPort tunnels HTTP/HTTPS from localhost to a public `*.nport.link` URL over Cloudflare's edge. It is free, MIT-licensed, and **account-free** — no signup, no API keys, `nport 3000 -s myapp` and you have a URL. v3 is a from-scratch rewrite that replaces the bundled `cloudflared` binary with a native Rust implementation of Cloudflare's tunnel connector protocol.

**Status: staging is live and real tunnels serve traffic on macOS, Linux and Windows** (2026-08-06), with WebSocket and server-enforced expiry, verified per deploy by `.github/workflows/smoke.yml`. Gate G2 is five of six: the gap is graceful Ctrl+C on Windows, where there is no `SIGINT` to send a child process. **Phase 5 (federation) is deployed to staging** — ADR-0049 reshaped its topology mid-phase to one hostname per deployment, a gateway dispatching over service bindings, and liveness inverted from registry-pull to node-push, and a real client has discovered a node through the directory and tunnelled through it. G5 is open on a **second** node, not on code. `apps/web` is 2c code-complete, visual baselines included; what is left there is the deploy. `apps/desktop` is still a booting scaffold. `docs/ROADMAP.md` § Backend first is the live list.

## The apps

| Path | Name | Runtime | Deploys to | Purpose |
| --- | --- | --- | --- | --- |
| `apps/web` | `@nport/web` | Next.js + OpenNext | Worker `nport-web` → nport.link | Marketing site + user docs |
| `apps/gateway` | `@nport/gateway` | Hono on Workers | Worker `nport-gateway` → api.nport.link | **The only public backend Worker.** Shared middleware, dispatch by path |
| `apps/node` | `@nport/node` | Hono on Workers | Worker `nport-node`, service binding `NODE` | A **node**: provisions tunnels. No route of its own |
| `apps/registry` | `@nport/registry` | Hono on Workers | Worker `nport-registry`, service binding `REGISTRY` | The node directory. No credentials, no route, fetches no node. Master deployments only |
| `apps/desktop` | `@nport/desktop` | Tauri v2 (Rust + React) | signed installers | GUI + local traffic inspector |
| `crates/cli` | `nport` | native Rust binary | npm, crates.io, Homebrew, Scoop, Releases | The CLI everyone uses |

## Invariants

Do not violate these without adding an ADR to `docs/DECISIONS.md` first.

1. **No accounts, no auth, no signup — ever.** No user database, no dashboard, no login. Abuse control happens without identity.
2. **No `cloudflared` binary is shipped or downloaded** by the default build. The connector is native Rust.
3. **The server is authoritative for all time limits and ownership.** Clients display; they never enforce.
4. **No secret ever ships in a client artifact** — no API keys, no analytics secrets, no tokens in argv.
5. **`crates/core` is headless.** No `println!`, no `eprintln!`, no `process::exit`, no TTY detection. It emits events; `crates/cli` renders them.
6. **Generated files are never hand-edited.** They carry a `@generated` banner and CI fails on drift.
7. **The public API contract lives only in `packages/contract`.** Routes, schemas, and error codes are defined there and generated outward.
8. **Never delete a Cloudflare DNS record you cannot prove you own** (see `docs/ARCHITECTURE.md` §7).

## Repo map

```
apps/gateway/      the public front door; the only routed Worker → apps/gateway/CLAUDE.md
apps/node/          a node: one Cloudflare account + zone   → apps/node/CLAUDE.md
apps/registry/     the node directory, no credentials      → apps/registry/CLAUDE.md
apps/web/          Next.js site + user docs    → apps/web/CLAUDE.md
apps/desktop/      Tauri app                   → apps/desktop/CLAUDE.md
crates/cli/        the `nport` binary          → crates/CLAUDE.md
crates/core/       TunnelManager, headless     → crates/CLAUDE.md
crates/protocol/   connector wire protocol     → crates/protocol/CLAUDE.md
crates/contract/   Rust API mirror; generated.rs generated, subdomain.rs hand-written
crates/xtask/      codegen, fixtures, verify-docs
packages/contract/ zod + OpenAPI + errors — API AUTHORITY
packages/worker-kit/     envelope, proof of work, source identity, forwarded headers — all three Workers
packages/design-tokens/  tokens.css, shared by web + desktop
packages/tsconfig/ shared tsconfig bases
schema/            GENERATED: two OpenAPI docs, error registry, subdomain rules
infra/terraform/   staging + prod infrastructure → docs/DEPLOYMENT.md
docs/              contributor docs (user docs live in apps/web/src/content/docs)
docs/mockup/       approved UI design — reference only: never edited, imported, or checked
```

Dependency direction is one-way: `protocol → core → {cli, desktop}`, and `contract → core`. A `core → cli` edge is the most likely architectural regression — don't introduce one.

## Commands

`pnpm dev` brings every surface up and provisions offline against an in-memory Cloudflare — `docs/CONTRIBUTING.md` § Dev loop.

```bash
corepack enable && pnpm install    # bootstrap; also installs the git hooks
pnpm dev                           # gateway :8787 + node + registry + web + desktop, at once
pnpm dev:cli                       # tunnel the local site through the local gateway
pnpm dev:gateway  dev:node  dev:registry  dev:web  dev:desktop   # one surface at a time
cargo run -p nport -- 3000 -s test # run the CLI
pnpm test          cargo test      # tests
pnpm lint          cargo clippy    # lint
pnpm codegen       cargo xtask codegen   # regenerate; must leave the tree clean
```

## Where to look

| If the task is… | Read, in this order |
| --- | --- |
| Running the whole thing locally | `docs/CONTRIBUTING.md` § Dev loop |
| Anything touching the connector wire format | `docs/PROTOCOL.md` → `crates/protocol/CLAUDE.md` |
| Add or change an API endpoint | `docs/API.md` → `packages/contract/` → `apps/node/CLAUDE.md` |
| The node directory, federation, or anything crossing between two Workers | ADR-0031 → ADR-0049 → `apps/gateway/CLAUDE.md` → `apps/registry/CLAUDE.md` |
| Add or change an error | `docs/ERRORS.md` → `packages/contract/src/errors.ts`, then regenerate |
| CLI flags, output, i18n | `crates/CLAUDE.md` → `crates/cli/src/` |
| Tunnel lifecycle logic | `docs/ARCHITECTURE.md` §3 → `crates/core/src/tunnel.rs` |
| Any UI — site or desktop | `docs/mockup/README.md` → that app's `CLAUDE.md` → `packages/design-tokens/` |
| Storage, leases, expiry, abuse | `docs/ARCHITECTURE.md` §4–§7 → `apps/node/src/do/` |
| Scaling past one account, or running a node | ADR-0031 → `docs/ARCHITECTURE.md` §1 → `docs/ADDING_A_NODE.md` |
| Why it is built this way, or what v2 got wrong | `docs/DECISIONS.md` (ADR-0001), `docs/ARCHITECTURE.md` §8 |
| Tests | `docs/TESTING.md` |
| Releasing or publishing | `docs/RELEASE.md` |
| Production incident, secrets, DNS | `docs/OPERATIONS.md` |
| What to build next | `docs/ROADMAP.md` |

## Documentation rules

1. **`CLAUDE.md` files are imperative and navigational** — commands, invariants, where to look. Root ≤130 lines, per-app ≤90.
2. **`docs/*.md` are descriptive and specificational** — how and why. Never restate a command that lives in a `package.json` or a `CLAUDE.md`.
3. **A fact appears exactly once.** If two files need it, one links to the other. If it must live in two places, generate it.
4. **User-facing docs live in `apps/web/src/content/docs/*.mdx` and nowhere else.** `docs/` is contributor-only.
5. **Anything a human and a program must both agree on is generated** — error codes, API fields, the subdomain rules, and the CLI flag reference (`schema/cli.json`, from `Args::command()`). The reference had been *claimed* generated by three files for weeks before it was (defect 38); the page that renders it is still owed.

## Conventions

@docs/conventions/typescript.md
@docs/conventions/rust.md

Commits are conventional: `type(scope): description` with types `feat|fix|docs|refactor|test|chore` and scopes `gateway|node|registry|web|desktop|cli|core|protocol|contract|ci|docs`. The first three arrived with ADR-0049. **`api` is not a scope** — it named the node service before the rename, so it appears throughout the history and in no new commit. Branches are prefixed `feature/`, `fix/`, `docs/`, `refactor/`, `protocol/`.

Every user-visible failure carries a code from the registry in `packages/contract`. Never match on an error message string — that was v2's central design mistake (see ADR-0018).

## Definition of done

- `pnpm lint && pnpm test && cargo clippy && cargo test` pass
- `pnpm codegen && cargo xtask codegen` leave the tree clean
- docs updated if you touched anything a doc's `applies_to:` globs cover
- an ADR added for any architecture or dependency decision
- commit message follows the convention above

## Prior implementation

v2 lives on `main` and is not checked out here. Consult it without switching branches:

```bash
git ls-tree -r main --name-only
git show main:server/src/index.ts     # the v2 Worker — source of the R1–R11 defect list
git show main:src/tunnel.ts           # the v2 tunnel orchestrator
```

Treat v2's choices as history, not constraints. `docs/DECISIONS.md` records what was rejected and why, so you don't need to re-derive it.
