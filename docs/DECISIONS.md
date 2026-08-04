# Decisions

Append-only log of architecture decisions. **Read this before proposing a change to anything it covers** — these are settled, and re-litigating them wastes time.

Format: one screen maximum per entry. Anything longer becomes its own document that the entry links to. Never edit a decision's Context or Decision after it is accepted; supersede it with a new entry instead.

New entries: next number, status `Accepted`, and a one-line entry in the index.

| # | Decision | Status |
| --- | --- | --- |
| 0001 | Rewrite as v3 from scratch | Accepted |
| 0002 | Reimplement the connector protocol in Rust; ship no `cloudflared` | Accepted |
| 0003 | Rust for the CLI | Accepted |
| 0004 | Tauri v2 for the desktop app | Accepted |
| 0005 | Hono on Workers for the API | Accepted |
| 0006 | Next.js + OpenNext on Workers, retiring Pages | Accepted |
| 0007 | Account-free forever | Accepted |
| 0008 | One monorepo: pnpm + Cargo workspaces | Accepted |
| 0009 | zod-first API contract, generated into Rust | Accepted |
| 0010 | No shared React UI package; share design tokens only | Accepted |
| 0011 | Durable Objects with SQLite for lease state | Accepted |
| 0012 | Distribute through every channel; npm via optional platform packages | Accepted |
| 0013 | Biome replaces ESLint + Prettier | Accepted |
| 0014 | Tailwind v4, CSS-first tokens | Accepted |
| 0015 | One GA4 property; no CLI analytics by default | Accepted |
| 0016 | Delete `TODO.md`; GitHub Issues + ROADMAP replace it | Accepted |
| 0017 | HTTP/2 transport as protocol fallback; `cloudflared` shim as last resort | Accepted |
| 0018 | Machine-readable error codes; never match on message strings | Accepted |
| 0019 | Locale auto-detection; never prompt | Accepted |
| 0020 | Datagrams out of scope for 3.0 | Accepted |
| 0021 | shadcn/ui + TanStack Virtual for the desktop frontend | Accepted |
| 0022 | Phase 0 toolchain: exact pins, lefthook, root-level Biome | Accepted |
| 0023 | Frontend e2e with visual regression; tests enforced by a Stop hook | Accepted |
| 0024 | Confine `capnp-rpc`'s non-`Send` region behind a thread boundary | Accepted |
| 0025 | A purpose-built Rust emitter instead of `typify` | Accepted |
| 0026 | Derived tunnel names are the saga's idempotency key | Accepted |
| 0027 | Redeemed proof-of-work challenges are recorded | Accepted |
| 0028 | Proof-of-work difficulty escalates per source, not globally | Accepted |

---

## ADR-0001 — Rewrite as v3 from scratch

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2 (`main`) worked and had 668 stars, but its foundations were wrong in ways that could not be patched incrementally: the backend had no storage, so ownership, timing, and liveness were all inferred from the Cloudflare API; the error taxonomy was string prefixes inside HTTP 500; and the CLI was a Node wrapper supervising a Go binary by scraping its stderr. Fixing any one of these meant changing all of them.

**Decision.** Rewrite all four surfaces on the `v3-new-architect` branch. Keep the product promise (one command, custom subdomain, free, no account) and the brand; keep nothing else.

**Consequences.** A long period with no shippable artifact, mitigated by the phased roadmap and gates in `docs/ROADMAP.md`. v2 stays deployed and supported until Phase 5 sunset. Existing users keep `npm i -g nport` working (ADR-0012).

**Rejected.** Incremental migration — the storage and error-taxonomy changes are breaking and touch every component, so incrementalism buys nothing.

---

## ADR-0002 — Reimplement the connector protocol in Rust; ship no `cloudflared`

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2 downloaded a ~50 MB Go binary from `releases/latest` with **no checksum verification**, cached it inside the npm package directory, and accreted five layers of permission workarounds across 2.1.3–2.1.5 (Windows `spawn UNKNOWN`, Linux `EACCES`, root-owned files after `sudo npm i -g`). It inferred tunnel health by substring-matching stderr and passed the tunnel token in argv, where any local user could read it via `ps`. Traffic inspection was impossible because the tunnel was opaque.

**Decision.** Implement the Cloudflare Tunnel connector protocol natively in `crates/protocol`. No `cloudflared` binary is shipped or downloaded by the default build.

**Consequences.** The highest-risk decision in v3, made deliberately. Deletes an entire class of bugs, yields a single static binary, and makes traffic inspection free — but we now own a protocol Cloudflare can change without notice, and a break affects every installed client at once (`docs/ARCHITECTURE.md` §5). Mitigated by `protocol-canary.yml`, the ADR-0017 fallback ladder, and gate G1.

