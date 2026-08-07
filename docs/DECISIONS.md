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
| 0029 | The control-plane client speaks HTTP itself, rather than adding an HTTP stack | Accepted |
| 0030 | Tauri's transitive licences and advisories, scoped rather than blanket-allowed | Accepted |
| 0031 | A registry of independent nodes, rather than one control plane | Accepted, refined by 0049 |
| 0032 | The connector token is fetched from its own endpoint, and an inline one still accepted | Accepted |
| 0033 | Source identity is keyed on an IPv6 prefix, not a full address | Accepted |
| 0034 | Resource bounds on request input live in the contract, not in callers | Accepted |
| 0035 | DNS-over-TLS discovery fallback, on the workspace's single crypto provider | Accepted |
| 0036 | The deny list answers two questions; cleanup gets the narrower one | Accepted |
| 0037 | The heartbeat interval is discovered from `/v1/meta`, not hardcoded | Accepted |
| 0038 | Staging is a separate Cloudflare account, not a separate zone | Accepted |
| 0039 | Terraform manages infrastructure; it never mints a credential CI could use | Accepted |
| 0040 | Terraform owns every runtime secret; CI holds only the keys to the state | Accepted |
| 0041 | A bootstrap root creates the state bucket, so only one credential is human-made | Accepted |
| 0042 | State lives in HCP Terraform, not in an object store | Accepted |
| 0043 | Terraform generates secrets, but never a Cloudflare credential | Accepted |
| 0044 | Federation comes next, ahead of the website and the desktop app | Accepted |
| 0045 | The subdomain mirror is hand-written logic over generated constants | Accepted |
| 0046 | The registry gets its own OpenAPI document, and capacity is probed rather than claimed | Superseded in part by 0049 |
| 0047 | Worker plumbing shared in a package, rather than imported across deployables | Accepted |
| 0048 | Prerendered pages are served from Workers Static Assets, and e2e drives the Worker | Accepted |
| 0049 | One hostname per deployment: a gateway Worker, service bindings, and heartbeat registration | Accepted |

---

## ADR-0001 — Rewrite as v3 from scratch

**Date** 2026-08-03 · **Status** Accepted

**Context.** v2 (`main`) worked and had 668 stars, but its foundations were wrong in ways that could not be patched incrementally: the backend had no storage, so ownership, timing, and liveness were all inferred from the Cloudflare API; the error taxonomy was string prefixes inside HTTP 500; and the CLI was a Node wrapper supervising a Go binary by scraping its stderr. Fixing any one of these meant changing all of them.

**Decision.** Rewrite all four surfaces on the `v3-new-architect` branch. Keep the product promise (one command, custom subdomain, free, no account) and the brand; keep nothing else.

**Consequences.** A long period with no shippable artifact, mitigated by the phased roadmap and gates in `docs/ROADMAP.md`. v2 stays deployed and supported until the Phase 6 sunset. Existing users keep `npm i -g nport` working (ADR-0012).

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

**Date** 2026-08-03 · **Status** Accepted · **Refined by** ADR-0048

ADR-0048 adds the piece this one got wrong by omission: OpenNext needs an incremental cache to *serve*
prerendered pages, not only to revalidate them. Without one, every `generateStaticParams` route 404s on
the deployed Worker while building and testing clean.

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

**Decision.** `packages/contract` is the single authority: zod schemas, route definitions, and the error registry. It generates `schema/nport-node.openapi.json`, which generates `crates/contract` via `typify`. CI fails on drift.

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

**Date** 2026-08-03 · **Status** Accepted · **Supersedes** part of `docs/TESTING.md` § Deliberately untested · **Refined by** ADR-0048

ADR-0048 pins down what "asserting a deployed route end to end" has to mean for `apps/web`: the e2e
tier drives the **built Worker**, not `next dev`. No tier that reads `.next/` can see a fault in how
the Worker reads its own output, which is the fault that prompted it.

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

- `schema/nport-node.openapi.json` for request and response types
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

## ADR-0029 — The control-plane client speaks HTTP itself, rather than adding an HTTP stack

**Date.** 2026-08-04. **Status.** Accepted. **Affects** `crates/core/src/api.rs`, and by extension the size of every artifact in `docs/RELEASE.md`.

**Context.** `crates/core` has to call five JSON endpoints on `api.nport.link` (`docs/API.md`). The obvious answer is `reqwest`, and the obvious answer costs more here than it usually does.

`reqwest` brings `hyper`, `http`, `h2`, `tower`, and a TLS integration — and the TLS integration is the part that bites. This workspace pins `rustls` to `aws-lc-rs` deliberately, because offering `X25519MLKEM768` requires it (`docs/PROTOCOL.md` §5). A second crypto provider in the graph makes `rustls` refuse to pick one at runtime, which is a failure that shows up as a panic in a released binary rather than as a compile error — the same trap that already forced `default-features = false` on `tokio-tungstenite`. Getting `reqwest`'s feature flags to land on exactly one provider is possible and it is a standing maintenance obligation on every dependency bump.

The size matters too. The CLI ships to npm, Homebrew, Scoop, and GitHub Releases, and a general HTTP client is a large fraction of a binary whose entire job is one protocol we implement ourselves.

Against that, what is actually needed: five endpoints on our own server, request bodies that are small JSON, responses that are a few hundred bytes, `connection: close` so end-of-socket delimits every body, and no redirects, no cookies, no keep-alive pool, no multipart, no compression. `crates/core` **already** parses HTTP/1.1 response heads and chunked bodies — `crate::proxy` exists for the origin side of the tunnel and is tested against real servers.

**Decision.** The API client is written against `tokio-rustls`, `rustls-native-certs`, `aws-lc-rs`, and `serde_json` — every one of which the binary already links for the connector. It reuses `crate::proxy::ResponseHead` and `decode_chunked` rather than reimplementing them.

`aws-lc-rs` also becomes a direct dependency for one thing: SHA-256, for solving the proof of work. It is already compiled in through `rustls`, so this adds no code to the binary and no third-party crate to the audit.

**Consequences.**

- Zero new crates in the dependency graph, and no second TLS or crypto stack to keep aligned on every bump.
- The client is about 300 lines and every line of it is ours to debug. It handles exactly the shapes the API produces, which means an API that starts issuing redirects, or keep-alive without `content-length`, would need work here — both are changes to our own server, made by us, with a test in this file.
- Plaintext `http://` is supported because `wrangler dev` serves it and `--backend` points at it. It is opt-in through the URL scheme and never a fallback: a silent downgrade would put a tunnel token on the wire in the clear.
- If a future need arrives that genuinely wants an HTTP client — streaming uploads to something that is not the tunnel, OAuth, an SDK — this decision should be revisited rather than extended. The argument here is "five small endpoints on our own server", and it stops being true the moment that is not the shape.

**Rejected.** *`reqwest`* — the provider-alignment obligation and the binary size, for five endpoints. *`hyper` directly* — most of the dependency weight and most of the API surface, without the ergonomics that make `reqwest` worth it. *`ureq` or another blocking client* — blocking I/O inside an async runtime that is also serving a tunnel, which `docs/conventions/rust.md` forbids for good reason. *A `sha2` crate for the proof of work* — a second SHA-256 implementation in a binary that already links a certified one.

---

## ADR-0030 — Tauri's transitive licences and advisories, scoped rather than blanket-allowed

**Date** 2026-08-04 · **Status** Accepted

**Context.** Scaffolding `apps/desktop` put `tauri` in the Cargo workspace, and `cargo deny check` went from clean to eighteen failures. None come from code anyone here wrote; all are transitive through Tauri, and they fall into three groups.

**Five crates are MPL-2.0** — `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`. `deny.toml`'s allowlist is permissive-only, with a comment stating that copyleft in a statically linked MIT binary "is a decision, not an accident — it needs an ADR". This is that ADR. MPL-2.0 is **file-level** copyleft: the obligation is to publish modifications to the MPL-licensed files themselves, and it explicitly permits combining those files with code under any other licence. NPort modifies none of them, so the obligation is discharged by not doing the thing that would trigger it.

**Sixteen unmaintained advisories** — ten for the gtk-rs GTK3 bindings, one for `proc-macro-error`, five for the `unic-*` family. Unmaintained is not a vulnerability. GTK3 in particular is not a Tauri choice that can be waited out: WebKitGTK, the only Linux WebView, is a GTK3 library, and the bindings are unmaintained because GTK3 itself is. There is no GTK4 path until WebKitGTK has one.

**Two vulnerabilities in `quick-xml` 0.38.4**, RUSTSEC-2026-0194 and RUSTSEC-2026-0195, both denial of service in XML parsing — quadratic time on duplicate attribute names, and unbounded allocation on namespace declarations. `plist` requires `0.38`, and `0.38.4` is the newest release on that line, so there is nothing to upgrade to; the fix has to come from `plist` moving to `0.41`.

A third vulnerability, RUSTSEC-2026-0009 in `time`, **was** fixable and is fixed: `time 0.3.55` patches it and needs Rust 1.88, which the pinned 1.97.1 toolchain satisfies. Upgrading is always preferred to ignoring, and it was tried first for all three.

**Decision.** Accept all three groups, each **scoped to the exact crates involved** rather than relaxed globally.

MPL-2.0 goes in `[licenses.exceptions]` naming those five crates, not into `allow`. A sixth MPL dependency, arriving anywhere, still fails the gate and still needs a decision.

