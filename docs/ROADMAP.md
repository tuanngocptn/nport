# Roadmap

Phases and gates. **Individual work items are GitHub Issues labelled `phase-N`, not entries in this file** (ADR-0016).

A gate is a hard stop: every criterion must pass before the next phase starts. Gates exist because the alternative — discovering the data plane doesn't work after building three apps on top of it — is how rewrites die.

## Current position

**Phase 1 done, Phase 1.5 closed, Phase 2a past its hardest slice.** The lease lifecycle — claim, saga, heartbeat, delete, alarm-driven expiry — is implemented and tested in real `workerd`. 2b and 2c have not started.

G1 criteria 2, 3, and 4 met; 5 is partial; 1 is unverified for want of dashboard access. Gate G0 is closed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `cargo fmt --check`, `clippy -D warnings`, `cargo test`, and both codegen steps pass locally and in CI. **Nothing has been deployed** — no Worker, no DNS record, no Cloudflare API call outside the protocol spike's own tunnels.

`crates/protocol` parses tokens, discovers the edge, completes a QUIC handshake, registers connections, **proxies HTTP end-to-end**, **carries WebSockets**, and **sustains a four-connection pool across forced disconnects**. Two and a half of the six open questions in `docs/PROTOCOL.md` §17 are answered, and risks P1, P2, and P3 are closed.

| G1 criterion | State |
| --- | --- |
| 1 · `healthy` in the Cloudflare dashboard | **not directly verified** — no dashboard access from here. Four connections registering, reporting their colo, and serving 340 exchanges is strong indirect evidence, but it is not the same check |
| 2 · byte-identical body and headers | ✅ 2026-08-03, both directions including request bodies |
| 3 · WebSocket echo, 100 messages | ✅ 2026-08-03, plus a 64 KiB frame |
| 4 · 30 min across 4 connections and a forced disconnect | ✅ 2026-08-03, 99.6–99.8% per connection, and **338 of 339 requests during the window returned 200** — the pool's exchange count matches the client's success count, so every request that reached it was served |
| 5 · golden fixtures for every frame type | **partial** — 2 of 7, the edge→client ones. The rest need cloudflared (`docs/TESTING.md`) |

The two gaps are both "needs access I do not have" rather than "needs design": criterion 1 wants the Cloudflare dashboard, criterion 5 wants cloudflared installed. Neither blocks Phase 1.5, and neither is a protocol risk — the behaviour they would confirm is already exercised.

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
5. ~~`ConnectRequest` framing; answer one HTTP GET end-to-end~~ — **done**, `crates/protocol/src/connect.rs`; `curl https://spike.nport.link/health?q=1` returned the origin's 43-byte body **byte-identical** with `content-type` and a custom header preserved, 2026-08-03. **This is G1 criterion 2.**
6. ~~WebSocket upgrade and bidirectional pipe~~ — **done**, `crates/protocol/examples/spike.rs` plus `WEBSOCKET_ORIGIN_HEADERS` in `connect.rs`; 100 alternating text/binary round-trips and a 64 KiB frame came back byte-identical through colo `hkg09`, 2026-08-03. **This is G1 criterion 3.** Run it with `tests/live/tunnel.sh builtin <sub>` in one terminal and `--example ws_client` in another
7. ~~Four-connection pool with staggered start, per-index edge rotation, reconnect~~ — **done**, `crates/protocol/src/edge.rs` (`AddressPool`) plus `examples/pool.rs`. A 30-minute run on 2026-08-03 held four connections at **99.6–99.8% availability each** across five forced disconnects, 340 exchanges, and **zero** dial or registration failures; each loss rotated to the other region and re-registered. **This is G1 criterion 4.**

Step 6 was mostly wiring, because step 5's live run had already shown `type Websocket` arriving correctly and being refused — the dispatch was proven before the handler existed. What it did cost was the two forwarding directions: the upgrade headers the edge does not send, and the origin bytes already queued behind its response head (`docs/PROTOCOL.md` §11).

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

