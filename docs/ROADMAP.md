# Roadmap

Phases and gates. **Individual work items are GitHub Issues labelled `phase-N`, not entries in this file** (ADR-0016).

A gate is a hard stop: every criterion must pass before the next phase starts. Gates exist because the alternative — discovering the data plane doesn't work after building three apps on top of it — is how rewrites die.

## Current position

**Phase 0, in progress.** Documentation and the directory skeleton exist. No code, no configs, no CI.

## Phase 0 — Docs and skeleton

Documentation set, directory skeleton, then workspace configs and green CI on an essentially empty tree.

- [x] `docs/` set, root and per-app `CLAUDE.md`, directory skeleton
- [ ] `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `biome.jsonc`, `packages/tsconfig`
- [ ] `Cargo.toml` workspace, `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `deny.toml`
- [ ] `wrangler.jsonc` for both Workers
- [ ] `.gitignore`, `.editorconfig`, `.nvmrc`, `lefthook.yml`
- [ ] `ci.yml`, `codegen-drift.yml`
- [ ] `.github/` issue templates, PR template, CODEOWNERS

**Gate G0.** `pnpm install && pnpm lint && pnpm test && cargo clippy && cargo test` all pass on the skeleton, and CI is green.

## Phase 1 — Protocol spike ⛔ blocks everything

The highest-risk work, done first and alone. A throwaway `crates/protocol/examples/spike.rs` — no `TunnelManager`, no CLI, no abstraction. Just prove the protocol works from Rust.

**No backend work is needed.** Point the spike at the existing v2 `api.nport.link`, which already mints real tunnel tokens in exactly the format `docs/PROTOCOL.md` §3 describes. This is why Phase 1 can precede Phase 2.

Ordered sub-steps, each independently verifiable:

1. Parse a tunnel token; assert the redaction and zeroize behaviour
2. Edge discovery — start with the direct A/AAAA shortcut (`docs/PROTOCOL.md` §4), add SRV after
3. QUIC handshake: ALPN `argotunnel`, SNI `quic.cftunnel.com`, keep-alive 1 s
4. Cap'n Proto `registerConnection` over the control stream — **no preamble** (§6, trap 1)
5. `ConnectRequest` framing; answer one HTTP GET end-to-end
6. WebSocket upgrade and bidirectional pipe
7. Four-connection pool with staggered start, per-index edge rotation, reconnect

Expect step 4 to be where time goes: it combines the `interfaceId` ambiguity (P2), capnp-RPC interop (P1), and the no-preamble trap. Attack it with a packet capture and cloudflared running side by side.

**Gate G1 — go/no-go. All five required.**

1. The tunnel reaches `healthy` in the Cloudflare dashboard, driven by the Rust client alone
2. `curl https://spike.nport.link` returns the local server's body **byte-identical, including headers**
3. A WebSocket echo survives 100 messages in both directions
4. 30 minutes sustained across 4 connections, surviving a forced edge disconnect
5. Golden byte fixtures captured for every frame type (`docs/TESTING.md`)

Answer the six open questions in `docs/PROTOCOL.md` §17 as you go and record them there with dates — that is a deliverable of this phase, not a side effect.

**If G1 fails, take the ADR-0017 ladder** — HTTP/2 transport first, then the `CloudflaredConnector` shim. Do not extend the timebox by pressing on; the ladder exists precisely so that a failure here costs a transport, not the release.

## Phase 1.5 — Contract freeze

Short, and the real serializing dependency. Write `packages/contract` and `docs/ERRORS.md` completely; generate `schema/nport-api.openapi.json` and `crates/contract`; tag `contract-v1`.

Until this exists, Phase 2's tracks cannot parallelize. After it, they barely interact.

**Gate G1.5.** Codegen is clean, `crates/contract` compiles, and every code in `docs/ERRORS.md` round-trips to the registry.

## Phase 2 — Three parallel tracks

### 2a · `apps/api`

Hono routes under `/v1`; `SubdomainLease` and `Registry` DOs; the journaled provisioning saga with compensations; subdomain normalization and validation; the reserved list; proof-of-work challenge and verification; rate limiting and caps; alarm-driven expiry; the reconciliation cron; the legacy v2 method-dispatch shim; workerd integration tests covering alarms and storage.

### 2b · `crates/core` + `crates/cli`

Promote the spike into `crates/protocol` proper behind the `Transport` trait; build `TunnelManager` with the connection pool, reconnect, and local proxy; the `TunnelEvent` stream; `core::inspector` behind an optional sink; the API client over `crates/contract`; then the CLI — `clap` parsing, terminal rendering, `~/.nport/config.toml`, i18n (en/vi/es, auto-detected), signal handling and graceful shutdown.

2b consumes the API **only** through `crates/contract`, so it develops against `wrangler dev` or a mock and never blocks on 2a.

### 2c · `apps/web`

Next.js + OpenNext; v2 marketing parity (section order and copy per `apps/web/CLAUDE.md`); MDX user docs; `/errors/[code]` pages generated from the contract; SEO parity including the four JSON-LD blocks; one GA4 property.

**Gate G2.** `nport 3000 -s test` works end-to-end against the new API on macOS, Linux, and Windows, including WebSocket, graceful Ctrl+C, and server-enforced expiry.

## Phase 3 — Release pipeline and beta

Cross-compile matrix on native runners (`cross` only for the two musl targets); the nine npm packages; `cargo publish`; Homebrew tap; Scoop manifest; GitHub Releases with provenance attestation; `smoke.yml`; **`protocol-canary.yml`**.

Publish `3.0.0-beta.N` and iterate on real user reports.

**Gate G3.** Seven consecutive green nightly smoke runs across six OS targets before `3.0.0` is tagged `latest` on npm.

## Phase 4 — `apps/desktop`

Deliberately last: it consumes a *stable* `crates/core`, and building it earlier would churn core's API for a GUI that no one is using yet.

Tunnel list and one-click start; tray integration; the traffic inspector over `core::inspector`; settings; auto-update via the updater manifest; signing and notarization per platform.

## Phase 5 — v2 sunset

Keep the legacy shim alive for installed 2.x clients. Then, in order: `npm deprecate nport@2` with a pointer to the 3.x migration note; announce a date; after that date return `426 CLIENT_TOO_OLD`; eventually remove the shim.

Dates and the exact sequence live in `docs/RELEASE.md`.

## Ordering constraints

- **Phase 1 precedes everything.** An unproven data plane invalidates the CLI and desktop designs.
- **Phase 1.5 precedes Phase 2.** Without a frozen contract the tracks collide.
- **Phase 4 follows Phase 3.** The desktop app needs a stable `core`.
- 2a, 2b, and 2c are genuinely parallel once the contract is frozen.

## Deferred

Not scheduled. Each needs an ADR to promote. See `docs/ARCHITECTURE.md` §9 for why each is out of scope.

TCP/UDP/ICMP tunnelling (ADR-0020) · custom domains · tunnel password protection · multiple ports per tunnel · CLI traffic inspection · request replay in the desktop inspector · self-hosted control-plane one-click deploy.