The sixteen unmaintained advisories and the two `quick-xml` vulnerabilities go in `[advisories] ignore` with a comment each, per that section's existing rule.

The `quick-xml` ignore rests on reachability, not on severity. `plist` parses the application's **own** `Info.plist` — a file inside the signed bundle we ship. It is not attacker-controlled, not remote input, and not on any path a tunnel's traffic reaches. A denial of service against a parser whose only input is a file the attacker would already have had to replace is not a denial of service. **If `plist` ever parses something a user supplies, this ignore is wrong and must go.**

**Consequences.**

- `cargo deny check` is green again, and still fails on anything new. The scoping is the whole point: a blanket `allow = ["MPL-2.0"]` would have been one line and would have silently accepted every future MPL crate in the CLI, which ships to npm and Homebrew and has no GUI excuse.
- Every entry carries its reason in the file, so the next person deciding whether to remove one has the argument rather than a bare identifier.
- The `quick-xml` entries are the ones to revisit. Watch `plist` for a `quick-xml 0.41` bump and delete them when it lands.
- Linux desktop builds inherit an unmaintained GTK3 stack for as long as WebKitGTK does. That is a known cost of shipping a Linux desktop app at all, and `apps/desktop/CLAUDE.md` already treats WebKitGTK as the oldest engine we ship against.
- None of this touches `crates/cli`. The advisories and licences here are reachable only from `apps/desktop/src-tauri`, and the CLI's graph is unchanged — which is why scoping matters more than the count.

**Rejected.** *Blanket `allow = ["MPL-2.0"]`* — accepts an unbounded future set to fix a bounded present one. *Dropping `cargo deny` for the desktop crate* — the desktop app ships signed installers to end users; it needs supply-chain review more than the CLI does, not less. *Waiting for GTK4* — WebKitGTK has no GTK4 release, so this is waiting for someone else's project to finish a port with no date. *Vendoring or patching `plist`* — a fork to dodge a DoS in a parser reading our own bundle metadata is more risk than it removes.

---

## ADR-0031 — A registry of independent nodes, rather than one control plane

**Date** 2026-08-05 · **Status** Accepted · **Refined by** ADR-0049

**Two sentences below are no longer true, and the design they describe is otherwise intact.** ADR-0049
gave a deployment one hostname instead of two, so the registry has no `registry.nport.link` and no
hostname of its own — it answers `/v1/nodes*` behind the same gateway as node #1. And the third
enrolment gate, "a liveness probe of its `/v1/meta`", is now the node's own check of its public URL
before it registers; nothing here fetches a node. Left as written, because what this ADR argues for —
a directory that holds no credentials and is advisory rather than load-bearing — is unchanged and is
the part worth reading.

**Context.** The control plane is one Worker bound to one Cloudflare account and one zone — `docs/SELF_HOSTING.md` states it outright: "One zone per deployment." Three ceilings bind at once and every one of them is per-account or per-zone.

**DNS records per zone.** Each active tunnel is one CNAME, so a zone's record budget is a hard cap on concurrent tunnels. **Tunnels per account**, since `cfd_tunnel` objects are account-scoped. And the **Cloudflare API rate limit**, per-account, which `docs/ARCHITECTURE.md` §6 already names as "the real ceiling on provisioning throughput".

Adding accounts alone does not help, because of a constraint that shapes everything below: **a zone lives in exactly one Cloudflare account, and a `<tunnel-id>.cfargotunnel.com` CNAME only routes when the DNS record and the tunnel are in the same account.** `*.nport.link` therefore cannot be served by more than one account. A shard needs its own domain as well as its own account.

**Decision.** Split the control plane in two.

A **registry** at `registry.nport.link` that is only a directory: it accepts registrations, probes what it has listed, and answers `GET /v1/nodes`. It holds no Cloudflare credentials and provisions nothing.

Many **nodes**, each on its own Cloudflare account and its own domain, each doing exactly what `apps/node` does today. `api.nport.link` becomes node #1 and keeps serving `*.nport.link`, so no existing URL shape changes.

Enrolment is **anonymous and open**: any node self-registers, with no shared secret. The gate is proof of work (reusing `apps/node/src/domain/pow.ts`), a DNS TXT proof that the node controls the domain it claims, and a liveness probe of its `/v1/meta`.

**Selection is the client's.** The registry returns the list; `crates/core` probes a handful in parallel and picks the fastest with capacity, caching the list at `~/.nport/nodes.json`. A registry that is down therefore costs nothing — which is the property that lets a directory be a single point of listing without being a single point of failure.

**Consequences.**

- Capacity becomes additive. A new domain plus a new account is a new shard, and anyone can contribute one.
- **A node operator can read and modify traffic through the tunnels they issue**, and the tunnel's owner cannot detect it. The hostname is in the operator's zone, Cloudflare terminates TLS there, and a Worker route on that zone sees full request and response bodies. This is accepted because NPort's purpose is exposing a local dev server for testing and demos, not production traffic. Hardening it is in `docs/ROADMAP.md` § Deferred, unscheduled.
- **A privacy claim stops being true and had to be withdrawn.** `README.md` and §1 of `docs/ARCHITECTURE.md` said tunnel traffic "never passes through NPort's own servers". With third-party nodes that is wrong, and both now say what is actually true. Correcting the sentence is not optional in the way the hardening is: shipping a claim we know to be false is a different kind of decision from declining to defend against a threat.
- `--backend` keeps working and skips discovery entirely, so a self-hoster and `pnpm dev:cli` are untouched. A node with no `REGISTRY_URL` never registers, which is the private deployment `docs/SELF_HOSTING.md` already describes.
- Three new error codes and a discovery step are additive to `contract-v1`; nothing existing changes shape.

**Rejected.** *One shared zone across accounts* — does not route, per the constraint above; this is a property of Cloudflare Tunnel, not a configuration we could fix. *Subdomain zones per node* (`*.hk.nport.link`) — keeps one brand domain, but Cloudflare's subdomain setup has historically been Enterprise-gated and universal SSL does not cover a third label, so it trades a domain purchase for a plan dependency and a certificate problem. *Secret-based enrolment* — a shared secret that every prospective operator must obtain is a manual gate that defeats the point of open contribution, and a leaked one is worth no more than no secret at all. *Registry-assigned selection* — makes the registry load-bearing at provision time; client-side selection with a cached list keeps it advisory.

## ADR-0032 — The connector token is fetched from its own endpoint, and an inline one still accepted

**Status.** Accepted, 2026-08-05.

**Context.** `POST /v1/tunnels` is worthless unless it can return a connector credential, so where that credential comes from is the load-bearing question in the whole provisioning saga. v2 read it straight off the create response — `POST /accounts/{id}/tunnels` → `result.token` — and did so in production for years. 2a moved to `cfd_tunnel`, the current name for the same resource, and kept reading `result.token`.

Checking that against Cloudflare's published OpenAPI schema and its generated Go SDK found no such field. A create answers with the shared tunnel object — `id`, `name`, `status`, `config_src`, `created_at` and the rest — and the credential has an endpoint of its own, `GET /accounts/{id}/cfd_tunnel/{tunnel_id}/token`, whose `result` is a bare string rather than an object.

That does not settle it, because the same schema documents **no POST at all** on the legacy `/accounts/{id}/tunnels` that v2 demonstrably posts to. The two paths are one handler with the schema describing one of them, so a create-only field could exist and simply not be written down. The question cannot be answered without the live API, and nothing here has met it.

**Decision.** Accept both. Use `result.token` when the create response carries one; otherwise fetch it from the token endpoint. A response that yields neither is a failed create, compensated by the existing `create-tunnel` step, which finds the orphan by its derived name (ADR-0026) and deletes it.

**Consequences.**

- Provisioning makes three Cloudflare calls rather than two, against a free-plan budget of fifty — and two whenever the inline field is present, because the second call is conditional. `test/tunnels.test.ts` asserts the exact list, so the number stops being a comment.
- **Both branches are tested, and that is not optional.** Whichever shape production turns out to answer with, the other becomes dead code — so a suite that covered only one would be exercising the path that never runs. `test/fake-cloudflare.ts` defaults to the documented shape and has a switch for v2's; `src/cloudflare/dev-fake.ts` takes the documented path, so `pnpm dev` exercises it by hand.
- A failure fetching the token is a new way to end up holding an orphan tunnel with no credential. It compensates identically to a failed create, which is why the token fetch lives inside `createTunnel` rather than beside it: the saga sees one operation either way.
- **The branch not taken must be deleted once the live API answers.** A permanently dead path in the most important call in the system is worse than either half of it, and the first successful provision is the observation that resolves it.

**Rejected.** *Betting on the schema alone* — if the field is in fact returned, an unnecessary subrequest on every provision, which is the cheap mistake. *Betting on v2 alone* — if it is not, **every** provision fails on first deploy, which is the expensive one, and the failure would look like a Cloudflare outage rather than a wrong assumption. *Reverting to the legacy `/tunnels` alias* to match v2 exactly — it is the undocumented path of the two, and building on the alias Cloudflare has stopped describing trades a known unknown for an unknown one.

## ADR-0033 — Source identity is keyed on an IPv6 prefix, not a full address

**Status.** Accepted, 2026-08-05.

