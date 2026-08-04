# Roadmap

Phases and gates. **Individual work items are GitHub Issues labelled `phase-N`, not entries in this file** (ADR-0016).

A gate is a hard stop: every criterion must pass before the next phase starts. Gates exist because the alternative — discovering the data plane doesn't work after building three apps on top of it — is how rewrites die.

## Current position

**Phase 1 done, Phase 1.5 closed and tagged, Phase 2a feature-complete, 2b started.** The whole control plane — lease lifecycle, abuse controls, reconciliation, and the v2 compatibility shim — is implemented and tested in real `workerd`. 2c has not started.

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
- [x] tag `contract-v1` — annotated, pushed 2026-08-04

**Gate G1.5 — closed 2026-08-03, tagged 2026-08-04.** `pnpm codegen && cargo xtask codegen` leave the tree clean, `crates/contract` compiles, and every code round-trips: 78 TypeScript tests including a check that `docs/ERRORS.md` and the registry agree in both directions, plus 13 Rust tests including the documented error envelope.

The tag waited on two things, both now satisfied: a remote, and the contract having met **real** Durable Objects rather than only a type-checker. Phase 2a exercised all six routes and all thirty codes end to end before `contract-v1` was cut. Two additions landed in between, both purely additive — `validateSubdomainShape` and `checkSubdomainShape`, which let a path parameter refer to a generated `nport-` name that the claim validator must still reject.

## Phase 2 — Three parallel tracks

### 2a · `apps/api`

**Feature-complete, undeployed.** Everything 2a set out to build exists and is tested in real `workerd` against a fake Cloudflare. What remains is not code: the Cloudflare API paths have never met the live API, and the zone-level rate limit is a dashboard setting.

- [x] Hono app, `ApiError` → envelope error handler, request-id from `cf-ray`
- [x] client gate with the minimum-version floor
- [x] stateless proof-of-work: HMAC-signed challenge, bit-level difficulty, `GET /v1/challenge`
- [x] `GET /v1/meta`, `GET /v1/health`, `GET /` redirect
- [x] `SubdomainLease` and `Registry` DOs; the journaled provisioning saga with compensations
- [x] `POST /v1/tunnels`, heartbeat, delete, status
- [x] alarm-driven expiry, including the heartbeat-timeout and abandoned-saga paths
- [x] rate limiting, per-source caps, and per-source PoW escalation (ADR-0028)
- [x] the reconciliation cron and the `Registry` sweep cursor it walks
- [x] the legacy v2 method-dispatch shim
- [x] 177 tests in real `workerd`

Closed here: **R3** (the saga journals every step before its side effect and compensates in reverse), **R4** (one DO per normalized name, and the read-check-journal sequence holds no `await`, so concurrent claims cannot both win), **R6** (`expires_at` is server-owned and a heartbeat does not extend it), **R7** (a lease cannot be taken while live, and no DNS record is deleted unless it is a `CNAME` whose content is exactly `<tunnel_id>.cfargotunnel.com`), and **R9** — all five layers: zone limiting is a dashboard setting, the Workers rate limiter is keyed on `HMAC(ip, secret)` + ASN, `SourceQuota` bounds concurrent and hourly creates per source, proof of work escalates per source, and the global cap returns 503. Also **R5**, **R10**, and **R11**.

Three things worth knowing before this deploys:

- **The Cloudflare API paths are unverified.** v2 used the legacy `/accounts/{id}/tunnels`; this uses the current `cfd_tunnel` name for the same resource. Nothing here has run against the live API, so the first deploy has to confirm it — everything else in 2a is exercised against `test/fake-cloudflare.ts`.
- **The global cap is soft.** `MAX_ACTIVE_TUNNELS` is checked before the claim, so a burst of simultaneous creates can overshoot by roughly its own concurrency. It is a capacity guard, not a security boundary — the per-source caps are what bound a single abuser, and those *are* hard: `SourceQuota.reserve` takes the slot and records the attempt in one synchronous, await-free step.
- **Zone-level rate limiting is a dashboard setting, not code.** `docs/ARCHITECTURE.md` §7's outermost layer lives in the Cloudflare dashboard for `api.nport.link` and has not been configured, because nothing is deployed. `docs/OPERATIONS.md` owns it.
- **A permanently failing teardown holds its name.** Deliberate — the alternative is issuing a URL that points at a tunnel we could not confirm is gone. The watchdog alarm retries, and the reconciliation cron now backs it up.
- **The v2 shim is the weakest path in the system, deliberately.** It gets the rate limiter, the per-source caps, and the global cap — but **no proof of work**, because a 2.x client cannot solve a challenge, and no `ownerToken`, because the concept did not exist when those clients shipped. Its delete is authorized by source hash against a lease explicitly flagged `legacy`, so it can never reach a `/v1` tunnel. Every day it stays open is a day the cheapest way to create a tunnel is the old one; `docs/RELEASE.md` owns the sunset.
- **The sweep will not delete a DNS record it cannot prove it owns, and therefore leaves some orphans behind.** An orphan has no lease to say what its record should point at, so the proof used instead is the orphan tunnel's own ID — which means the record is deleted *before* the tunnel, while the proof still exists. A record pointing anywhere else is logged and left for a human (`docs/OPERATIONS.md`). Closing that gap automatically would mean deleting records on weaker evidence than invariant 8 allows, which is v2's takeover defect.

