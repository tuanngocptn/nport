# Roadmap

Phases and gates. **Individual work items are GitHub Issues labelled `phase-N`, not entries in this file** (ADR-0016).

A gate is a hard stop: every criterion must pass before the next phase starts. Gates exist because the alternative — discovering the data plane doesn't work after building three apps on top of it — is how rewrites die.

## Current position

**Phase 1 in progress — sub-steps 1–4 of 7 done.** Gate G0 is closed locally: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `cargo fmt --check`, `clippy -D warnings`, and `cargo test` all pass. CI has not run yet — nothing is pushed.

`crates/protocol` parses tokens, discovers the edge, completes a QUIC handshake, and **registers a connection** with the live edge. Everything else is still a stub. Two and a half of the six open questions in `docs/PROTOCOL.md` §17 are answered, and risks P1, P2, and P3 are closed — the three that made step 4 the expected time sink.

## Phase 0 — Docs and skeleton

Documentation set, directory skeleton, then workspace configs and green CI on an essentially empty tree.

- [x] `docs/` set, root and per-app `CLAUDE.md`, directory skeleton
- [x] `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `biome.jsonc`, `packages/tsconfig`
- [x] `Cargo.toml` workspace, `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `deny.toml`
- [x] `wrangler.jsonc` for both Workers
- [x] `.gitignore`, `.editorconfig`, `.nvmrc`, `lefthook.yml`
- [x] `ci.yml`, `codegen-drift.yml`
- [x] `.github/` issue templates, PR template, CODEOWNERS

Five crate stubs exist so `cargo` has something to check: `nport` (bin), `nport-core`, `nport-protocol`, `nport-contract`, and `xtask`. `xtask`'s four subcommands are recognized no-ops, which is the honest answer for a tree with nothing generated in it — and it means `codegen-drift.yml` is wired and starts biting for real the moment codegen produces something. Pins and the reasoning behind them are in ADR-0022.

**Gate G0.** `pnpm install && pnpm lint && pnpm test && cargo clippy && cargo test` all pass on the skeleton, and CI is green. The TypeScript half passes locally; the Rust half is unverified until a toolchain runs it — first push, or `rustup` locally.

## Phase 1 — Protocol spike ⛔ blocks everything

The highest-risk work, done first and alone. A throwaway `crates/protocol/examples/spike.rs` — no `TunnelManager`, no CLI, no abstraction. Just prove the protocol works from Rust.

**No backend work is needed.** Point the spike at the existing v2 `api.nport.link`, which already mints real tunnel tokens in exactly the format `docs/PROTOCOL.md` §3 describes. This is why Phase 1 can precede Phase 2.

Ordered sub-steps, each independently verifiable:

1. ~~Parse a tunnel token; assert the redaction and zeroize behaviour~~ — **done**, `crates/protocol/src/token.rs`
2. ~~Edge discovery — start with the direct A/AAAA shortcut (`docs/PROTOCOL.md` §4), add SRV after~~ — **done**, `crates/protocol/src/edge.rs`; both paths verified against the live edge on 2026-08-03. DoT fallback still outstanding (needs a hickory TLS feature)
3. ~~QUIC handshake: ALPN `argotunnel`, SNI `quic.cftunnel.com`, keep-alive 1 s~~ — **done**, `crates/protocol/src/quic.rs`; verified live 2026-08-03. Two spec corrections came out of it: the edge presents a Cloudflare Origin CA certificate, and `MaxIncomingStreams` must not be copied literally into quinn (`docs/PROTOCOL.md` §5)
4. ~~Cap'n Proto `registerConnection` over the control stream — **no preamble** (§6, trap 1)~~ — **done**, `crates/protocol/src/rpc.rs`; registered against the live edge on 2026-08-03, colo `hkg09`. Risk P1 closed and the §8 interfaceId correction confirmed empirically
5. `ConnectRequest` framing; answer one HTTP GET end-to-end
6. WebSocket upgrade and bidirectional pipe
7. Four-connection pool with staggered start, per-index edge rotation, reconnect

Step 4 was expected to be the time sink — capnp-RPC interop (P1) plus the no-preamble trap — and it registered first try, because both variables had been removed beforehand: the `interfaceId` from source (§8) and the interop by using `capnp-rpc`'s two-party vat rather than hand-encoding. No packet capture was needed.

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