**Context.** With no accounts, "who is this" is `HMAC(ip, IP_HASH_SECRET)` and nothing else, and three of the five abuse controls in `docs/ARCHITECTURE.md` §7 are keyed on it: the Workers rate limiter, the per-source concurrency cap, and the hourly create quota. The lease's stored `ip_hash` is the same value.

Keyed on the **full** client address, all three are free to bypass over IPv6. A residential or mobile allocation is a 64-bit prefix at the very smallest — commonly a /56 or /48 — so the client owns at least 2^64 addresses and can present a different one on every request. Each becomes a different hash, a different `SourceQuota` Durable Object, and a different rate-limiter bucket. No botnet, no cost, no configuration: just use the addresses you were given. A test confirmed it before the fix — three tunnels against a cap of three, then a fourth accepted from the same /64.

IPv4 never had this problem, which is why it went unnoticed: a client controls exactly one address, so the address *is* the identity.

**Decision.** Narrow the address to the part the client does not choose before hashing it. IPv4 addresses are used whole. IPv6 addresses are truncated to their leading four groups. IPv4-mapped addresses (`::ffff:a.b.c.d`) are keyed on all 32 bits of the embedded IPv4, because they are IPv4 clients. An address that does not parse is hashed unchanged.

The comparison is on **values**, not on the text: `2001:db8::1` and `2001:0db8:0:0:0:0:0:1` are one address, and a string compare would call them two identities and reopen the hole.

**Consequences.**

- The per-source caps mean something over IPv6 for the first time. Nothing changes for IPv4.
- **A few unrelated customers can share a cap.** Some providers hand out single addresses from a shared /64, and those now key together — three concurrent tunnels between them. Accepted deliberately: the trade-off runs one way only, since grouping too finely means there is no cap at all. A /64 is also the smallest block anyone is guaranteed to have, and what Cloudflare's own rate limiting keys IPv6 on.
- Existing `ip_hash` values change meaning, which costs nothing here: no lease outlives its own hash, and rotating `IP_HASH_SECRET` already invalidates every stored value by design.
- **The v2 shim's delete gets wider, and it is the one place that matters.** `releaseAsLegacy` authorizes on the source hash, because a 2.x client never had an `ownerToken` to present — so for an IPv6 caller the delete is now authorized to a /64 rather than to one machine, and another host on the same home network could release the tunnel. Accepted: it is the weakest authorization in the system by design, it is still strictly stronger than v2's, which accepted a delete from anyone, and `/v1` is untouched because it proves ownership with a token and never consults a source hash. `docs/RELEASE.md` sunsets the shim, which is the real fix.
- **A claim in the code was wrong and had to be withdrawn.** The ASN was documented as being in the key "so that a botnet spread across one network cannot present as thousands of unrelated sources". It does the opposite of that: extra key material can only split one identity into two, never merge two into one. The ASN stays — it is harmless and is the documented design — but the reason given for it was backwards, and a wrong reason in a comment is how the next person builds on a property that was never there.

**Rejected.** *Keying on the ASN alone* — this is what the old comment's justification actually describes, and it would put an entire ISP on one bucket of 60 requests a minute. *A longer prefix (/128, /96)* — leaves the hole open for anyone with more than a handful of addresses, which is everyone on IPv6. *A shorter prefix (/48, /32)* — bounds a determined attacker with a large allocation, at the price of capping large numbers of unrelated customers against each other; if abuse from single allocations is ever observed, the right response is a manual measure in `docs/OPERATIONS.md`, not a permanently coarser key for everybody.

## ADR-0034 — Resource bounds on request input live in the contract, not in callers

**Status.** Accepted, 2026-08-05.

**Context.** `requestedSubdomainSchema` has carried a length bound since Phase 1.5, with a comment saying exactly why: "to stop a megabyte of text reaching the normalizer". Three things then turned out not to have one.

`normalizeSubdomain` strips the zone suffix in a loop, and it did so by re-slicing — each pass copying the whole remaining string. That is O(n·k) for k suffixes, and since every suffix is eleven characters, k grows with n. Measured: `"a"` followed by `".nport.link"` repeated took 4 ms at 11 KiB, 87 ms at 54 KiB, and **12.5 s at 645 KiB**.

The `/v1` path was bounded by its schema. **The v2 shim was not**, because v2's request shape is not in the contract and the shim therefore reads its own body — so it passed whatever arrived straight into normalization. That is the endpoint with no proof of work, so its cost per request is bounded by nothing else. Its rejection message also interpolated the raw value into the response, making a megabyte in a megabyte out.

Separately, `challenge`, `nonce` and `ownerToken` were unbounded strings. Each is hashed before anything about it is trusted, so an unbounded one buys proportional server CPU for the price of bandwidth.

**Decision.** Two independent layers, because either alone would be enough only until someone adds a third caller.

1. **`normalizeSubdomain` is linear.** It walks an index instead of re-slicing. A function that looks linear should be linear, whatever its input.
2. **The bound lives at the contract's entry points.** `MAX_INPUT_LENGTH` is exported, `requestedSubdomainSchema` uses it, and `checkSubdomain`, `checkSubdomainShape` and `isReserved` each refuse longer input before normalizing — reusing the existing `too-long` reason, so no new error code. A caller cannot forget a check it does not have to make.

`challenge`, `nonce` and `ownerToken` get bounds sized two to five times their actual shapes, and the shim truncates what it echoes.

**Consequences.**

- The contract accepts slightly less than it did at `contract-v1`, which is a narrowing after a freeze. Compatible in practice: our own client sends a 43-character `ownerToken` and a decimal nonce, and no legitimate caller is near any of these numbers. The OpenAPI document gains four `maxLength` keywords; `crates/contract` gains a doc comment and no type change.
- These are resource bounds and not format checks, and the distinction matters for anyone tightening them later: the format is enforced by verifying the value, so a bound exists only to cap what verification may cost.
- `isReserved` now answers `false` for absurd input rather than normalizing it. Its caller is the reconciliation sweep, whose input comes from Cloudflare rather than from a request, so nothing changes in practice — it is bounded because it is the third entry point, not because it was reachable.

**Rejected.** *Bounding only in the zod schemas* — the shim cannot use them, which is how this happened. *Bounding only in the shim* — leaves the next hand-written caller to remember. *A new `input-too-long` rejection reason* — `too-long` is already accurate, and a code in a frozen registry is not worth spending on a distinction no client can act on differently. *Relying on the platform's body-size limit* — it is two orders of magnitude above anything legitimate here, and a quadratic function turns any of it into CPU time.

## ADR-0035 — DNS-over-TLS discovery fallback, on the workspace's single crypto provider

**Status.** Accepted, 2026-08-05.

**Context.** `docs/PROTOCOL.md` §4 specifies three ways to find an edge address and two were implemented: the A/AAAA shortcut and the SRV lookup cloudflared actually does. The DoT fallback was deferred through Phase 1 with the note "needs a hickory TLS feature", and `crates/protocol/CLAUDE.md` had been describing `src/edge.rs` as doing "SRV / DoT / A-AAAA discovery" the whole time — a claim ahead of the code.

It is not a nicety. The networks that break edge discovery break **SRV lookups specifically**: captive portals, hotel Wi-Fi, and corporate resolvers that answer A records happily and `SERVFAIL` anything unusual. For those users there is no working path at all, and the failure looks like Cloudflare being down rather than like their network.

The reason it was deferred is real. This workspace pins rustls to **`aws-lc-rs`**, because offering `X25519MLKEM768` requires it, and a second crypto provider in the graph makes rustls refuse to choose one **at runtime** rather than at compile time — a failure that appears as a panic in a released binary, not as a build error. `hickory-resolver` offers `tls-ring` and `tls-aws-lc-rs`, and taking the wrong one would have been exactly that mistake.

**Decision.** Enable `hickory-resolver`'s `tls-aws-lc-rs`, and retry both discovery functions over DoT when the system resolver fails.

Four properties are load-bearing, and each is the opposite of the obvious implementation:

- **SNI is `cloudflare-dns.com`, never `1.1.1.1`.** No certificate is issued for the address. Getting this wrong makes the fallback a permanent TLS failure that appears *only* on the networks where it is the only path — so normal use would never reveal it.
- **The DoT resolver is built from an empty `ResolverConfig`**, not the system's. The reason to be there is that the system configuration is unusable.
- **Its trust anchors are the platform roots only.** `quic.rs`'s config adds Cloudflare's Origin CA and pins ALPN `argotunnel` because it dials the tunnel edge; reusing it here would widen the trust anchors used to resolve names.
- **The system resolver is tried first**, because it is faster and respects split-horizon DNS. A fallback that always runs is a hard dependency on `1.1.1.1` wearing a fallback's clothes, and a test asserts it does not.

When both fail, the **system** resolver's error is what surfaces.

**Consequences.**

- All three of §4's discovery paths now exist, and the layout comment that claimed so is true.
- **One dependency feature, no new crate and no second provider.** Verified: `cargo tree` shows one `rustls` and zero `ring` in `nport-protocol`'s graph.
- DoT reaches port 853 directly, so it survives broken DNS but not filtered TCP egress. A fallback, not a guarantee.
- The fallback policy is **testable without a network**, because the primary resolver is a parameter: which resolver wins, and which error survives, are asserted hermetically. Only "does `1.1.1.1:853` actually answer" needs the live tier, and it drives the DoT resolver directly — through the fallback, a working system resolver would answer first and the test would pass without exercising what it names.
- `aws-lc-rs` linkage on the two musl targets is now load-bearing for DNS as well as for QUIC. `Cargo.toml` already flags that as the thing to watch at release time (Phase 3).