**Every review pass of this track's concurrency and cleanup has found a reachable bug in code that had already passed the full gate.** Five so far, all fixed and tested:

1. An absent-row window across an outbound RPC, letting a second claim start a saga on a name still being torn down.
2. A mid-saga lease reclaimed on a wall-clock check that never verified the saga was actually dead — which left a live tunnel with no lease, so nothing would reap it.
3. A shared placeholder that let simultaneous generated-name creates pass the per-source cap on one slot: five tunnels against a cap of three.
4. `reserve` overwriting a *confirmed* hold's expiry, and the failure path then deleting it — so a source at its cap could re-request a name it already held, take the correct `409`, and come away one slot lighter. Repeatable per lease, which defeated the concurrency cap entirely, bounded only by the hourly quota.
5. The sweep cursor advancing only after a clean run, so a single undeletable orphan would pin reconciliation to its page and starve every other page — R8 again, through a door nobody was watching.

The shape is nearly the same each time: **a check separated from the state change it guards** — by an `await` in the first two, by a key two requests could share in the next two, and by a failure path in the fifth. In every case a comment nearby asserted the invariant the code failed to enforce, which is the most reliable place to look. The passing suite caught none of them; each was found by reading, then reproduced with a test written afterwards. The prediction that a fifth existed was correct, so assume a sixth.

One flaky test came out of the same work, worth recording for what it was asserting: the "refuses an unsolved challenge" case used a hardcoded `nonce: "0"`, which satisfies the 4-bit difficulty these tests run at one time in sixteen. A 6%-flaky test claiming proof of work is enforced is the worst possible thing to be flaky about. It now searches for a nonce verified *not* to satisfy the difficulty.

### 2b · `crates/core` + `crates/cli`

**Started.**

- [x] the `Transport` trait in `crates/protocol/src/lib.rs`, implemented for QUIC
- [x] promote the spike's proxy loop — the half of it that is protocol
- [x] `core::proxy` — the origin-side response handling, with the chunked-encoding regression tests
- [x] `core::event` — the `TunnelEvent` stream, carrying codes and never prose
- [x] `core::retry` — classification, the consecutive-failure budget, and jittered backoff
- [x] `core::supervisor` — the pool's decisions: start order, reconnect, rotation, give-up
- [x] `core::local_runtime` — ADR-0024's `!Send` thread boundary, implemented
- [x] `TunnelManager` — the supervision tasks, event broadcast, and shutdown
- [ ] the QUIC `Connector`: edge discovery, dial, register, serve — wiring the manager to a real edge
- [ ] `core::inspector` behind an optional sink
- [ ] the API client over `crates/contract`
- [ ] the CLI — `clap` parsing, terminal rendering, `~/.nport/config.toml`, i18n (en/vi/es, auto-detected), signal handling and graceful shutdown

2b consumes the API **only** through `crates/contract`, so it develops against `wrangler dev` or a mock and never blocks on 2a.

The trait covers **dialling and stream opening and nothing else** — registration and framing are shared above it, which is what makes ADR-0017's ladder a transport swap rather than a rewrite. Its two methods are deliberately asymmetric: the control stream is client-opened and the data streams are edge-opened (`docs/PROTOCOL.md` §6), and that asymmetry is exactly what lets HTTP/2 implement it, since under h2 the client runs a *server* and the edge sends it requests. A trait built around "the client opens streams" could not express that.

It is tested against a **second implementation over in-memory pipes**, not only against QUIC. A trait with one implementor tends to end up shaped like that implementor, and the fallback's whole value rests on the shape being general — so the loopback double is the assertion that it is. That double is also what `crates/core` will drive its proxy loop against without a network.

**The proxy loop split, rather than moving wholesale.** The layering in `crates/CLAUDE.md` is explicit that `crates/core` owns "provision → connect → proxy → teardown", and `crates/protocol` "speaks the wire and nothing else". So only the half that is wire went into `connect.rs`: `request_head`, which turns a decoded `ConnectRequest` into an HTTP/1.1 request head. That mapping is protocol-defined — `docs/PROTOCOL.md` §7 fixes the `HttpMethod`, `HttpHost`, and `HttpHeader:<Name>` keys — so it belongs beside the codec that decoded them. Dialling the origin, decoding chunked bodies, and piping WebSocket bytes stay in the example until `TunnelManager` claims them, because those are about the *local* origin and not about Cloudflare's wire.

That function had **no tests at all** while it lived in the example, despite owning both the hop-by-hop stripping and the content-length recomputation — the two rules behind the chunked-encoding bug that made a real app render as hex chunk sizes. It now has seven, including one asserting a repeated header is not collapsed and one asserting a bodyless request carries no `content-length`.