Short, and the real serializing dependency. Until it exists, Phase 2's tracks cannot parallelize. After it, they barely interact.

- [x] `packages/contract`: 30 error codes, 6 routes, subdomain normalization and validation, shared `fixtures/subdomains.json`
- [x] `docs/ERRORS.md` **generated** from the registry
- [x] `schema/nport-api.openapi.json` with named component schemas, and `schema/errors.json` for the metadata JSON Schema cannot express
- [x] `crates/contract` generated by `cargo xtask codegen` (ADR-0025 — not `typify`, and why)
- [ ] tag `contract-v1` — waiting on a push, since nothing is on a remote yet

**Gate G1.5 — closed 2026-08-03.** `pnpm codegen && cargo xtask codegen` leave the tree clean, `crates/contract` compiles, and every code round-trips: 73 TypeScript tests including a check that `docs/ERRORS.md` and the registry agree in both directions, plus 13 Rust tests including the documented error envelope.

The one deliverable outstanding is the tag, which needs a remote. Everything Phase 2 consumes exists.

## Phase 2 — Three parallel tracks

### 2a · `apps/api`

**In progress.** The lease lifecycle works end to end against a fake Cloudflare; abuse controls and reconciliation are next.

- [x] Hono app, `ApiError` → envelope error handler, request-id from `cf-ray`
- [x] client gate with the minimum-version floor
- [x] stateless proof-of-work: HMAC-signed challenge, bit-level difficulty, `GET /v1/challenge`
- [x] `GET /v1/meta`, `GET /v1/health`, `GET /` redirect
- [x] `SubdomainLease` and `Registry` DOs; the journaled provisioning saga with compensations
- [x] `POST /v1/tunnels`, heartbeat, delete, status
- [x] alarm-driven expiry, including the heartbeat-timeout and abandoned-saga paths
- [x] 123 tests in real `workerd`
- [ ] rate limiting and per-source caps; dynamic PoW difficulty
- [ ] the reconciliation cron, and the `Registry` sweep cursor it walks
- [ ] the legacy v2 method-dispatch shim

Closed here: **R3** (the saga journals every step before its side effect and compensates in reverse), **R4** (one DO per normalized name, and the read-check-journal sequence holds no `await`, so concurrent claims cannot both win), **R6** (`expires_at` is server-owned and a heartbeat does not extend it), and **R7** (a lease cannot be taken while live, and no DNS record is deleted unless it is a `CNAME` whose content is exactly `<tunnel_id>.cfargotunnel.com`). Also **R5**, **R10**, **R11**, and the create half of **R9**.

Three things worth knowing before this deploys:

- **The Cloudflare API paths are unverified.** v2 used the legacy `/accounts/{id}/tunnels`; this uses the current `cfd_tunnel` name for the same resource. Nothing here has run against the live API, so the first deploy has to confirm it — everything else in 2a is exercised against `test/fake-cloudflare.ts`.
- **The global cap is soft.** `MAX_ACTIVE_TUNNELS` is checked before the claim, so a burst of simultaneous creates can overshoot by roughly its own concurrency. It is a capacity guard, not a security boundary; the per-source caps in the next slice are what bound a single abuser.
- **A permanently failing teardown holds its name.** Deliberate — the alternative is issuing a URL that points at a tunnel we could not confirm is gone. The watchdog alarm retries, and the reconciliation cron is the backstop that does not exist yet.

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
- **Phase 1.5 precedes Phase 2.** Without a frozen contract the tracks collide. ✅ closed
- **Phase 4 follows Phase 3.** The desktop app needs a stable `core`.
- 2a, 2b, and 2c are genuinely parallel once the contract is frozen.

## Deferred

Not scheduled. Each needs an ADR to promote. See `docs/ARCHITECTURE.md` §9 for why each is out of scope.

TCP/UDP/ICMP tunnelling (ADR-0020) · custom domains · tunnel password protection · multiple ports per tunnel · CLI traffic inspection · request replay in the desktop inspector · self-hosted control-plane one-click deploy.