**Rejected.** *`tls-ring`* — the second-provider trap above, and the failure mode is a runtime panic in a shipped binary. *DoH instead of DoT* — cloudflared uses DoT and §4 pins it; matching upstream costs nothing and diverging would need its own justification. *Always resolving over DoT* — discards split-horizon DNS, is slower, and turns a fallback into a hard dependency on one IP address. *A hardcoded edge IP list as the real fallback* — forbidden by §4 and by the module's own invariant: upstream has none, and inventing one means shipping an address that will one day route somewhere else.

## ADR-0036 — The deny list answers two questions; cleanup gets the narrower one

**Status.** Accepted, 2026-08-05.

**Context.** Writing `scripts/smoke.mjs` — a local end-to-end smoke test — turned up two defects in ten minutes that eleven review passes had not, because both live in code no other tier runs.

The first was a contradiction in `docs/TESTING.md`. It said the smoke tests "create real tunnels under `smoke-*`" *and* that "the `smoke-*` prefix is reserved so reconciliation can identify them". Both halves are wrong. `smoke-` is a reserved prefix, so a claim for it is `403 SUBDOMAIN_RESERVED` — the planned `smoke-<os>-<runid>` name could never have been created, and Phase 3 would have discovered that while writing the workflow. And the stated reason is backwards: `docs/ARCHITECTURE.md` §7 shares the deny list with the sweeper **so cleanup can never delete a reserved record**, so reserving a prefix makes reconciliation *skip* it. A leaked `smoke-` lease would have been the one orphan cleanup refused to touch.

Following that inversion found the real bug. A generated name is `nport-<base32>`, so its Cloudflare tunnel is `nport-nport-<base32>`, and the subdomain `reconcile.ts` extracts begins with `nport-` — reserved, therefore skipped. **Generated names are what every `nport 3000` without `-s` gets**, so the sweep was structurally unable to reap most orphans. R8's family for the fourth time.

**Decision.** Split the predicate by purpose, not the list.

`RESERVED_PREFIXES` is unchanged, so claim behaviour and `contract-v1` are untouched. `isReserved` remains the claim-time question. A new `isProtectedFromCleanup` answers the sweeper's: reserved **and not** one of the two `NPORT_OWNED_PREFIXES` (`nport-`, `smoke-`). `reconcile.ts` uses that one.

Smoke tests ask for a generated name rather than a `smoke-` one. That loses nothing: a generated name is unguessable, already carries the `nport-` prefix reconciliation recognises, and is now reapable.

**Consequences.**

- Orphaned generated-name tunnels are reaped. Infrastructure names are still untouchable, and three tests pin both halves rather than one.
- **The invariant is unchanged and the mechanism is narrower.** Invariant 8 is about proving ownership of a *record* before deleting it, and that proof — a `CNAME` whose content is exactly `<tunnel_id>.cfargotunnel.com` — is untouched. This changes only which names are exempt from being examined at all.
- `_` stays protected, because `_dmarc` and `_acme-challenge` are real records in the zone.
- Two predicates that differ subtly are a drift risk, so a test asserts the containment: anything protected must also be reserved. The reverse must not hold, and that asymmetry is the point — a name a stranger may claim but cleanup may not delete would be an unreapable-orphan factory.
- **`pnpm smoke` is now a tier** (`docs/TESTING.md`), because the two defects above were both invisible to `pnpm test`: it runs `workerd` but never `wrangler dev`, never the `nport` binary, and never `src/cloudflare/dev-fake.ts`.

**Rejected.** *Unreserving `smoke-` so smoke tests can claim it* — it would let a stranger take `smoke-anything` and lose the "recognisably ours" signal, to buy a nicer hostname in CI logs. *Dropping `nport-` from the deny list* — it is what stops a user claiming a name the generator might later hand out, which is a collision with real consequences. *Teaching the sweep to special-case the two prefixes inline* — the distinction belongs beside the list it refines, where the next person reading `RESERVED_PREFIXES` will see it, rather than in one caller that happens to have got it right.

## ADR-0037 — The heartbeat interval is discovered from `/v1/meta`, not hardcoded

**Status.** Accepted, 2026-08-05.

**Context.** `GET /v1/meta` publishes `heartbeatIntervalMs` as a quarter of `HEARTBEAT_GRACE_SECONDS`, and it exists for one reason: `apps/node/CLAUDE.md` says a limit is surfaced there "so clients discover rather than hardcode it". `core::tunnel` hardcoded 30 s and never called `Api::meta()` — which was therefore dead code in a client that had a method for it.

The consequence is that **the server could not shorten its own grace period**. Drop it from 120 s to 60 s, a plausible response to abuse, and a client still beating every 30 s has one miss of headroom instead of four. Drop it to 30 s and every tunnel dies on schedule with nothing anywhere explaining why. Invariant 3 makes the server authoritative for time limits, and a client choosing its own beat rate is a client enforcing one.

**Decision.** Fetch `/v1/meta` in `Tunnel::start`, before the claim, and use `heartbeatIntervalMs` clamped to 1–300 s. A failure to read it falls back to the 30 s constant rather than propagating, because a discovery endpoint hiccuping must not refuse a tunnel that would otherwise provision.

**Consequences.**

- One extra `GET` per tunnel start, on our own server, on a path that already makes two requests.
- The relationship the fallback rests on is now asserted for *any* grace rather than only the default: at a quarter of the window there are four beats per grace and three misses of room, checked across 30 s to 600 s.
- **The end-to-end beat rate is not provable locally, and `pnpm smoke` says so rather than pretending.** The obvious check — "is the lease alive past its grace?" — cannot work while the credential is fake: the connector exhausts its retries within about twenty seconds and deletes its own lease, so a later query returns 404 for the wrong reason. A check that goes green when beats land and red when the pool gives up measures neither, and this one did exactly that until it was caught by reverting the fix and watching it pass anyway. What the smoke test asserts instead is the *endpoint*: a heartbeat is accepted, it does not move `expiresAt` (defect R6), and one from the wrong holder is refused. The client's rate is covered by unit tests, and proving it end to end is step 3 of `docs/ROADMAP.md` § The critical path.

**Rejected.** *Publishing the grace period itself and letting the client divide* — the server already did the division, and two places computing the same headroom is how they drift. *No clamp* — a zero would spin the loop and an hour would silently disable renewal, which looks exactly like the lease expiring on its own. *Failing the tunnel when `/v1/meta` is unreachable* — it makes a discovery endpoint load-bearing for provisioning, which is the coupling ADR-0031 spent an ADR avoiding for the registry.

## ADR-0038 — Staging is a separate Cloudflare account, not a separate zone

**Status.** Accepted, 2026-08-06.

**Context.** Nothing has ever been deployed. The first deployments this project makes will be run by people learning the deploy path, against a control plane that creates and deletes DNS records at runtime and holds a credential that can provision tunnels on the whole account. The obvious cheap option — one account, `staging.nport.link` delegated as a second zone — shares three things that matter: the account's tunnel quota, the account-scoped API token, and the blast radius of any account-level mistake. `docs/ARCHITECTURE.md` §1 is explicit that the design assumes one Cloudflare account per deployment, and ADR-0031 exists because that assumption has a ceiling.

**Decision.** Staging runs in its own Cloudflare account on its own domain, `nport.online`. Production keeps `nport.link`. The two share no token, no zone, no tunnel quota, and no state.

**Consequences.**

- A staging mistake cannot reach production, including one made by CI holding a token. This is the property that makes it acceptable to give Actions a deploy credential at all.
- Two accounts to pay for and two to keep in the runbook. Both are free-plan eligible.
- `wrangler.jsonc` names no account id; `CLOUDFLARE_ACCOUNT_ID` in the deploy environment selects it. Editing a constant cannot send a deploy to the wrong account.
- The staging zone gets the *same* subdomain deny list, so `api`, `www` and the rest stay unclaimable there too. `staging` is already on that list, which is why `staging.nport.link` would have been an odd name to hand to a real tunnel.
- **The Worker names are identical in both accounts** — `nport-node` and `nport-web` at the time of writing, `nport-gateway` and `nport-registry` since ADR-0049, and never a `-staging` variant. Once the account is the isolation, a name suffix isolates nothing and only makes the two deployments differ in a way nothing else does; dashboards, log queries and runbooks then read the same in both places. Wrangler defaults an environment's `name` to `<name>-<env>`, so each environment states its name explicitly and `pnpm deploy:check` fails if one drifts — an unset `name` is a silent rename, not an error, and the symptom is a second Worker that nothing routes to.

## ADR-0039 — Terraform manages infrastructure; it never mints a credential CI could use

**Status.** Superseded by ADR-0040, 2026-08-06. Kept because the argument it makes is still the cost of the decision that replaced it.

**Context.** `docs/OPERATIONS.md` § Secrets states that the Worker's runtime secrets "are set with `wrangler secret put` and never pass through Actions". The Cloudflare provider can create `cloudflare_api_token`, and doing so is genuinely attractive: the token needs exact scopes (Account → Cloudflare Tunnel → Edit, Zone → DNS → Edit), getting them right by hand is error-prone, and the runbook currently asks a human to do it.