**`core::proxy` took the other half.** `ResponseHead::parse` and `decode_chunked` are what turn the local origin's HTTP/1.1 answer into something the edge can carry, and both are pure — so all sixteen tests run without a socket. They include the regression for the bug a user actually hit: a chunk-size line of `1c8d` read as decimal instead of hex is where that whole class starts.

**Events and reconnect policy came before the supervisor**, because neither the supervisor nor the CLI can be written without them. `core` is headless, so emitting a `TunnelEvent` *is* how it speaks — and every failure variant carries an `ErrorCode` rather than a message, because only `crates/cli` knows the user's language. v2 built chalk-coloured English inside `Error.message` in its transport layer, which bypassed i18n entirely (defect R20); a `message: String` on any variant here would do the same thing again.

`core::retry` is pure, so the whole of §12's classification is testable without a network: `EDUPCONN` rotates (retrying the same address loops forever, because the edge is saying *that* address already holds our index), `Unauthorized` retries the same address (a fresh tunnel is still propagating), and an uninterpretable response is fatal and maps to `EDGE_PROTOCOL_ERROR` — the one code whose documented action is "likely a Cloudflare protocol change", and the failure with the largest blast radius in the system.

**Backoff is fully jittered, which the spike deliberately was not.** `examples/pool.rs` says so in a comment: one process with four connections has nothing to de-synchronise against, but a released client does — an edge blip disconnects thousands at once, and without jitter every one retries on the same schedule and re-creates the outage. Full jitter rather than `scaled ± a bit`, because a partial-jitter peak still rebuilds the herd. The fraction is a parameter so the function stays pure and its tests stay deterministic.

**`core::supervisor` holds the pool's decisions and no sockets.** Start order, reconnect, rotation, the retry budget, and when to give up are all functions of stored state and one observation, so the whole policy is tested without a timer or an edge. The task that owns sockets asks it what to do; it never encodes a rule itself. That split is deliberate after 2a: a decision buried inside an I/O loop is one nobody can test in isolation, and every one of the five bugs above lived in exactly that kind of place.

Three rules in it are worth knowing because getting them backwards is silently expensive. Connection 0 registers before the others start (§4) — launching all four at once ends with three refusals and one survivor. A **loss** reconnects immediately, without rotating and without spending the retry budget: the address was working a moment ago, the pool is short a connection until it returns, and the edge recycles connections all day, so counting those would exhaust the budget of whichever connection works hardest. And a **`Malformed` response gives up at once** rather than retrying, because that is what a Cloudflare protocol change looks like from here, and spinning on it would bury the one signal worth paging about.

**ADR-0024 is implemented rather than pending.** `capnp-rpc` holds `Rc`, so registration futures are `!Send` and `tokio::spawn` refuses them. `core::local_runtime` gives that region a thread of its own: jobs arrive over a channel, results leave over one, and only `Send` data crosses. The closure is `Send` because it must cross the channel; the future it returns need not be, which is the whole mechanism — the `Rc`s are created on the far thread and never leave it. The test that matters holds an `Rc` across an await, which is exactly the shape `tokio::spawn` rejects.

The spike put all four supervisors on one shared `LocalSet`, which the ADR calls the wrong shape to ship: it pushes a dependency's implementation detail into every consumer and serialises unrelated per-connection work. Jobs here are `spawn_local`'d, so four registrations still run concurrently — there is a test for that too. Cost is one extra thread per process, not per connection, and one channel hop on a path that already spends hundreds of milliseconds on the network.

**`TunnelManager` owns sockets and timers and no rules.** Every decision comes from `core::supervisor`; this layer only carries them out. It is generic over a `Connector`, so the whole supervision loop — backoff, rotation, giving up, the pool surviving one dead index — is tested against fakes with no edge at all. `TunnelHandle::shutdown` **consumes the handle**, so v2's double-Ctrl+C double-delete (defect R19) does not compile rather than being guarded at runtime.

Writing its tests found a real design hole. `Supervisor::exhausted` only reported "every connection gave up" — but §4 gates indices 1..N-1 on connection 0 registering, so a lead that dies *before ever registering* leaves the rest in `Waiting` forever and that condition is never true. The tunnel would hang, healthy-looking, having never carried a byte. Worse than failing: a CLI would sit there instead of exiting non-zero. A lead that gives up having never registered is now terminal, and a lead that dies *after* registering still is not, because by then the others are serving.

The spike's copies are gone rather than left to drift, which needed `nport-core` as a **dev-dependency** of `crates/protocol`. That is a cycle, and it is deliberate: Cargo permits it, it stays out of `nport-protocol`'s library graph, and the alternative was two implementations of the dechunker with only one of them tested — while the untested one is what runs against the live edge. Outside `[dev-dependencies]` it would be the architectural regression `crates/CLAUDE.md` warns about.

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