**Accepted legal risk.** cloudflared is Apache-2.0, which permits reimplementation and copying its `.capnp` schema with attribution and NOTICE. The *edge service*, however, is governed by [cloudflare.com/terms](https://www.cloudflare.com/terms/), and the client licence does not by itself authorize connecting a non-Cloudflare client to Cloudflare's edge. No technical measure against third-party clients exists in the source. This is a maintainer's business decision, knowingly accepted, and noted in the README so contributors are not surprised.

**Rejected.** Continuing to supervise `cloudflared` (not a native app, keeps every bug above); CGO-linking it (worst of both).

---

## ADR-0003 — Rust for the CLI

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2's CLI needed Node ≥20, shipped an esbuild bundle plus a downloaded binary, and paid Node's startup cost on every invocation.

**Decision.** Rewrite the CLI in Rust as a single static binary.

**Consequences.** No runtime dependency, fast startup, and the same language as the connector — so `crates/core` is shared with the desktop app instead of reimplemented. Cross-compilation for 8 targets becomes a release-pipeline concern (`docs/RELEASE.md`). Contributors need a Rust toolchain.

---

## ADR-0004 — Tauri v2 for the desktop app

**Date** 2026-08-03 · **Status** Accepted

**Context.** Not every user wants a terminal, and the native connector makes a traffic inspector nearly free — `crates/core` already sees every request.

**Decision.** Build `apps/desktop` with Tauri v2: Rust backend linking `crates/core` directly, React frontend in the system WebView.

**Consequences.** Small installers, no bundled Chromium, and zero duplicated tunnel logic. Costs per-platform signing and notarization, and WebView differences across platforms. Deliberately built last (`docs/ROADMAP.md` Phase 4) so it consumes a stable `core` API.

**Rejected.** Electron (bundle size, and it would not share `core`).

---

## ADR-0005 — Hono on Workers for the API

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2's Worker had no router at all — it dispatched on HTTP method, so `POST /` created a tunnel and `POST /anything` did too. No versioning, no `/health`.

**Decision.** Hono on Cloudflare Workers, with real path routing under `/v1`, and `@hono/zod-validator` wired to the ADR-0009 contract.

**Consequences.** Proper routing, middleware, and per-route validation. Stays on Workers, so Durable Objects (ADR-0011) are available. A legacy shim keeps v2's method dispatch alive until sunset.

---

## ADR-0006 — Next.js + OpenNext on Workers, retiring Pages

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2's site was `home.html` minified into a **committed** `index.html` artifact by a custom `minify.js`. CI ran `npm run minify` but never `build:css`, and the CSS it inlined was gitignored — so deploys depended on a file that had to have been built locally.

**Decision.** Next.js deployed to a Worker via `@opennextjs/cloudflare`. Retire the `nport-site` Pages project.

**Consequences.** Real component structure, MDX user docs, and generated error-code pages. No committed build output. Both surfaces now run on Workers, so one deploy story. Requires an apex DNS cutover — checklist in `docs/OPERATIONS.md`.

---

## ADR-0007 — Account-free forever

**Date** 2026-08-03 · **Status** Accepted

**Context.** Accounts would enable reserved subdomains, longer tunnels, and a dashboard. They would also require a user database, auth, password resets, GDPR obligations, and would break the `npx nport 3000` pitch the project is known for.

**Decision.** No accounts, no auth, no signup — ever. The site stays marketing plus docs; the desktop app is local-only.

**Consequences.** Abuse control must work without identity, which forces the proof-of-work and `ownerToken` design in `docs/ARCHITECTURE.md` §7. No reserved subdomains, no premium tier, no dashboard. Zero user data to leak and no auth code to get wrong.

**Rejected.** Optional accounts — every "optional" auth system becomes load-bearing, and it would put a user database in a project whose main privacy property is not having one.

---

## ADR-0008 — One monorepo: pnpm + Cargo workspaces

**Date** 2026-08-03 · **Status** Accepted

**Context.** Four deliverables share an API contract and a brand; two share `crates/core`.

**Decision.** One repository. pnpm workspace over `apps/*` and `packages/*`; Cargo workspace over `crates/*` and `apps/desktop/src-tauri`. Turborepo kept thin — five tasks.

**Consequences.** One CLAUDE.md set, one CI, atomic cross-language changes. `apps/desktop` belongs to **both** workspaces, which surprises people and is called out in `apps/desktop/CLAUDE.md`. Turbo's real payoff is `--filter=...[origin/main]`, replacing v2's hand-maintained `paths:` blocks.

**Rejected.** Separate repos — the wire contract would need cross-repo versioning, and there would be no single entry point for an agent.

---

## ADR-0009 — zod-first API contract, generated into Rust

**Date** 2026-08-03 · **Status** Accepted

**Context.** Three consumers must agree on the API: the Rust CLI, the TS Worker, and the website. v2 had no shared definition, so the CLI matched error strings the server produced by convention.

**Decision.** `packages/contract` is the single authority: zod schemas, route definitions, and the error registry. It generates `schema/nport-api.openapi.json`, which generates `crates/contract` via `typify`. CI fails on drift.

The general rule: **the authority for a boundary is whichever side owns the invariants.** The server validates input, so the API contract is TS-first. Rust owns Tauri IPC command signatures, so that boundary generates the other way (`tauri-specta`). The connector wire protocol is Rust-only and hand-written — TS never speaks it.

**Consequences.** One definition yields runtime validation, TS types, OpenAPI, and Rust types. Two codegen tools, justified because the rule picking between them is one sentence.

**Rejected.** `ts-rs`/`schemars`/`specta` as the API authority — they emit types only, leaving hand-written validators to drift from generated types, which is exactly the bug class v2 shipped. TypeSpec — a third toolchain for six endpoints.

---

## ADR-0010 — No shared React UI package; share design tokens only

**Date** 2026-08-03 · **Status** Accepted

**Context.** `apps/web` and `apps/desktop` are both React, which suggests a `packages/ui`.

**Decision.** No `packages/ui`. Share `packages/design-tokens` — plain CSS holding the palette as a Tailwind v4 `@theme` block plus font declarations.

**Consequences.** Brand stays in lockstep with zero component coupling and no build step. The two targets have almost nothing genuinely in common: the site is RSC/SSR on workerd, SEO-critical, preferring zero client JS, with marketing sections that will never be reused; the desktop app is a CSR SPA in a WebView whose components are a virtualized request table and a JSON tree viewer. A shared library would impose a build step and a lowest-common-denominator API to share perhaps three primitives. Promoting a shared package later is cheap; untangling a premature one is not.

---

## ADR-0011 — Durable Objects with SQLite for lease state

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2 stored nothing. Ownership was "a tunnel with this name exists", expiry was the CF API's `created_at`, and liveness was CF's `status` field. This caused subdomain takeover, concurrent-create races, a bypassable client-side time limit, and a cleanup ceiling of ~480 teardowns/day.

**Decision.** A `SubdomainLease` Durable Object per normalized subdomain (`idFromName`), plus a singleton `Registry` DO, both SQLite-backed.

**Consequences.** A DO is single-threaded, so concurrent claims for one subdomain serialize by construction — no locking protocol, no CAS loop, no race. Per-object alarms make expiry self-driven, so teardown scales with tunnel count. SQLite-backed DOs are free-plan eligible (Apr 2025). Requires a migration entry in `wrangler.jsonc`, and DO alarms are at-least-once, so handlers must be idempotent.

**Rejected.** KV — eventually consistent with no compare-and-set, so it cannot prevent a double-claim. D1 alone — `UNIQUE` gives atomicity but D1 has no timers, putting expiry back on the cron and reintroducing the ceiling.

---

## ADR-0012 — Distribute through every channel; npm via optional platform packages

**Date** 2026-08-03 · **Status** Accepted

**Context.** `npm i -g nport` is how every existing user installs, and the npm listing is a real discovery channel. But v2's postinstall downloaded a binary, which is why its own CI had to run `npm ci --ignore-scripts`.

**Decision.** Ship through npm, crates.io, a Homebrew tap, Scoop, and GitHub Releases with build-provenance attestation. On npm, publish eight `@nport/cli-<platform>` packages and list them as `optionalDependencies` of `nport`, whose `bin` is a small shim resolving and spawning the right one. **No postinstall.**

**Consequences.** `npm i -g nport` keeps working unchanged, install needs no network beyond the registry, `--ignore-scripts` works, and results cache. This is the esbuild/swc model. Costs a nine-package publish ordering (platforms before shim), generated by `cargo xtask npm-packages`. One deliberate fallback: if no platform package resolves, fetch from Releases with SHA-256 verification **on first invocation, not at install** — confining the failure to exotic platforms and never breaking CI.

**Rejected.** `cargo-dist` for the npm layer — its npm installer uses a postinstall downloader, the exact thing being escaped. Still reasonable for shell/PowerShell installers later.

---

## ADR-0013 — Biome replaces ESLint + Prettier

**Date** 2026-08-03 · **Status** Accepted

**Decision.** Biome as the sole formatter and linter for all TS/TSX/JSON/JSONC.

**Consequences.** One binary, one config, fast, with native JSONC support (needed for `wrangler.jsonc`). `useImportType` and import organization encode v2's conventions mechanically instead of in prose. Loses `@next/eslint-plugin-next`, an acceptable trade for a marketing site rather than running two Node linting toolchains.

---

## ADR-0014 — Tailwind v4, CSS-first tokens

**Date** 2026-08-03 · **Status** Accepted

**Decision.** Tailwind v4 via `@tailwindcss/postcss`, no `tailwind.config.js`. v2's palette moves verbatim into `packages/design-tokens/tokens.css` as `@theme`; v3's `darkMode: 'class'` becomes `@custom-variant dark (&:where(.dark, .dark *))`.

**Consequences.** Both React targets share **one plain-CSS token file** instead of importing a JS config object across a workspace boundary — no duplicated theme config, and no build-order dependency between `packages/design-tokens` and its consumers. Requires Tailwind v4 idioms rather than v3 config objects.

> Corrected by ADR-0021. This entry originally claimed the token format let `apps/desktop` consume the palette *with no Tailwind build*. That is wrong: the desktop app runs its own Tailwind v4 build. The CSS-first choice is still right, for the reason stated above.

---

## ADR-0015 — One GA4 property; no CLI analytics by default

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2's site loaded **two** GA4 properties (gtag `G-JJHG4DP1K9` and Firebase `G-8MYXZL6PGD`), double-counting every visit, with a Firebase web API key committed in HTML. The CLI sent analytics **on by default with no notice**, and shipped both the GA4 measurement ID *and its API secret* in the published bundle, with a `client_id` derived from hostname and home directory.

**Decision.** One GA4 property on the website. The CLI ships **no** analytics. If usage counting is ever wanted, it is a coarse opt-in `NPORT_TELEMETRY=1` counter with no machine identifier.

**Consequences.** Less usage data, which for an account-free privacy-oriented tool is the right trade. Retires one GA4 property; note the retirement in `docs/OPERATIONS.md`. No secret ever lives in a client artifact (invariant 4).

---

## ADR-0016 — Delete `TODO.md`; GitHub Issues + ROADMAP replace it

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2's `TODO.md` had multi-hundred-line entries duplicating `docs/`, and referenced paths like `packages/cli/src/tunnel.ts` and `server/src/index.js` that did not exist in the tree.

**Decision.** No `TODO.md`. `docs/ROADMAP.md` holds phases and gates only; individual work is GitHub Issues labelled `phase-N`.

**Consequences.** A flat markdown task file in a repo with an issue tracker always rots. Issues give assignment, discussion, and PR links for free.

---

## ADR-0017 — HTTP/2 transport as protocol fallback; `cloudflared` shim as last resort

**Date** 2026-08-03 · **Status** Accepted

**Context.** ADR-0002 is high-risk, and gate G1 might fail. Discovering that with no fallback would sink the release.

**Decision.** A two-rung ladder, designed in from the first commit so no rung is a rewrite.

1. **HTTP/2 transport.** cloudflared's own automatic fallback from QUIC, so the edge supports it. It shares the entire registration, capnp, and metadata layer with QUIC but needs no QUIC stack — sidestepping post-quantum TLS, datagrams, and `quinn`↔`quic-go` interop at once. `crates/protocol/src/h2.rs` implements the same `Transport` trait.
2. **`CloudflaredConnector`.** `crates/core::connector::Connector` is a trait from the first commit, with `NativeConnector` and a feature-gated `CloudflaredConnector` that downloads and spawns the Go binary.

**Consequences.** If G1 fails, 3.0 ships with `CloudflaredConnector` as default and `--experimental-native` opt-in, and **everything else in v3 — the Rust CLI, Hono API, Next.js site, Tauri app, and every v2 fix — ships on schedule.** The trait boundary costs roughly 80 lines and buys the entire release. `h2.rs` must keep compiling even while unused.

**Rejected.** CGO-linking cloudflared; a self-hosted non-Cloudflare data plane (both change the cost model and the value proposition).

---

## ADR-0018 — Machine-readable error codes; never match on message strings

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2 returned **HTTP 500 for everything** — including "subdomain in use", "subdomain reserved", and malformed JSON — with the taxonomy encoded as prefixes inside the human-readable message. The CLI matched with `String.includes` against `'SUBDOMAIN_PROTECTED:'`, `'currently in use'`, `'already exists and is currently active'`, and `'[1013]'`. Changing any message broke the client, and `api.ts` built chalk-coloured English help text inside `Error.message`, bypassing i18n entirely.

**Decision.** Every error is `{error:{code, message, details?, requestId, docsUrl}}` with a correct HTTP status. Codes are one enum in `packages/contract`, generated into Rust and into `docs/ERRORS.md`. **Clients match the code, never the message.** All presentation and translation happen in `crates/cli`; `crates/core` never formats for humans.

**Consequences.** Messages become freely editable and translatable. Every error gets a stable documentation anchor the CLI can link to.

---

## ADR-0019 — Locale auto-detection; never prompt

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2 blocked first run on an interactive `readline` language prompt with **no TTY check**, so it hung in CI, Docker, and any non-interactive pipeline. Worse, it ran *before* the `--version` check, so `nport -v` hung on a fresh install.

**Decision.** Keep en/vi/es. Resolve in order: `--lang` → `NPORT_LANG` → config file → `$LC_ALL`/`$LC_MESSAGES`/`$LANG` on Unix, `GetUserDefaultLocaleName` on Windows → `en`. **Never prompt.** Nothing blocks `--help` or `--version`.

**Consequences.** Keeps the multilingual reach the README advertises while deleting a whole class of hangs. Language becomes a config value users set explicitly, not something the tool interrogates them about.

---

## ADR-0020 — Datagrams out of scope for 3.0

**Date** 2026-08-03 · **Status** Accepted

**Context.** The connector protocol carries UDP and ICMP over QUIC datagrams, in two incompatible framings (v2 suffixes metadata; v3 prefixes a type byte) plus a `SessionManager` RPC surface.

**Decision.** HTTP and WebSocket only. Advertise `support_datagram_v2` and never send or expect a datagram.

**Consequences.** Removes a large fraction of the protocol from the Phase 1 spike, materially improving the odds at gate G1. NPort has never supported TCP/UDP tunnelling, so nothing regresses. Revisit only after the native connector is proven in production.

---

## ADR-0021 — shadcn/ui + TanStack Virtual for the desktop frontend

**Date** 2026-08-03 · **Status** Accepted

**Context.** ADR-0004 chose Tauri v2 with a React frontend and ADR-0014 chose Tailwind v4, but no component library was named — leaving the two hardest pieces of `apps/desktop` unspecified. Its real UI is not a marketing page: a virtualized request table over a ring buffer that can hold thousands of exchanges, a JSON tree viewer, keyboard-driven navigation, and a tray menu.

**Decision.** React with **shadcn/ui** (Radix primitives, components copied into the repo as source) and **TanStack Virtual** for the request table. The JSON tree viewer is hand-written. `apps/desktop` runs its own Tailwind v4 build over `packages/design-tokens`.

**Consequences.**

- shadcn components are **vendored source, not a dependency**, styled with Tailwind utilities that read our `@theme` tokens directly. Nothing to reconcile against a third-party theme provider, and no runtime CSS-in-JS in a WebView.
- Radix gives accessible primitives and keyboard navigation, which the app's design already promises rather than treats as optional.
- `src/components/ui/` is vendored upstream code. It is exempt from the usual "don't vendor" instinct but **not** from review — upgrades are manual and deliberate.
- **This corrects ADR-0014**, which claimed the CSS-first token format let the desktop app skip a Tailwind build. It does not; shadcn components are Tailwind utility classes. The token file is still shared as plain CSS and each target builds Tailwind over it.
- WebKitGTK is the oldest of the three engines we ship against, so very recent CSS needs checking on Linux before release. shadcn's output is conservative enough that this rarely bites.

**Rejected.** *Mantine, MUI, Chakra* — each ships a theming system that would have to be made to agree with `packages/design-tokens` instead of simply consuming it, plus a runtime styling cost (ADR-0010). *Svelte 5* — genuinely smaller and faster in a WebView, but a second framework alongside the Next.js site doubles the idiom surface for a solo maintainer, and the desktop app is Phase 4, so it is the code touched least often and remembered worst. *Off-the-shelf JSON viewers* — all bring styling that would be overridden anyway, for a recursive component over a value whose shape we already control.

---

## ADR-0022 — Phase 0 toolchain: exact pins, lefthook, root-level Biome

**Date** 2026-08-03 · **Status** Accepted

**Context.** Earlier ADRs named tools (Biome, Turborepo, pnpm, Tailwind v4) but not versions, and Phase 0 has to choose several things no ADR covers. Left unrecorded, the next contributor re-derives them or drifts.

**Decision.** Versions are pinned exactly, not by range:

| | Version | Where |
| --- | --- | --- |
| pnpm | `10.34.5` | `packageManager`, via Corepack |
| Node | `24` for dev and CI | `.nvmrc`; `engines` floor is `>=22.12.0` |
| Rust | `1.97.1` exact, MSRV `1.85` | `rust-toolchain.toml` |
| TypeScript | `7.0.2` | `pnpm-workspace.yaml` catalog |
| Biome | `2.5.6` | root `devDependencies` |
| Turborepo | `2.10.8` | root `devDependencies` |
| Vitest | `4.1.10` | catalog; matches `@cloudflare/vitest-pool-workers` 0.20's peer range |
| lefthook | `2.1.10` | root `devDependencies` |

Plus six calls worth writing down:

- **`engines.node` is `>=22.12.0`, not `>=24`.** 24 is what `.nvmrc` and CI use; the floor is the oldest version that actually works, so a contributor on the previous LTS is not blocked by a number rather than a real incompatibility.
- **`pnpm lint` is one root-level Biome pass, not a Turborepo task.** One process over every file beats orchestrating several and needs no per-package config, so Turbo owns four tasks — `build`, `typecheck`, `test`, `codegen`.
- **pnpm `catalog:` is the JS analogue of `[workspace.dependencies]`.** Same rule in both languages: a version is declared once at the root.
- **`minimumReleaseAge: 1440`.** No dependency is installed within a day of publication. A compromised release is usually yanked within hours, and nothing here needs a package the day it ships.
- **lefthook, and it enforces the commit format.** One Go binary, no Node startup per hook, and it runs Biome and `cargo fmt` jobs in parallel from one config. A `commit-msg` job checks `type(scope): description` because `git-cliff` builds `CHANGELOG.md` from those subjects, so the format is load-bearing rather than a style preference. The `cargo fmt` job is guarded on `cargo` existing, so a docs- or web-only contributor needs no Rust toolchain to commit.
- **`crates/core` denies `clippy::print_stdout`, `print_stderr`, and `exit` in its crate root.** Invariant 5 was previously a rule someone had to remember; now the build enforces it.

**Consequences.** Every crate carries `publish = false` until Phase 3, so an empty stub cannot reach crates.io by accident. The rustls crypto provider is deliberately *not* pinned — offering `X25519MLKEM768` needs aws-lc-rs but the two musl release targets are where that linkage breaks, so Phase 1 decides it with evidence (`docs/PROTOCOL.md` §5, risk P3). TypeScript 7 is the current release and nothing consumes it yet; if Next.js or OpenNext disagree in Phase 2c, that is a catalog edit, not a decision to revisit.

**Rejected.** *Version ranges* — a caret range means CI and a contributor's machine can run different linters, and "works on mine" is the failure this repo can least afford. *husky* — a Node process per hook, and its config is shell scripts in a directory rather than one file. *Per-package Biome configs* — nothing to configure differently, and four more files to keep in sync.

---

## ADR-0023 — Frontend e2e with visual regression; tests enforced by a Stop hook

**Date** 2026-08-03 · **Status** Accepted · **Supersedes** part of `docs/TESTING.md` § Deliberately untested

**Context.** `docs/TESTING.md` covers the API, the connector, and shared validators well, but `apps/web` had no test tier at all — its only entry under "Deliberately untested" read *"Marketing page visual appearance. No screenshot tests; the churn cost exceeds the value."* That reasoning was about **appearance**, and it quietly left **behaviour** uncovered too: whether `/docs/[slug]` resolves, whether `/errors/[code]` renders for a real code, whether the dark-mode toggle works, whether the four JSON-LD blocks are actually emitted. Those are load-bearing for a site whose entire job is discovery and self-service support.

Separately, the testing policy existed only as prose. Nothing made it happen.

**Decision.** Two parts.

1. **`apps/web` gets Playwright e2e, including visual regression.** Behavioural assertions plus `toHaveScreenshot()`. One tool covers both, and Playwright pins its own browser builds, which is what makes a visual baseline stable enough to be worth having.

2. **A `Stop` hook enforces the policy.** `.claude/hooks/require-tests.sh` blocks a turn that changed source in an area without touching that area's tests. Per-area granularity, not per-file. It blocks **once** per unique set of untested areas per session, so a legitimate exception costs one message instead of an unbreakable loop. The area→tier mapping lives in `.claude/skills/testing-policy/SKILL.md`.

**Consequences.**

- The churn objection was real and is answered by constraint, not by optimism: visual snapshots run on **one** OS in CI, because font rasterisation differs across platforms and a baseline that drifts per-runner is the exact failure the original decision feared. Dynamic regions get masked rather than tolerated.
- `apps/desktop` is **not** in scope. Playwright cannot drive a Tauri WebView; that needs `tauri-driver` with WebdriverIO, and the app is Phase 4. `docs/TESTING.md`'s "Tauri WebView rendering is manual per platform" stands until then.
- Enforcement is a proxy — it checks that a test artifact changed, not that coverage improved. Stated plainly in the skill, because a proxy people game is worse than no proxy.
- Playwright is a new dependency for `apps/web`, landing with Phase 2c. It is not installed yet; the hook's requirement for `apps/web` is inert until that app exists.
- **Test authoring is delegated to the `test-writer` subagent, pinned to Sonnet.** Tests are well-specified work against an existing spec, which is where a smaller model is a good trade. The cost is that the agent does not inherit the calling conversation's context, so the brief has to carry the change, the tier, and any history of what broke before — a vague delegation produces tests that assert the code does what it does.

**Rejected.** *Cypress* — heavier, and its visual comparison needs a paid service or a plugin. *Vitest browser mode* — good for component tests, not for asserting a deployed route end to end. *A `PostToolUse` hook on Write|Edit* — fires mid-edit, before the test could plausibly have been written, so it would train everyone to ignore it. *A lefthook pre-commit check instead* — commits are not the unit of work an agent produces; a turn is.

## ADR-0024 — Confine `capnp-rpc`'s non-`Send` region behind a thread boundary in `crates/core`

**Date.** 2026-08-03. **Status.** Accepted; implemented 2026-08-04 as `core::local_runtime`.

**Context.** `capnp-rpc` holds `Rc` internally, so `RpcSystem` and every future derived from it are `!Send`. `crates/protocol`'s `register_connection` awaits one, which makes *its* future `!Send`, which makes any future awaiting *that* `!Send`. `tokio::spawn` requires `Send` and rejects the lot.

`rpc.rs` predicted this but scoped it too narrowly: it framed the problem as one about keeping the control stream open for `unregisterConnection` (§12), implying that a client which drops the control stream after registering avoids it. It does not. Registration alone is enough.

Phase 1's `examples/pool.rs` hit this the moment it tried to `tokio::spawn` a per-connection supervisor, and worked around it by putting all four supervisors on a single `LocalSet`. That is acceptable for a spike — the supervisors only register and accept streams, and each exchange is `tokio::spawn`ed onto the multi-threaded runtime — but it is the wrong shape to ship.

**Decision.** `crates/core` confines the non-`Send` region rather than propagating it. The registration RPC (and later the long-lived control stream) runs on a dedicated current-thread runtime, or a `LocalSet` on its own thread, communicating with the rest of `core` over channels. `ConnectionDetails` is `Send`, so what crosses the boundary is plain data.

`TunnelManager` then spawns per-connection tasks with ordinary `tokio::spawn`, and neither `crates/cli` nor `apps/desktop` ever learns that a `!Send` type exists in the dependency tree.

**Consequences.**

- One extra thread per process (not per connection) plus a channel hop on the registration path. Registration happens once per connection per reconnect and costs ~300 ms of network time, so the hop is unmeasurable.
- The control stream can stay open for the connection's whole life, which §12's graceful shutdown requires and which a multi-threaded runtime cannot host at all. The decision that makes the pool work is the same one that makes clean shutdown possible.
- `crates/protocol`'s public API does not change. The confinement is `core`'s, because the layering puts lifecycle policy there (`crates/CLAUDE.md`).
- If it ever becomes a problem, the escape hatch is the one `docs/PROTOCOL.md` §16 already records for risk P1: the registration surface is one bootstrap plus three methods, so hand-encoding the RPC frames removes `capnp-rpc` entirely. Not worth doing pre-emptively.

**Rejected.** *Everything on a `LocalSet`* — pushes a library's implementation detail into every consumer, and serialises unrelated per-connection work onto one thread for the sake of one RPC. *`unsafe impl Send`* — forbidden by `#![forbid(unsafe_code)]`, and it would be a lie: the `Rc`s are genuinely shared. *Forking `capnp-rpc` to use `Arc`* — a maintenance burden for a dependency whose interop is the thing we most want to keep boring.

## ADR-0025 — A purpose-built Rust emitter instead of `typify`

**Date.** 2026-08-03. **Status.** Accepted. **Amends** ADR-0009.

**Context.** ADR-0009 fixed the contract direction — zod is the authority, everything generates outward — and named the pipeline as `zod → openapi.json → typify → crates/contract`. That direction is unchanged and correct. The tool is not.

`typify` generates Rust types from JSON Schema. Two things went wrong when Phase 1.5 came to use it:

1. **The error registry is not expressible in JSON Schema.** The document can say a response body has a `code` field with 30 allowed string values. It cannot say `SUBDOMAIN_IN_USE` is a 409, or that retrying it cannot succeed. Both facts are exactly what a Rust client needs — `crates/cli` branches on retryability — so `typify` could produce at most half of `crates/contract`, and a second generator would have to produce the rest.
2. **zod inlines reused schemas.** `z.toJSONSchema` emits `CreateTunnelRequest.client` as `{type: "string", enum: ["cli", "desktop"]}` rather than a `$ref` to `ClientKind`. A generator that takes JSON Schema at face value emits `String` there, which is the stringly-typed matching ADR-0018 exists to eliminate — arriving through the very pipeline meant to prevent it.

**Decision.** `cargo xtask codegen` reads two files and emits `crates/contract/src/generated.rs`:

- `schema/nport-api.openapi.json` for request and response types
- `schema/errors.json`, a new output of `pnpm codegen`, carrying each code's origin, status, retryability, slug, and default message

The emitter resolves inlined enums back to their named component by value set, and **fails rather than guessing** on any construct it does not recognise. An unnamed inline enum is a codegen error telling the author to name it, not a silent `String`.

**Consequences.**

- One pipeline instead of two, and the emitter is ~300 lines of `serde_json` walking with no new dependency. `typify` and its tree stay out of the build.
- The schemas it supports are narrow by construction: flat objects of string, integer, boolean, string-enum, `$ref`, and one open map for `details`. That is all the contract uses. Anything else stops codegen with a message naming the file to extend.
- **The emitter runs `rustfmt` on its output.** Discovered the hard way: raw output was one newline away from canonical, which would have failed `codegen-drift.yml` on a tree nobody had touched.
- `ErrorCode` is `#[non_exhaustive]`, so adding a code is not a breaking change for downstream matches.
- The error envelope stays **hand-written** in `lib.rs` rather than generated, because `code` must be a typed `ErrorCode`. A generated `code: String` would hand every caller the problem the registry exists to solve.
- If the contract ever grows genuinely complex schemas — nested objects, unions, discriminated variants — `typify` is still the escape hatch and this ADR should be revisited rather than the emitter grown to match it.

**Rejected.** *`typify` plus a second generator for the registry* — two pipelines, two failure modes, and the registry generator would still be hand-written. *Reading `packages/contract/src/errors.ts` from Rust* — that means parsing TypeScript. *Duplicating status and retryability by hand on the Rust side* — precisely the drift the contract exists to prevent.

## ADR-0026 — Derived tunnel names are the saga's idempotency key

**Date.** 2026-08-04. **Status.** Accepted.

**Context.** The provisioning saga journals each step before its side effect, so on replay an entry means "this *may* have happened" (`docs/ARCHITECTURE.md` §3a). Compensation therefore has to answer a question the journal cannot: did the `createTunnel` call that was in flight when the isolate died actually create a tunnel?

The Cloudflare API offers no idempotency key for tunnel creation, so a naive answer is impossible. If the tunnel got created but its ID was never journaled, there is nothing to delete by — and that leaves an orphan tunnel with no DNS record, which is defect R3 reappearing through the mechanism designed to prevent it.

**Decision.** Every tunnel NPort creates is named **`nport-<normalized subdomain>`**, derived rather than random. Compensation and teardown look a tunnel up by that name when they have no ID, and delete what they find.

**Consequences.**

- The orphan window closes without an idempotency key: the name *is* the key, and it is knowable before the call that creates the thing it names.
- The `nport-` prefix is what makes deleting-by-name safe. A self-hoster's account may hold tunnels NPort did not create, and reconciliation must be able to tell them apart before it deletes anything. `nport-` is already a reserved prefix in `packages/contract`, so no user-chosen subdomain can produce a colliding tunnel name.
- One extra Cloudflare call on the compensation path, and only there — the happy path still has the ID.
- **This is a weaker guarantee than the DNS one, deliberately.** Invariant 8 requires *proving* ownership of a DNS record by its content before deleting it. For a tunnel there is no equivalent content to check, so the name prefix is the whole proof. That asymmetry is acceptable because a tunnel with no DNS record routes nothing, while a DNS record can point at somebody else's live service.

**Rejected.** *A random tunnel name journaled before creation* — the journal write and the API call still cannot be atomic, so a crash between them leaves a name nothing will look up. *Listing all tunnels and diffing against leases* — that is reconciliation's job, running every five minutes; compensation needs an answer now and bounded to one name. *Treating the ambiguous case as unrecoverable* — it would mean `PROVISION_FAILED` sometimes lies about having left nothing behind.

## ADR-0027 — Redeemed proof-of-work challenges are recorded, though issuing stays stateless

**Date.** 2026-08-04. **Status.** Accepted. **Amends** the abuse-control design in `docs/ARCHITECTURE.md` §7.

**Context.** The proof-of-work gate is described as stateless: `GET /v1/challenge` returns an HMAC over its own parameters, nothing is stored, and so issuing costs one HMAC and cannot be exhausted. That property is real and worth keeping.

But it was load-bearing for a claim it does not actually support. A challenge is valid for 120 seconds, and nothing stopped one solved challenge from being presented to `POST /v1/tunnels` repeatedly inside that window. The cost of a solve was therefore amortised over unlimited tunnels, and §7's "the only control that raises attacker cost without an account" carried no load at all.

**Decision.** The `Registry` Durable Object keeps a ledger of redeemed challenge MACs. `POST /v1/tunnels` spends a challenge before provisioning; a second presentation is `POW_INVALID`. Rows are pruned on every write and expire well after the challenge does.

**Consequences.**

- Proof of work becomes a cost **per tunnel** rather than per two-minute window, which is what makes raising difficulty under load a meaningful lever.
- **Issuing is still stateless and still unexhaustible.** The distinction is the point: nothing is written until a caller has already paid for a solve, so the ledger cannot be filled by anyone who has not done the work. A table of *outstanding* challenges — the thing §7 rejects — would itself be the attack surface.
- Two Durable Object round trips on create, both to the same singleton `Registry`: one for the global cap, one to spend. Ordered so the cap is checked first, because a 503 must not consume the caller's work.
- The ledger is on the create path only, so its cost scales with creates rather than with heartbeats.

**Rejected.** *A nonce range bound to the challenge* — it limits how many solutions exist, not how many times one is presented. *Making the challenge single-use by encoding a counter* — stateless verification cannot know whether a counter was already used. *Accepting the replay* — the alternative to a ledger is that difficulty is not a lever, and difficulty is the documented response to an abuse event (`docs/OPERATIONS.md`).

## ADR-0028 — Proof-of-work difficulty escalates per source, not globally

**Date.** 2026-08-04. **Status.** Accepted. **Amends** ADR-0027 and the abuse-control design in `docs/ARCHITECTURE.md` §7.

**Context.** §7 says difficulty is "raised dynamically under load", and `docs/OPERATIONS.md` calls it the lever to pull during an abuse event. Both readings imply a **global** load signal — and a global signal is a problem for the endpoint that would have to read it.

`GET /v1/challenge` is designed to be the cheapest thing in the system: one HMAC, nothing stored, so it cannot be exhausted. Reading a global load figure means reading the singleton `Registry` on every challenge, which does two unwanted things. It puts a shared serialization point on the cheapest path, and it hands an attacker a way to make us do Durable Object work for free — the exact property the stateless design was protecting.

There is also a fairness problem with a global dial. Under attack it raises the price for *everyone*, so the first-time user trying one tunnel pays for the botnet.

**Decision.** Difficulty escalates **per source**, from the source's own recent create attempts, held in that source's `SourceQuota` object. `GET /v1/challenge` reads its own caller's object: one Durable Object read, sharded by source. Every four attempts in the trailing hour adds one bit — a doubling — capped by `POW_MAX_DIFFICULTY_BITS`.

The **global** lever remains manual: raise `POW_DIFFICULTY_BITS` and deploy. `docs/OPERATIONS.md` already documents that as the incident response.

**Consequences.**

- A first-time caller pays the ~100 ms floor. A source on its twentieth tunnel in an hour pays roughly 32x that. The price lands on whoever is generating the load.
- Hammering `/v1/challenge` now loads only the attacker's own object and raises only the attacker's own price. The endpoint is no longer strictly "nothing stored" — it is one read — but it is *more* self-defending than before, not less.
- Escalation is committed to inside the challenge's MAC, so it cannot be negotiated down. There is a test that tampers with the difficulty and expects `bad-signature`.
- `GET /v1/meta` advertises the **floor**, not what the next challenge will cost. A client sizes its solver from the floor and reads the actual difficulty off each challenge.
- The ceiling exists because unbounded escalation would eventually price out a legitimate heavy user permanently, and with no accounts there is nobody for them to appeal to.
- Escalation counts **attempts**, not successes, so failing on purpose does not dodge it.

**Rejected.** *A global signal read per challenge* — a hot singleton on the cheapest path, and free Durable Object work for an attacker. *Caching the difficulty in the isolate* — module-level mutable state, which rule 10 forbids and which is per-isolate rather than per-anything-meaningful. *Escalating on challenge issuance rather than on creates* — it would make issuing a write, which is the property worth keeping; the rate limiter already bounds issuance. *Leaving difficulty static* — then it is not a lever, and §7's claim about it is false.