But a stack that CI applies is a stack CI can make emit anything it declares. If `terraform apply` can create a Tunnel-Edit token, then compromising the Actions runner yields the authority to provision tunnels on the account — which is precisely the authority the "never in CI" rule withholds. The token value would also land in state, where it is readable by anything holding the R2 keys.

**Decision.** Terraform owns zone settings and the edge rate-limit ruleset. It does not create API tokens, and it does not manage Worker secrets. Both are bootstrap steps performed by a person, documented in `infra/terraform/README.md`.

**One configuration serves both environments**, not a directory each. The resources are identical by design — the whole value of staging is that it is the same infrastructure — so the only per-environment inputs are `account_id`, `zone_name`, and the backend `key`. A directory per environment invites exactly the drift that makes a staging deploy stop predicting a production one. The same reasoning applies to `.github/workflows/deploy.yml`, which both environments call.

Terraform also does not manage the Workers, their routes, or their custom domains: `custom_domain: true` in `wrangler.jsonc` creates the DNS record, and two tools on one record fight on every deploy. The zone is a `data` source rather than a resource, so `terraform destroy` cannot take the zone with it.

**Consequences.**

- The stack is small. Its value is the rate-limit rule — which `docs/OPERATIONS.md` § Cloudflare setup step 7 had carried as "_TBD_ threshold" — plus settings that are otherwise dashboard clicks, and a frame production can copy.
- Bootstrap is not fully automated, deliberately. The manual steps are exactly the ones whose automation would hand CI more authority than it should hold.
- If tunnel records ever need to be *audited* rather than managed, that is a read-only job for the reconciliation cron, which already does it — not an import into this stack.

## ADR-0040 — Terraform owns every runtime secret; CI holds only the keys to the state

**Status.** Accepted, 2026-08-06. Supersedes ADR-0039.

**Context.** ADR-0039 kept secret material out of Terraform so that compromising CI could not yield a token that provisions tunnels. The cost it accepted was a manual step: six `wrangler secret put` invocations per environment, performed from a laptop, with values a person had to invent, store somewhere, and remember to rotate.

That cost is larger than it looks. A secret typed by hand once is a secret nobody rotates, kept in whatever the operator had to hand. Two environments double it. There is no record of which value is deployed where, so "is staging using the same HMAC key as production" is unanswerable without going and looking. And the step is the kind that gets skipped, leaving a Worker deployed and refusing every request for a reason that takes a while to find.

**Decision.** Terraform generates and owns all six runtime secrets. `random_password` produces `POW_SECRET` and `IP_HASH_SECRET`; `cloudflare_api_token` mints the Worker's `CF_API_TOKEN` with exactly two permission groups; the remaining three are identifiers Terraform already knows. A single sensitive output carries them as JSON, and the deploy pipes it into `wrangler secret bulk`. No value is ever typed by a person or stored outside the state file.

GitHub Actions holds four values, none of which is a Worker secret: the Cloudflare API token Terraform authenticates with, the account id, and the two R2 keys for the state backend.

**Consequences.**

- **The Terraform state is now the most sensitive object in the deployment**, and this is the real price. `random_password` keeps its result in state and `cloudflare_api_token` keeps the minted token there, because Terraform must know a value to detect drift. Anyone who can read the state can read every secret, so the R2 bucket and its two keys are the thing to protect — they are what ADR-0039 was protecting by spreading the risk instead.
- ADR-0039's objection is not answered, it is accepted: CI *can* mint a Tunnel-Edit token, because it runs the apply. The mitigation is that staging and production are separate accounts (ADR-0038), so a compromised staging pipeline reaches only staging.
- **Partly superseded by ADR-0043, 2026-08-06**, on the point below: Terraform no longer mints the Worker's Cloudflare token. It still owns the two generated HMAC keys and still syncs the whole set with `wrangler secret bulk`, which is the part of this decision that survives.
- **Amended 2026-08-06, after the first apply.** The cost is larger than written above. The provider creates the Worker's token through `POST /user/tokens`, so the CI credential needs **User → API Tokens → Edit** — and a token holding that can mint *any* token the user could, including a full-access one. CI's authority is therefore not "can grant Tunnel-Edit" but "can grant anything". Accepted for staging on the same isolation argument, and flagged in `docs/DEPLOYMENT.md` as a decision to re-make rather than copy when production is set up. The alternative, had it been chosen, was to create that one token by hand and pass it as a fourth GitHub secret, leaving Terraform to generate only the two HMAC keys.
- Rotation becomes `terraform apply -replace`, which is a command rather than a runbook.
- `docs/OPERATIONS.md` § Secrets no longer says "never in CI" for the runtime set. It says what is true now: they live in Terraform state, and the state's credentials are the boundary.
- The permission-group names are upstream strings this project does not control, so they are variables with preconditions that fail the plan with the API call that lists the real ones — rather than minting a token with no permissions, which fails much later and much less clearly.

## ADR-0041 — A bootstrap root creates the state bucket, so only one credential is human-made

**Status.** Superseded by ADR-0042, 2026-08-06, before it was ever run. Kept because the constraint it wrestles with is real and the next person to consider an object store will meet it again.

**Context.** ADR-0040 moved every runtime secret into Terraform, leaving four manual steps: the Cloudflare account and zone, the CI API token, the R2 state bucket with its S3 keys, and the GitHub Environment. The bucket was the odd one out. It is not something a person needs to decide — it is a container with a name — and creating it by hand meant a dashboard visit, a second token creation flow, and two credentials copied out of a UI that shows them once.

It stayed manual for a real reason: Terraform's state cannot live in a bucket Terraform has not created. `terraform init -backend=false` does not resolve it, because a configuration with a backend block refuses to apply until that backend is initialised.

**Decision.** A second root, `infra/terraform/bootstrap`, with **no backend and local state**. It creates the R2 bucket and an API token scoped to R2 alone, and outputs the S3 key pair the main root's backend needs — the key id being the token's id and the secret the SHA-256 of its value, which is Cloudflare's own derivation for the R2 S3 API.

The main root is unchanged. It still expects a bucket and credentials to exist; it simply no longer expects a person to have made them.

**Consequences.**

- One human-created credential remains: the Cloudflare API token Terraform authenticates with. Everything else is generated.
- **This is a second directory, and it is not the split ADR-0038's environments were kept out of.** That split was per-environment, and would have drifted. This one is per-*account*, identical for staging and production, and run once.
- Its state is local and disposable. Losing it does not break anything: the bucket and token still exist and nothing depends on the state, so Terraform merely stops tracking them. Re-running against a lost state tries to create an existing bucket and fails, which is recoverable with `terraform import` or by skipping the root entirely.
- `prevent_destroy` on the bucket, because a `terraform destroy` that took it would leave the real infrastructure standing with nothing tracking it — unrecoverable without importing every resource by hand.
- The R2 key derivation is the one part not verified against a live account. If the backend fails to authenticate, that is the first thing to doubt; the fallback is the dashboard's R2 token flow, which shows a pair directly. `docs/DEPLOYMENT.md` says so at the point of use.

## ADR-0042 — State lives in HCP Terraform, not in an object store

**Status.** Accepted, 2026-08-06. Supersedes ADR-0041.

**Context.** State had to go somewhere remote, because CI applies and a runner keeps nothing between runs. R2 was the obvious choice — same vendor, one credential already present — and it worked, but every version of it carried a bootstrap: the bucket has to exist before `terraform init` can run, and Terraform cannot create the store its own state lives in.

Three attempts at that bootstrap, each less bad and none good. A manual `wrangler r2 bucket create` plus a dashboard token: two credentials to copy and a step to forget. A separate Terraform root with local state (ADR-0041): a second state that is empty on every CI run, so it tries to recreate an existing bucket. A shell script deriving the S3 key pair from the Cloudflare token before Terraform starts: clever, and it made the pipeline self-sufficient, but it depended on an undocumented-in-our-tree derivation and put a bash prologue in front of every apply.

The common factor is that an object store is a *thing that must already exist*. A managed state backend is not.

**Decision.** HCP Terraform (`app.terraform.io`). The `cloud` block names neither the organization nor the workspace — `TF_CLOUD_ORGANIZATION` and `TF_WORKSPACE` supply both — so one configuration still serves every environment, the same property the backend `key` was carrying before. Workspaces are created on first `init`.

**Consequences.**

- Nothing has to exist before `terraform init`. The bootstrap problem is not solved, it is deleted.
- State locking, run history and a diff view come with it, none of which the bucket had. Concurrent applies were previously prevented only by the workflow's `concurrency` group.
- **One more vendor and one more credential.** GitHub holds three secrets instead of two, and the state — which since ADR-0040 holds every runtime secret — now sits with HashiCorp rather than in the same Cloudflare account as everything else. That is the real cost, and it is the argument someone may want to reverse later; ADR-0041 is kept for them.
- Workspaces must be in **local execution mode**. HCP defaults to remote, where it runs the plan on its own infrastructure — which would mean duplicating the Cloudflare credentials there as workspace variables, exactly the spreading of secrets ADR-0040 removed. This is a per-workspace setting and the one manual step the change adds.
- The CI Cloudflare token no longer needs R2 permissions.

## ADR-0043 — Terraform generates secrets, but never a Cloudflare credential

**Status.** Accepted, 2026-08-06. Supersedes ADR-0040 on the Worker's API token only.

