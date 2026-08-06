# CLAUDE.md

Guidance for Claude Code working in this repository. Read this file first; it tells you where everything else is.

## Project

NPort tunnels HTTP/HTTPS from localhost to a public `*.nport.link` URL over Cloudflare's edge. It is free, MIT-licensed, and **account-free** — no signup, no API keys, `nport 3000 -s myapp` and you have a URL. v3 is a from-scratch rewrite that replaces the bundled `cloudflared` binary with a native Rust implementation of Cloudflare's tunnel connector protocol.

**Status: staging is live and the first tunnel has served traffic** (2026-08-06). `nport 8099 -s demo-g2 --backend https://api.nport.online` provisioned, brought up four HA connections to Cloudflare's edge, returned a byte-identical body over HTTP/2, and tore down leaving NXDOMAIN. That was **macOS and HTTP only** — Gate G2 also wants Linux, Windows, WebSocket and server-enforced expiry, so it is not closed. `apps/web` and `apps/desktop` are still booting scaffolds. `docs/ROADMAP.md` § The critical path.

## The four apps

| Path | Name | Runtime | Deploys to | Purpose |
| --- | --- | --- | --- | --- |
| `apps/web` | `@nport/web` | Next.js + OpenNext | Worker `nport-web` → nport.link | Marketing site + user docs |
| `apps/api` | `@nport/api` | Hono on Workers | Worker `nport-api` → api.nport.link | Control plane: provisions tunnels |
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
apps/api/          Hono control plane, one Cloudflare account + zone → apps/api/CLAUDE.md
(apps/registry/    the node directory — Phase 5, **next**: ADR-0031 + ADR-0044, not yet written)
apps/web/          Next.js site + user docs    → apps/web/CLAUDE.md
apps/desktop/      Tauri app                   → apps/desktop/CLAUDE.md
crates/cli/        the `nport` binary          → crates/CLAUDE.md
crates/core/       TunnelManager, headless     → crates/CLAUDE.md
crates/protocol/   connector wire protocol     → crates/protocol/CLAUDE.md
crates/contract/   Rust API mirror; generated.rs generated, subdomain.rs hand-written
crates/xtask/      codegen, fixtures, verify-docs
packages/contract/ zod + OpenAPI + errors — API AUTHORITY
packages/design-tokens/  tokens.css, shared by web + desktop
packages/tsconfig/ shared tsconfig bases
schema/            GENERATED OpenAPI, error registry, subdomain rules
infra/terraform/   staging + prod infrastructure → docs/DEPLOYMENT.md
docs/              contributor docs (user docs live in apps/web/src/content/docs)
docs/mockup/       the approved UI design — check web and desktop against it. Reference only:
                   never edited by hand, never imported, excluded from every check
```

Dependency direction is one-way: `protocol → core → {cli, desktop}`, and `contract → core`. A `core → cli` edge is the most likely architectural regression — don't introduce one.

## Commands

`pnpm dev` brings every surface up and provisions offline against an in-memory Cloudflare — `docs/CONTRIBUTING.md` § Dev loop.

```bash
corepack enable && pnpm install    # bootstrap; also installs the git hooks
pnpm dev                           # api + web + desktop, all at once
pnpm dev:cli                       # tunnel the local site through the local control plane
pnpm dev:api                       # wrangler dev on apps/api
pnpm dev:web                       # next dev with Worker bindings
pnpm dev:desktop                   # tauri dev
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
| Add or change an API endpoint | `docs/API.md` → `packages/contract/` → `apps/api/CLAUDE.md` |
| Add or change an error | `docs/ERRORS.md` → `packages/contract/src/errors.ts`, then regenerate |
| CLI flags, output, i18n | `crates/CLAUDE.md` → `crates/cli/src/` |
| Tunnel lifecycle logic | `docs/ARCHITECTURE.md` §3 → `crates/core/src/tunnel.rs` |
| Website content, SEO, styling | `docs/mockup/README.md` → `apps/web/CLAUDE.md` → `packages/design-tokens/` |
| Desktop UI or IPC | `docs/mockup/README.md` → `apps/desktop/CLAUDE.md` |
| Storage, leases, expiry, abuse | `docs/ARCHITECTURE.md` §4–§7 → `apps/api/src/do/` |
| Scaling past one Cloudflare account | ADR-0031 → `docs/ARCHITECTURE.md` §1 → `docs/ROADMAP.md` Phase 5 |
| "Why is it built this way?" | `docs/DECISIONS.md` |
| Tests | `docs/TESTING.md` |
| Releasing or publishing | `docs/RELEASE.md` |
| Production incident, secrets, DNS | `docs/OPERATIONS.md` |
| What to build next | `docs/ROADMAP.md` |
| What v2 did and why it was wrong | `docs/DECISIONS.md` ADR-0001, `docs/ARCHITECTURE.md` §8 |

## Documentation rules

1. **`CLAUDE.md` files are imperative and navigational** — commands, invariants, where to look. Root ≤130 lines, per-app ≤90.
2. **`docs/*.md` are descriptive and specificational** — how and why. Never restate a command that lives in a `package.json` or a `CLAUDE.md`.
3. **A fact appears exactly once.** If two files need it, one links to the other. If it must live in two places, generate it.
4. **User-facing docs live in `apps/web/src/content/docs/*.mdx` and nowhere else.** `docs/` is contributor-only.
5. **Anything a human and a program must both agree on is generated** — error codes, API fields, the CLI flag reference.

## Conventions

@docs/conventions/typescript.md
@docs/conventions/rust.md

Commits are conventional: `type(scope): description` with types `feat|fix|docs|refactor|test|chore` and scopes `api|web|desktop|cli|core|protocol|contract|ci|docs`. Branches are prefixed `feature/`, `fix/`, `docs/`, `refactor/`, `protocol/`.

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