**Context.** ADR-0040 had Terraform create the Worker's Cloudflare token with `cloudflare_api_token`, so that no human typed a credential and rotation was `terraform apply -replace`. The first apply revealed the price. The provider creates tokens through `POST /user/tokens`, so the CI credential needed **User → API Tokens → Edit** — and a token holding that can mint *any* token its user could, including a full-access one. Cloudflare also refuses to grant permissions the creating token does not itself hold, so CI additionally had to carry **Cloudflare Tunnel → Edit** purely to hand it onward.

The result was a CI credential whose authority was not "deploy this project" but "do anything to this Cloudflare account", in service of automating the creation of a token with two permissions.

**Decision.** `infra/terraform/secrets.tf` generates only the two HMAC keys, which grant no authority anywhere. The Worker's Cloudflare token is created by hand once per account and delivered as the GitHub secret `WORKER_CF_API_TOKEN`; the deploy merges it into the bulk file before calling `wrangler secret bulk`.

**Consequences.**

- The CI token loses two rows and can no longer mint a credential or create a tunnel. Compromising the runner now costs a deploy of arbitrary Worker code and zone-settings changes — bad, but bounded, and no longer an escalation to the whole account.
- One manual step per environment, and rotation of that one token becomes a dashboard task rather than a command. Everything else still rotates with `-replace`.
- The Worker's token no longer lives in Terraform state, so the state's blast radius shrinks to two HMAC keys and three identifiers.
- Two lists now have to agree that are not adjacent: `REQUIRED_SECRETS` in `apps/node/src/env.ts`, and what the deploy actually sets. `pnpm deploy:check` compares them and separately asserts that the workflow really writes the one name Terraform does not emit — a missing secret is otherwise a green deploy that refuses every request.
- ADR-0040's own argument for automation stands and is simply outweighed here: the thing being automated was small, and the permission required to automate it was not.
- **Both tokens become account-owned rather than user-owned**, which was impossible while Terraform minted one: `POST /user/tokens` is reachable only by a user token. With that call gone, every request the pipeline makes is account- or zone-scoped. Account tokens outlive the person who created them and cannot carry a user-scoped permission at all, so the scope-dropdown mistake that produced two failed runs is now unrepresentable. They cannot enumerate their own accounts, so `CLOUDFLARE_ACCOUNT_ID` becomes required rather than merely recommended — every job that runs wrangler already passes it.

## ADR-0044 — Federation comes next, ahead of the website and the desktop app

**Status.** Accepted, 2026-08-06. Reorders ADR-0031's placement; the design in ADR-0031 is unchanged.

**Context.** G2 is closed: a real port is open and a tunnel carries traffic on three operating systems. ADR-0031 put federation at Phase 5, "unblocks at G2, not before — well ahead of Phases 3 and 4, and parallel with them", which leaves the reading order ambiguous about what a person should pick up next. The obvious candidates were 2c (the website) and Phase 4 (the desktop app).

Two facts decide it. **v2 is still what serves users** — `nport.link` runs the old Worker, so nothing downstream of v3 is urgent in the way it would be if v3 were live. And **federation changes the shape of `apps/node`**: it gains `NODE_ID`, `PUBLIC_URL`, `REGISTRY_URL`, self-registration, and a usage field on `/v1/meta`; `crates/core` gains a discovery step in front of the `Api` client it already has; and the contract gains a node schema, two route groups and three error codes.

Building the site and the desktop app first would mean building both against a control plane whose configuration surface and client entry point are about to change. The site's docs describe how a client finds a server; the desktop app's Nodes screen (`docs/FEATURES.md` §3) does not exist yet precisely because discovery does not.

**Decision.** Do federation next: `packages/contract`, then `apps/registry`, then `apps/node`'s node fields, then `crates/core::discovery`. 2c and Phase 4 follow it. The phase keeps the number 5 — it is referenced from `CLAUDE.md`, `docs/ARCHITECTURE.md` §1 and ADR-0031, and renumbering four phases to express a priority the ordering-constraints section can state in a sentence is churn for nothing.

**Consequences.**

- The contract changes once, before anything is written against the parts of it that move. That is the same argument as Phase 1.5, applied a second time and for the same reason.
- 2c's own gate, G2c, gates the 3.0 *announcement* rather than the tunnel, so deferring the site does not defer anything a user can reach.
- Federation is where `apps/node` stops being "the control plane" and becomes "a node". Doing that while there is exactly one deployment, and no users on it, is as cheap as it will ever be.
- The v2 shim keeps serving `nport.link` throughout, so this reordering costs no user anything. It does mean v2 stays in production longer, which is the cost being accepted — Phase 6 moves further out.
- The registry holds no Cloudflare credentials and provisions nothing (ADR-0031), so this adds a deployable without adding a credential to protect. The staging pattern from ADR-0038 and ADR-0043 extends to it unchanged.


## ADR-0045 — The subdomain mirror is hand-written logic over generated constants

**Date** 2026-08-06 · **Status** Accepted

**Context.** `packages/contract/src/subdomain.ts` has said since Phase 1.5 that it is "**Mirrored in Rust** so the CLI can reject a bad name instantly instead of spending a round trip on it", and `packages/contract/fixtures/subdomains.json` has said its cases are exercised "by `subdomain.test.ts` AND by `crates/contract`'s Rust mirror, so the two implementations cannot disagree". Neither was true: `crates/contract` held `generated.rs` and `lib.rs`, nothing in `crates/` normalized or validated a subdomain, and the CLI sent whatever `-s` it was handed and waited for the server's `INVALID_SUBDOMAIN`. `docs/ROADMAP.md` records it as defect 34.

Writing the mirror forces two questions the original claim skipped over. **Where does the duplication go?** `RESERVED_SUBDOMAINS` is 53 names, and a second copy kept by hand is the exact shape of defects 22, 25 and 29 — a list standing behind a guarantee, correct until somebody forgets to add `paypal` twice. And **which unicode library?** NFKC is not in the standard library, and the fixtures require it: `ｍｙａｐｐ` must fold to `myapp`, or a full-width name is a visually identical second claim on one lease.

**Decision.** Split the mirror by kind: **constants are generated, rules are reimplemented.**

`pnpm codegen` emits `schema/subdomain.json` — the bounds, the zone suffix, and the three lists — and `cargo xtask codegen` turns it into consts in `crates/contract/src/generated.rs`. Adding a reserved name in `packages/contract` is therefore sufficient, and the drift gate makes it so. The rules — NFKC, the suffix strip, label validation — are written out in `crates/contract/src/subdomain.rs` and pinned against `fixtures/subdomains.json`, which **both** test suites now read.

NFKC comes from **`icu_normalizer`**, which is already in the `nport` binary's dependency graph: `hickory-resolver` → `idna` → `idna_adapter` → `icu_normalizer`. So this declares something the CLI already links — `Cargo.lock` gains one line and no new package — and its Unicode-3.0 licence is already on `deny.toml`'s allowlist for the same transitive reason.

It is declared `default-features = false, features = ["compiled_data"]`, and that is worth recording because the first attempt got it wrong in the direction this ADR is about. Written as a plain `"2.1"`, the defaults pulled `utf16_iter` and `write16` — support for normalizing UTF-16 in place, which nothing here does — while the comment beside it claimed no crate had been added. **The lockfile diff is the check**, not the reasoning that a crate is already present: "already in the graph" is a statement about the package, and features decide what that package drags in.

Length is counted in **UTF-16 code units**, matching JavaScript's `String.length`, because every length check runs before the charset check and therefore decides the *reason* a name is refused. A mirror that refuses the same input for a different reason is a mirror that misleads whoever reads the two messages side by side.

**Consequences.**

- `nport -s my_app` fails in about a millisecond with `invalid-characters`, instead of after a proof-of-work solve and a round trip.
- **The server stays authoritative** (invariant 3). The client refuses early; it never decides. A name the mirror accepts still has to survive `POST /v1/tunnels`, which normalizes again and owns the reserved list at the moment of the claim — and the CLI sends the user's **raw** input, so there is exactly one authority for the value that becomes a lease key.
- `crates/contract` is no longer wholly generated, and three places said it was. The rule is now per-file: `generated.rs` is off-limits, `lib.rs` and `subdomain.rs` are not.
- Three functions are deliberately **not** mirrored — `checkSubdomainShape`, `isReserved` and `isProtectedFromCleanup` — because their callers are the path parameter and the reconciliation sweeper, both server-side. Mirroring them would be untested surface.
- A per-node zone suffix is now one parameter rather than a rewrite, which matters because ADR-0031 gives every node its own domain. **Taken up in defect 36**: the suffix is a parameter on both sides, a node passes its own `CF_DOMAIN`, and `ZONE_SUFFIX` is only the default the client guesses with before it has discovered a node.

**Rejected.** *`unicode-normalization`* — the reflexive choice, and it adds a second copy of the normalization tables to a binary that ships eight platform packages, to compute an answer the tree can already compute. *Generating the rules too* — a code generator that emits NFKC and a suffix loop into another language is a thing nobody should have to debug, and the fixtures already give agreement without it. *Keeping the lists by hand on both sides with a test asserting they match* — workable, but it needs the lists in three places and makes adding a reserved name a two-language edit. *Skipping the mirror and correcting the two docblocks instead* — cheaper, and it leaves the round trip in place along with a fixture file whose whole purpose is cross-language agreement it was not providing.

## ADR-0046 — The registry gets its own OpenAPI document, and capacity is probed rather than claimed

**Date** 2026-08-06 · **Status** Superseded in part by ADR-0049, 2026-08-07

**Half of this is reversed and half survives on new grounds.** The two OpenAPI documents stay, but not
for the reason argued below: both now carry the same `servers` entry, and the split rests on disjoint
path spaces and per-document component reachability. **Capacity is claimed rather than probed**, which
reverses the second half directly — ADR-0049 accepts the objection this ADR raises and explains why it
is worth accepting. Kept in full because that objection is the cost of the decision that replaced it,
and a reader deciding whether to reintroduce a probe should read the argument for one first.

**Context.** ADR-0031 splits the control plane into many **nodes** and one **registry**, and ADR-0044 made that the next phase, contract first. Writing the contract raised three questions ADR-0031 did not have to answer, because they are about the shape of the description rather than about the architecture.

**One document or two?** `packages/contract` generates one OpenAPI document with one `servers` entry, and `ROUTES` was a single table. The registry is a separate deployable on `registry.nport.link` that holds no Cloudflare credentials.

**What is in a node entry?** `docs/FEATURES.md` §1 asks the registry to "collect per-node quota (plan tier, capacity, current usage)" and §3 draws a Nodes screen showing region, latency, plan tier, usage and health.

**How does a nested schema reach Rust?** `GET /v1/nodes` returns an array of objects — the first nesting in this contract. `z.toJSONSchema` inlines nested schemas by default, and `cargo xtask codegen` had no array support at all.

**Decision.**

**Two documents.** `schema/nport-registry.openapi.json` alongside `schema/nport-node.openapi.json`, from a second route table `REGISTRY_ROUTES`. One `servers` entry cannot describe two hosts, and a client generated from a merged document would call `api.nport.link/v1/nodes` — a path that does not exist there. Each document carries only the components it reaches, computed by walking `$ref`s rather than by a hand-kept list. `cargo xtask codegen` reads both and emits one Rust crate, because `crates/core` is a client of both; a name in both documents must mean one shape, and the emitter **checks** that rather than letting one definition win.

**Capacity is observed, never claimed.** A registration carries no `activeTunnels`, `maxActiveTunnels` or `status`. The registry probes the node's `GET /v1/meta` — which it must fetch anyway to know the node is alive — and stores what it saw. A node that could assert `activeTunnels: 0` would be selected first by every client, which is a free denial of service against whoever runs it, on an endpoint that is anonymous by design.

The two capacity fields on `GET /v1/meta` are **optional**, and that is a compatibility decision rather than laziness: discovery reads `/v1/meta` across third-party nodes that may be running older builds, and `contract-v1` is frozen. A required field would make an older node's meta fail to parse and get it delisted for being out of date rather than for being full. **Absent means unknown, and discovery treats unknown as usable** — a node that does not say is not a node that says no.

**Plan tier and latency are not in the contract.** Plan tier is an unverifiable claim about someone else's Cloudflare account, and the fact a client actually selects on is headroom, which the two capacity numbers give directly. Latency has to be client-measured: the registry's distance to a node says nothing about the user's, and a number measured in one datacentre and shown to someone on another continent is worse than none. Both stay in `docs/FEATURES.md` as UI work over data the client gathers.

**Components are converted through a zod registry**, so a component referencing another emits a `$ref` instead of a copy, and the Rust emitter gained `Vec<T>` by recursing through the same type mapping.

**Consequences.**

- Everything is additive to `contract-v1`. No existing route, schema or code changes shape; the control-plane document gains no node types.
- **Health and fullness stay separate.** `status` is `up | degraded | down` and says nothing about capacity, so a client can tell "try later" from "try elsewhere" — which is the distinction the design already draws by disabling full and offline nodes for different reasons.
- **`POST /v1/nodes` needs no `ownerToken`.** Authority to change an entry is re-proved on every call by the DNS TXT record, which beats a bearer token an operator would have to store: it cannot leak from a config file, and it is revoked by deleting a DNS record. The proof is bound to one node id, so publishing a record does not authorise every listing on that domain.
- It is marked non-idempotent for `POST /v1/tunnels`'s reason. The *effect* is an upsert, but a replay cannot succeed because the challenge is single-use, so a caller re-registers with a fresh challenge rather than retrying.
- The zod registry made the Rust emitter's inline-enum lookup unreachable. It was **replaced with a hard error rather than deleted**: without that branch an inline enum falls through to `String` and silently accepts every value the contract forbids.
- `nodeProofRecordName` puts the proof at `_nport-node.<domain>`, under a label no claim can reach — an underscore never passes `SUBDOMAIN_PATTERN` and `_` is a reserved prefix. The same reasoning `_acme-challenge` rests on, and there is a test asserting it rather than a comment.

**Rejected.** *One document with per-operation `servers`* — legal OpenAPI, and it still titles one document "control-plane API" while describing a service that provisions nothing; a generated client would offer node registration against the node's own host. *A `service` discriminator on `RouteDefinition`* — same problem, plus every consumer then has to filter. *Trusting a node's declared capacity* — cheaper, and it rewards lying with traffic. *A registration bearer token* — one more secret for an operator to store and for us to rotate, replacing a proof that is already re-checked on every call. *Emitting a Rust type per document* — `nport_contract::registry::Node` and `nport_contract::api::MetaResponse` split one contract across two module paths for no gain, since `crates/core` uses both.

## ADR-0047 — Worker plumbing shared in a package, rather than imported across deployables

**Date** 2026-08-06 · **Status** Accepted

**Context.** Phase 5 adds a second Worker. ADR-0031 said the registry's enrolment gate is "proof of work (reusing `apps/api/src/domain/pow.ts`)" — quoted as written, before ADR-0049 renamed that app to `apps/node`. The right instinct, and a path that cannot be imported: one app reaching into another's `src` couples two independently deployable Workers, so a refactor inside one silently breaks the other's build, and neither app's `package.json` would record the dependency.

Two things genuinely must not diverge. **Proof of work**, because the two services issue and verify challenges with the same algorithm — an implementation that drifted would verify something subtly different from what the sibling issues, and the failure would look like a client bug. And **the error envelope**, whose shape is fixed by `docs/ERRORS.md` and parsed by every client, including `crates/core`'s typed refusal reader. A second copy of that is how one service starts answering in a shape nothing is parsing for, which is ADR-0018's whole subject.

**Decision.** `packages/worker-kit` — `ApiError`, `envelope`, `retryAfterSeconds`, and the proof-of-work issue/verify/solve functions, moved out of `apps/node` with their tests. Both Workers depend on it; neither depends on the other.

The boundary is **no bindings, no `env`, no Hono**. That is what keeps the package testable under plain vitest rather than `workerd`, and it is the test for whether something belongs here: anything needing a binding stays in the app that owns the binding. So the middleware did *not* move — `requestId`, `rateLimit`, `clientGate` and `requireBindings` are typed against `apps/node`'s own `Env` and read its bindings, and generalising them over a type parameter to share four small functions would trade clarity for reuse nobody asked for.

**Consequences.**

- `apps/node/src/errors.ts` and `src/domain/pow.ts` are gone; imports point at `@nport/worker-kit`. 25 tests moved with them and run faster, since they never needed `workerd` in the first place — they touch no binding.
- **Sharing the algorithm is not sharing the trust boundary.** Each Worker signs challenges with its own `POW_SECRET`, so a challenge issued by the registry is not solvable for a node and vice versa. Worth stating, because "shared proof of work" reads as if it were one pool of challenges.
- `docs/ERRORS.md`'s generated `applies_to` named `apps/node/src/errors.ts`. Fixed in the generator, since the file is generated (invariant 6) — and it is a reminder that frontmatter is a path claim `verify-docs` does not check, because it only reads fenced layout blocks.
- ADR-0031's text still names `apps/node/src/domain/pow.ts`. Left as written: accepted decisions are superseded, never edited, and this entry is the supersession.
- One more package in the graph, and a real cost: `packages/worker-kit` is a third place a Worker change might need to land. Accepted because the alternative is two copies of the code that decides how every failure looks to every client.

**Rejected.** *Importing across `apps/`* — couples two deployables and records the dependency nowhere. *Duplicating both modules* — the drift this repository has spent thirty-five defects learning to distrust, and the error envelope is the worst possible thing to have two of. *Putting them in `packages/contract`* — the contract is the API's authority, not a runtime library; giving it a crypto implementation and an exception class would make "the contract" mean two different things. *A broader `packages/shared`* — a name that invites everything and explains nothing; the next thing that wants sharing should have to argue for its own boundary, as this did.

## ADR-0048 — Prerendered pages are served from Workers Static Assets, and e2e drives the Worker

**Date** 2026-08-07 · **Status** Accepted · **Refines** ADR-0006, ADR-0023

**Context.** `apps/web` deployed a Worker in which **all 33 `/errors/[code]` pages returned 404**. Nothing local could see it. `next build` prerendered every one, `src/lib/error-codes.test.ts` asserted one page per code and passed, and the two routes anyone would check by hand — `/` and `/errors` — worked throughout, because they are fully static and get inlined into the Worker. The broken routes were exactly the ones nothing on the site links to, and they are the ones the product deep-links users to from a failing terminal.

The cause was a reasoning error recorded in `open-next.config.ts` itself: it configured no incremental cache, on the grounds that "there is no ISR and nothing to revalidate, so a KV or R2 cache would be a binding to provision, pay for, and reason about for no behaviour." True about revalidation. Wrong about serving — OpenNext writes pages produced by `generateStaticParams` **into** the incremental cache at build time and reads them back on every request. With no cache the handler threw `NoFallbackError`.

**Decision.** Two parts, and the second is why this is an ADR rather than a bug fix.

1. **`staticAssetsIncrementalCache`.** Prerendered payloads are served from the `.open-next/assets` directory the Worker already deploys. No namespace, no bucket, no binding — the original intent, now achieved. It is **read-only**: `set` and `delete` log an error rather than writing.

2. **`apps/web`'s e2e tier drives the built Worker, not `next dev`.** `playwright.config.ts` runs `opennextjs-cloudflare build && preview`. ADR-0023 said "asserting a deployed route end to end" and this is what that has to mean here: no tier that reads `.next/` or runs `next dev` can see a fault in how the Worker reads its own output, and `apps/web/CLAUDE.md` already warned that a mistake in this layer "deploys an empty site that returns 200".

**Consequences.**

- The read-only cache is a **constraint kept on purpose**. A route that starts needing real revalidation fails loudly instead of quietly serving a stale page — at which point the honest answer is a KV or R2 cache and its own ADR, not a silent upgrade.
- `preview` is required rather than `wrangler dev`, because `populateCache` is the step that copies the payloads into the assets directory. Running bare `wrangler dev` reproduces the same 404s against a build that is fine — a false alarm that cost an investigation during this work, so `playwright.config.ts` says so where someone would hit it.
- The e2e tier is CI's slowest job by an order of magnitude — a full Next build plus `workerd` boot. It gets its own job so it does not delay lint and typecheck.
- **The generated-page count is now load-bearing in two places**, which is the property worth having: the sitemap lists 35 URLs from the contract, and a spec fetches every one. A code added to `packages/contract` that failed to build a page would fail the e2e run rather than 404 for whoever needed it.
- Visual baselines are **armed, on Linux only**: ADR-0023 pins them there because font rasterisation differs per OS, so `apps/web/e2e/visual.spec.ts` skips on any other platform rather than recording a second baseline that would drift from the first. They were recorded by the `web-e2e` job itself and reviewed by eye before being committed; `docs/TESTING.md` § Frontend e2e has the procedure for replacing them.

**Rejected.** *A KV or R2 incremental cache* — real infrastructure to provision and pay for, for a site with nothing to revalidate; correct only once something genuinely revalidates. *`output: "export"`* — would make the whole app static assets and remove OpenNext, which is ADR-0006 territory and a much larger change than the bug warranted. *Testing `next start` instead* — faster and would not have found this, since the fault is in the Worker's own read path. *Leaving the 404s and asserting them* — a red test in CI is not a fix, and these pages are the entire remedy `crates/cli` offers for seven error codes.

## ADR-0049 — One hostname per deployment: a gateway Worker, service bindings, and heartbeat registration

**Date** 2026-08-07 · **Status** Accepted · **Supersedes** part of ADR-0046 · **Refines** ADR-0031

**Context.** Federation gave a deployment two independently-addressed Workers: a node on `api.nport.link` and a registry on `registry.nport.link`. Three things went wrong with that shape before either was deployed.

**Every node operator needs a second hostname** for a service they will almost certainly never run — the registry is one deployment in the world, and `apps/registry` was in neither `deploy.yml` nor Terraform, so nobody had yet paid the cost of wiring even the first one.

**The cross-cutting middleware is duplicated.** `requestId`, `requireBindings`, `clientGate` and `rateLimit` exist in near-identical form in both apps, and each serves its own `GET /v1/challenge`. ADR-0047 moved the pure functions to `packages/worker-kit`, but the middleware could not follow: it reads bindings, and worker-kit's boundary forbids that.

**The registry probes.** Every five minutes it fetched `/v1/meta` from every node it lists, sequentially from one Durable Object — a fan-out that grows with the directory, to learn something each node already knows about itself.

**Decision.** One hostname per deployment, fronted by a **gateway** Worker that dispatches over Cloudflare **service bindings**.

```
api.nport.link ──► gateway (owns the route; the only public Worker)
                     ├──► node      (Cloudflare credentials, the DOs, provisioning)
                     └──► registry  (master deployments only)
```

The internal Workers declare no `routes` and set `workers_dev: false`, so they are unreachable except through the binding. **Role is deployment, not configuration**: a node operator deploys gateway + node, and the registry's code never reaches their account.

**Every registry route lives under `/v1/nodes`.** The gateway dispatches on path prefix, so a route outside that space is one no request can reach. `GET /v1/challenge` forced this: both services had one, and `apps/registry` requires its `POW_SECRET` to differ from the node's precisely so a node's challenge is not redeemable at the registry. Two secrets cannot share one path. The registry's moved to `/v1/nodes/challenge`.

**Liveness inverts.** The registry fetches nothing. A node registers on its cron, having first fetched its own `PUBLIC_URL/v1/health` to confirm the public path works, and carries its capacity in the request. The registry ages what it was told; a node that stops calling is presumed gone.

**Consequences.**

- **Two OpenAPI documents survive on different grounds.** ADR-0046 justified them by "one `servers` entry cannot describe two hosts". Both now carry the same `servers` entry, and the split rests on disjoint path spaces and per-document component reachability — the two properties already under test.
- **Capacity is claimed, not probed**, reversing ADR-0046 directly. Its objection stands and is accepted: a node asserting `activeTunnels: 0` is selected first by every client, a free denial of service against its own operator. The probe was never much of a defence — a node can answer `/v1/meta` with anything — and ADR-0031 already accepts that node operators can read the traffic they carry. A directory of parties trusted with traffic is not made safer by distrusting them about a counter.
- **ADR-0031's third enrolment gate changes.** Proof of work and the DNS TXT proof stay and are re-verified on every registration. The registry's liveness probe is replaced by the node's own check of its public URL, which is strictly closer to what a client experiences — it exercises DNS, the route, the gateway and the node, from outside.

  **Amended 2026-08-08: registration is driven by traffic as well as by the cron.** Cloudflare cron
triggers are best-effort, and staging went two hours without one while serving normally — long enough
for the registry to age node #1 out of the directory and for a fresh client to get `NO_NODE_AVAILABLE`
from a node that was up the whole time. Registration itself was never at fault: a `wrangler tail` caught
four consecutive ticks, five minutes apart, every one succeeding with no exception.

  So `GET /v1/meta` now claims a heartbeat from the Durable Object hop it already makes and re-registers
in `waitUntil` when the last one is over four minutes old. **A node carrying traffic is provably alive**,
which is a better liveness signal than a scheduler tick, and the two mechanisms are independent — either
alone keeps a node listed. A node with *no* traffic still depends on the cron, and that is the right way
round: nobody is affected by an idle node slipping out of a directory nobody is reading it from.

  The claim is atomic, because `/v1/meta` is polled by every client at startup and a plain "is it stale"
check would have all of them registering at once, each paying for a proof-of-work solve.

  **Amended 2026-08-07, after the first federated deploy.** "From outside" is the part that does not hold on a master deployment: `PUBLIC_URL` is the gateway's hostname on the same zone, so the check leaves the Worker and comes straight back into the account. Node #1 dropped out of the directory within ten minutes of every registration while serving traffic the whole time — the check was failing and taking the listing with it. The gate now distinguishes a **refusal** (a status from the edge: real evidence, still fails closed) from **silence** (a timeout or dropped subrequest: no evidence, registers anyway). A node cannot honestly test its own public URL from inside itself, and the honest response to that is to stop pretending the attempt is conclusive. `docs/ROADMAP.md` defect 41.
- **`apps/api` becomes `apps/node`**, `@nport/api` becomes `@nport/node`, `nport-api` becomes `nport-node`, and `api` is removed from the commit-scope list. The name always belonged to the hostname rather than to the Worker, and `api.nport.link` is the gateway's now — leaving the provisioning service called "api" would make every sentence about either one ambiguous. **It costs the staging deployment's Durable Object state**, because DOs cannot follow a script to a new name; staging leases live an hour and the directory has never held a row, and the window to pay nothing for this closed the moment production deployed. `docs/API.md` and `crates/core/src/api.rs` keep their names, because they are about the API a client speaks rather than the service behind it.
- **`sourceHash` crosses the binding as a header.** The gateway computes it and forwards `x-nport-source-hash`; internal services trust it **only because they are not publicly reachable**. That assumption is load-bearing and a stray `routes` entry would silently break it.
- **The gateway is a new single point of failure per deployment.** ADR-0031's "a registry that is down costs nothing" still holds for clients, which cache the list — but registry and node #1 now share a front door where they previously failed independently.
- One more Worker per deployment, one more hop per request. Service bindings avoid DNS and TLS but still count against the subrequest budget.
- An `app` config service is designed for and **not built**. A third binding and a path prefix is all it would take; an empty deployable is a thing to maintain, secure and document for no behaviour (ADR-0047's argument against a speculative `packages/shared`).

**Rejected.** *One Worker with path routing and an env flag* — role becomes configuration, the registry's code ships to every operator's account, and a misconfigured node could serve registry endpoints. *Gateway forwarding over public HTTP* — a full TLS round trip per request, and the internal services stay publicly reachable, which is most of what the split was for. *Keeping two hostnames* — the status quo, and it makes every operator provision DNS for a service they do not run. *Registry-side spot checks alongside heartbeats* — half of both designs: it keeps the fan-out that motivated the change while adding a second source of truth about the same fact.
