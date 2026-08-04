# Roadmap

Phases and gates. **Individual work items are GitHub Issues labelled `phase-N`, not entries in this file** (ADR-0016).

A gate is a hard stop: every criterion must pass before the next phase starts. Gates exist because the alternative — discovering the data plane doesn't work after building three apps on top of it — is how rewrites die.

## Current position

**Phase 1 done, Phase 1.5 closed and tagged, Phase 2a feature-complete, 2b code-complete.** The whole control plane — lease lifecycle, abuse controls, reconciliation, and the v2 compatibility shim — is implemented and tested in real `workerd`, and `crates/core` plus the `nport` binary provision, connect, proxy, inspect, and tear down. 2c has not started.

**No port has yet been opened to the internet by this code**, because nothing is deployed. Every client-side piece is written and tested — against fakes, against golden fixtures, against a loopback transport double — and none of it has met a live control plane, because there is no live control plane. That one fact is the entire critical path below.

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

## The critical path — open a port to the internet

**This is the only work that matters until Gate G2 closes.** `docs/FEATURES.md` describes a much larger product; almost none of it is on this path, and the mapping below says where each part goes instead. The ordering is deliberate: the one thing NPort must do is turn `nport 3000` into a URL that serves a local port, and that has never once happened with this code.

No new code is the blocker. **Deployment and live verification are.**

`pnpm dev` now brings the control plane, the site, and the desktop window up together, and with `FAKE_CLOUDFLARE=1` in `apps/api/.dev.vars` the CLI provisions against it for real: proof of work, claim, saga, `201 Created`, the URL banner, heartbeats, and a clean `DELETE` on exit. It then dials the **actual** Cloudflare edge over QUIC and is refused at registration, because the credential is a fake — so the retry ladder, the give-up, and the lease release are all exercised too.

That moves the boundary a long way: everything except a valid credential is now verifiable offline, including the `ConnectionsExhausted` path. What steps 1 and 2 below still own is the only thing left — whether the Cloudflare API calls that mint a *real* token are correct.

1. **Deploy `apps/api`.** Worker secrets via `wrangler secret put` (never CI), the DNS record for `api.nport.link`, and the zone-level rate limit that `docs/ARCHITECTURE.md` §7 puts in the dashboard rather than in code. `docs/OPERATIONS.md` owns all three.
2. **Confirm the Cloudflare API paths against the live API.** 2a uses the current `cfd_tunnel` resource name where v2 used the legacy `/accounts/{id}/tunnels`. Every provisioning test to date has run against `test/fake-cloudflare.ts`, so the first real create is also the first check that the path is right. This is the single most likely thing to be wrong on first deploy.
3. **Run `nport 3000 -s test` against it.** One command exercises the whole system in order: proof of work, claim, provision, edge discovery, QUIC handshake, `registerConnection`, an HTTP request served from the origin, the heartbeat, Ctrl+C, the drain, and the delete. Anything that breaks, breaks here.
4. **Repeat on macOS, Linux, and Windows**, plus WebSocket and server-enforced expiry. That is Gate G2.
5. **Close the two G1 leftovers while a live tunnel exists** — criterion 1 wants the dashboard to say `healthy`, criterion 5 wants the remaining five golden fixtures, and both need exactly the access that step 1 creates.

Not on this path, and not started until G2 closes: the website (2c), the desktop app (Phase 4), and everything in `docs/FEATURES.md` §§2–9 and §§11–12. Two client-side gaps in `docs/FEATURES.md` §1 are real but still not on it — **arbitrary forward targets** and **edge basic auth** — see the mapping below for why each waits.

## `docs/FEATURES.md` — where each area lands

`docs/FEATURES.md` is the backlog the mockup implies, written from the desktop design. It is a **feature inventory, not a plan**: per ADR-0016 the work items are GitHub Issues, and this table is the only thing that assigns them phases.

| Area | Lands in | State |
| --- | --- | --- |
| 1 · Core tunnel engine | **2b** | built, bar two items — see below |
| 2 · Request inspector | Phase 4 | `core::inspector` built in 2b; the UI over it is Phase 4 |
| 3 · Tunnels screen | Phase 4 | — |
| 4 · New tunnel | Phase 4 | — |
| 5 · History & presets | Phase 4 | — |
| 6 · Menu bar & window lifecycle | Phase 4 | — |
| 7 · Settings | Phase 4 | the custom backend URL already exists — CLI `--backend` and `~/.nport/config.toml` |
| 8 · Supporter account & monetisation | **nowhere — blocked** | contradicts invariant 1 and ADR-0007 |
| 9 · Onboarding | Phase 4 | the own-Cloudflare path is `docs/SELF_HOSTING.md`, which exists; the *UI* for it is undesigned |
| 10 · Backend | **2a** | built, except §8's endpoints, which are blocked with §8 |
| 11 · Packaging & distribution | Phase 3 | — |
| 12 · Cross-platform design | Phase 4 | blocked on design work, not on code |

**§8 cannot be built as written.** Email entry, OTP verification, a persisted session, and a server-side supporter lookup are an account system: auth, a user database, and a login. Invariant 1 says "no accounts, no auth, no signup — **ever**", ADR-0007 rejected even *optional* accounts on the grounds that every optional auth system becomes load-bearing, and `docs/ARCHITECTURE.md` §9 lists accounts as out of scope. Its own note concedes the design authenticates nothing — possession of an address is not proof of donation. **Promoting it needs an ADR that supersedes ADR-0007**, and that is a product decision, not a roadmap entry. Until one exists, §8 is not scheduled and the sponsored-card slot it wraps is not either.

Two items in §1 are genuinely new client-side scope:

- **Arbitrary forward targets** (`127.0.0.1`, LAN IPs, container names) are cheaper than they look. `core::exchange` already takes a `SocketAddr` and the local target **never appears in the API contract** — `createTunnelRequestSchema` carries a subdomain and nothing else — so this touches `TunnelConfig`, the CLI's flag surface, and the pre-flight probe, and reopens nothing frozen at 1.5. It waits only because it is not needed to open a port. **The design's assumed `-h` flag is unavailable**: `-h` is `--help`, guaranteed by a test, and taking it would break the rule that help answers immediately. Use `--host`, or fold it into the positional as `host:port`.
- **Edge basic auth** is `docs/ARCHITECTURE.md` §9's "tunnel password protection", explicitly out of scope for 3.0 and already in Deferred below. It needs an ADR like §8 does, though a far less contentious one.

Four things `docs/FEATURES.md` leaves open are already settled in code, and the answers belong here rather than being re-derived: the inspector ring is **1000 exchanges with a 32 KiB body preview** (`core::inspector`); the CLI config file is **`~/.nport/config.toml`**, not `.json`; the CLI ships **three** languages, `en`/`vi`/`es`, where the design shows two; and **SSE already passes through**, because `core::exchange` streams rather than buffering — the same property that makes gRPC and long downloads work.

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

**Every review pass of this track's concurrency and cleanup has found a reachable bug in code that had already passed the full gate.** Seven so far, all fixed and tested:

1. An absent-row window across an outbound RPC, letting a second claim start a saga on a name still being torn down.
2. A mid-saga lease reclaimed on a wall-clock check that never verified the saga was actually dead — which left a live tunnel with no lease, so nothing would reap it.
3. A shared placeholder that let simultaneous generated-name creates pass the per-source cap on one slot: five tunnels against a cap of three.
4. `reserve` overwriting a *confirmed* hold's expiry, and the failure path then deleting it — so a source at its cap could re-request a name it already held, take the correct `409`, and come away one slot lighter. Repeatable per lease, which defeated the concurrency cap entirely, bounded only by the hourly quota.
5. The sweep cursor advancing only after a clean run, so a single undeletable orphan would pin reconciliation to its page and starve every other page — R8 again, through a door nobody was watching.
6. **`core::tunnel` never watched the connection pool give up.** Its `select!` had two arms — the user stopping, and the lease expiring — and a pool that exhausts its retries announces `ShuttingDown` and then simply *stops*. The broadcast sender lives in the handle that function owns, so the stream never closes to say so. A tunnel whose four connections all died therefore sat with nothing to serve, sent no terminal event, and left the CLI hanging while it looked healthy — defect R1's exact shape, reintroduced one layer up from where it was fixed. Found by reading the `select!` and asking what was *not* in it.
7. The heartbeat re-announcing `Provisioned` on every beat, which reprints the CLI's whole URL banner twice a minute. A heartbeat does not extend a lease (defect R6), so the number is normally identical; it is now announced only when the server actually moves it.

The shape is nearly the same each time: **a check separated from the state change it guards** — by an `await` in the first two, by a key two requests could share in the next two, by a failure path in the fifth, and in the sixth by a `select!` arm that was never written. In every case a comment nearby asserted the invariant the code failed to enforce, which is the most reliable place to look. The passing suite caught none of them; each was found by reading, then reproduced with a test written afterwards. The prediction that a fifth existed was correct, and so was the prediction of a sixth — assume an eighth.

One flaky test came out of the same work, worth recording for what it was asserting: the "refuses an unsolved challenge" case used a hardcoded `nonce: "0"`, which satisfies the 4-bit difficulty these tests run at one time in sixteen. A 6%-flaky test claiming proof of work is enforced is the worst possible thing to be flaky about. It now searches for a nonce verified *not* to satisfy the difficulty.

### 2b · `crates/core` + `crates/cli`

**Code-complete, never run against a live edge or a live control plane.** Everything below is built and tested; what remains is step 3 of the critical path, which is not code.

- [x] the `Transport` trait in `crates/protocol/src/lib.rs`, implemented for QUIC
- [x] promote the spike's proxy loop — the half of it that is protocol
- [x] `core::proxy` — the origin-side response handling, with the chunked-encoding regression tests
- [x] `core::event` — the `TunnelEvent` stream, carrying codes and never prose
- [x] `core::retry` — classification, the consecutive-failure budget, and jittered backoff
- [x] `core::supervisor` — the pool's decisions: start order, reconnect, rotation, give-up
- [x] `core::local_runtime` — ADR-0024's `!Send` thread boundary, implemented
- [x] `TunnelManager` — the supervision tasks, event broadcast, and shutdown
- [x] **`LocalRuntime::host`** — a long-lived `!Send` object on the confined thread, with a `Send` handle
- [x] `rpc::read_connection_response` — the response reader, extracted and finally tested
- [x] **`rpc::Session`** — holds the control stream open and exposes `unregisterConnection` (§12)
- [x] **the QUIC `Connector`**: edge discovery, dial, register, serve — the manager wired to a real edge
- [x] `core::exchange` — one edge-initiated request, from the framing to the origin and back
- [x] `core::inspector` behind an optional sink — the record, the ring, and the wiring
- [x] **`core::tunnel`** — the lifecycle the other pieces were missing: provision, heartbeat, teardown
- [x] the API client over `crates/contract` — the five endpoints, the proof of work, and typed refusals
- [x] **the CLI** — `clap` parsing, terminal rendering, `~/.nport/config.toml`, i18n (en/vi/es, auto-detected), signal handling and graceful shutdown

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

**The connector is the sequence, and nothing else.** Claim an address, dial it, open a control stream, register, serve. Every *decision* around it already belonged to something else — `core::supervisor` says who starts and when to give up, `core::retry` says whether to rotate, `edge::AddressPool` says where to — so this module holds none. What it does own is the thing none of them could: the order.

**`Connector::connect` returns an `RpcError` for failures that never reached an RPC**, and that is a deliberate mapping rather than a shortcut. `core::retry` classifies exactly one error type, and widening it would ripple through the supervisor, the manager, and every test that drives them. A dial that never completed did not open a control stream, so `OpenStream` is literally true — and both consequences are what §12 asks for anyway: rotate the address, report `EDGE_CONNECT_FAILED`. Two tests pin that mapping, including one asserting an exhausted address pool is *not* reported as `EDGE_PROTOCOL_ERROR`, which is the code that means "Cloudflare changed the protocol" and pages accordingly.

**One socket per connection index, held for its whole life.** Upstream binds a fixed local port per index (`portForConnIndex`) so a reconnect leaves from the same source port, which is what lets NAT and the edge recognise the returning connection — materially better behind carrier-grade NAT. `quinn` will not do it for you, and the natural place to keep an endpoint is beside the connection that is about to be dropped, which silently loses the property. They live in a map on the connector instead, and three tests assert what that buys: one index keeps its port across reconnects, two indices never share one, and a rotation that crosses address families rebinds rather than reusing a socket that cannot dial the new peer.

**`core::exchange` is where the codecs meet the origin, and it mentions QUIC nowhere.** It takes a send half and a receive half, which is all `Transport` promises, so the whole module is tested over `tokio::io::duplex` against a loopback origin — including the two **golden fixtures Cloudflare's edge actually sent**, replayed end to end into a real HTTP server. That is as close to an integration test as anything here gets without a network, and it is the first time those bytes have driven the proxy rather than only the decoder.

Three things in it are worth knowing because the obvious implementation of each is wrong.

**Whether a request has a body is read from metadata, never from the stream.** The body is delimited by end-of-stream (§11), so "is there one?" looks answerable by reading a byte and seeing whether it arrives. It is not: on a bodyless `GET` that means waiting for the edge's half-close before the origin is even contacted — a round trip added to every request — and an outright hang if the edge ever holds the stream open for the response. §11 records upstream's rule, which is metadata-only, and the first draft here got it wrong before the section was re-read.

**A declared length is relayed rather than re-framed.** Re-chunking every upload would have been one code path instead of two, and it breaks origins that reject chunked requests — still common in PHP and older WSGI stacks. Chunked framing is used only when the edge itself declared chunked, which is the one case where the length genuinely is not known until the body ends.

**Nothing is buffered end to end, which changes the `content-length` rule.** §11 said "re-derive, never copy", written when the only implementation buffered the whole body to measure it. That is precisely what breaks SSE and gRPC: the response cannot start until the origin has finished producing it, which for an event stream is never. Streaming means the length cannot be recomputed, so a transformed body goes out with *no* length and end-of-stream delimits it — and the header passes through only when the body was relayed untouched. §11 now states the invariant rather than one implementation's way of satisfying it: **a length must never disagree with the bytes actually sent.**

**`core::inspector` is a sink the connector holds as an `Option`, not a buffer it always fills.** The distinction is the whole design: the desktop app attaches one, the CLI attaches nothing, and with nothing attached there are no headers cloned, no body bytes kept, and a destructor that returns immediately. Body previews still count what passed, because a byte count is free and "why is this response 40 MB?" is a question the size alone answers.

**Recording happens in `Drop`.** An exchange ends four ways — cleanly, with an error, with the stream cut, and with the task aborted during the shutdown drain — and only the first two are `return` statements anyone would remember to instrument. A destructor covers all four, which turns "every exchange appears exactly once" into a property of the type rather than of the next person's care.

**One failure has no error code, deliberately.** A stream cut mid-exchange is not `TUNNEL_LOST` or `EDGE_CONNECT_FAILED` — both claim the connection is gone, and it usually is not — and it is not `LOCAL_REQUEST_FAILED`, which blames the user's server for something it did not do. The registry was frozen at `contract-v1` for good reasons, so rather than inventing a code for a line in a local inspector, `inspector::Failure` carries either a registry code or `CutShort`. The one place a code genuinely matters is the origin being unreachable, and that is `LOCAL_REQUEST_FAILED` exactly as `docs/ERRORS.md` describes it.

**The API client speaks HTTP itself rather than adding an HTTP stack** — ADR-0029. `reqwest` brings a TLS integration that has to be argued down to exactly one crypto provider on every dependency bump, because this workspace pins `rustls` to `aws-lc-rs` for `X25519MLKEM768`, and a second provider makes `rustls` refuse to pick one *at runtime* rather than at compile time. For five JSON endpoints on our own server, with `connection: close` delimiting every body, the client is about 300 lines built on what the binary already links — including `crate::proxy`'s response reader, written for the origin side of the tunnel and reused verbatim.

Two things in it are load-bearing rather than incidental. **`POST /v1/tunnels` is never retried**, at any level: it is the one endpoint in the API that is not idempotent, and a retry leaves a provisioned tunnel nobody holds the tokens for while still spending a slot against the caller's concurrency cap. A caller that wants to try again calls the method again, which takes a **fresh challenge** — the only correct way to redo it.

And **a refusal is read for its code even when the envelope is incomplete.** The full envelope requires `requestId` and `docsUrl`; the code is the only field anything branches on. Failing to recognise `SUBDOMAIN_IN_USE` because a proxy stripped a documentation link would be exactly the brittleness ADR-0018 exists to remove, so the code is parsed on its own before the body is given up on — and a body that is not JSON at all still becomes a refusal carrying its status, because reporting "malformed" would hide a real `503` behind a parse error.

The proof-of-work solver runs on a blocking thread. It is a hash loop with no I/O, a 20-bit solve is around 100 ms, and the runtime it would otherwise block is the one serving the tunnel. Difficulty is counted in **bits, not hex digits** — the server's own dial moves one bit at a time under load (ADR-0028), and a hex-digit check could only express multiples of four.

**`core::tunnel` was a gap nobody had listed.** `TunnelManager` supervises connections, the connector makes them real, and the API client claims leases — and until this, nothing joined them. The root `CLAUDE.md` had been pointing "tunnel lifecycle logic" at `crates/core/src/tunnel.rs` for a file that did not exist. Without it the CLI would have had to provision, heartbeat, and release for itself, which is lifecycle policy in the layer whose only job is rendering.

**Provisioning is a `Result`, not an event.** A caller that cannot claim a subdomain has nothing to render and should say so and exit; making it an event would force every consumer to implement "wait for either the URL or the failure". Everything after that *is* an event, because from then on a consumer can only display what happens.

**A heartbeat failure is not fatal; a missing lease is.** The server allows 120 s of silence and the interval is 30 s, so a blip costs nothing and retrying on the normal schedule is the whole response. What ends the tunnel is the server saying the lease no longer exists — no number of retries brings it back, and a client still beating at a tunnel nobody can reach is R1's "looks healthy, serves nothing" state exactly.

**The teardown gets one attempt and no retry.** Releasing the lease is idempotent and skipping it is safe, because the lease expires on its own — so a shutdown path that waited on the network would hang precisely when the network is what failed, and a user pressing Ctrl+C is entitled to a prompt exit. The one place it *is* worth doing eagerly is a lease that was claimed and then could not be connected to: releasing it there returns the name immediately instead of holding a hand-picked subdomain for its full duration.

**The CLI is four of v2's defects, in the order `main` does things.** Parse first, so `--help` and `--version` answer before a config file is read or a socket opened — v2's `nport -v` hung on a fresh install behind a prompt. Probe the local port *before* provisioning, so a closed port is `LOCAL_PORT_CLOSED` rather than a URL that answers 502. Never prompt, and never detect a TTY (ADR-0019). And make shutdown structural: `Tunnel::shutdown` consumes the value, so the second Ctrl+C has no second shutdown to start — it exits with 130 and leaves the lease to expire, which `docs/API.md` guarantees is safe.

`nport -s app 3000` has a test of its own. v2 parsed the port positionally only, so that command tunnelled the default port while printing a URL that looked entirely correct.

**The URL goes to stdout and everything else to stderr**, so `URL=$(nport 3000 --quiet)` works while progress and failures still reach the screen. No colour, no spinner, no cursor movement anywhere: the output has to be identical in a terminal, in CI, in Docker, and through a pipe, and a line that redraws itself is unreadable in the last three.

**Not every error code is translated, and the gap is deliberate rather than unfinished.** The registry has thirty codes; most can only be produced by a control plane a CLI user is not operating. The ones a person running `nport` can cause and act on are translated into all three languages, and anything else renders as the code plus its documentation URL — a worse line than a sentence, a much better one than a guess, and one that cannot go stale, because the page behind it is generated from the same registry. A missing *interface* string, by contrast, is a compile error: the catalogue is a match over an enum, not a lookup that can return `None`.

**`TunnelManager` owns sockets and timers and no rules.** Every decision comes from `core::supervisor`; this layer only carries them out. It is generic over a `Connector`, so the whole supervision loop — backoff, rotation, giving up, the pool surviving one dead index — is tested against fakes with no edge at all. `TunnelHandle::shutdown` **consumes the handle**, so v2's double-Ctrl+C double-delete (defect R19) does not compile rather than being guarded at runtime.

**Shutdown drains rather than aborts**, which it did not at first. The manager stopped by calling `task.abort()` — cutting connections without `unregisterConnection`, which drops in-flight requests on the floor and leaves the edge routing to a connection that is gone. `Transport::close`'s own documentation says exactly that this must never happen (§12), so the code contradicted a comment three files away. It now signals, waits for each connection to unregister and drain, and only cuts if the grace period expires — reporting `Stopped { drained: false }` so the CLI can say `SHUTDOWN_TIMEOUT` instead of claiming a clean stop.

**The connector is blocked on something neither crate can do yet, found while starting it.** `Connection::serve`'s contract says an implementation must unregister and drain, not just close. It cannot: `crates/protocol` has no `unregister_connection` at all, and `register_connection` drops its `RpcSystem` when it returns, which resets the control stream. `docs/PROTOCOL.md` records that the edge *tolerates* this — connections served for 30 minutes with the stream closed — so Phase 1 was right not to care. §12's graceful shutdown is a different question, and it needs the stream held open for the connection's whole life.

That implied a second gap one layer down, now closed. `LocalRuntime::run` is run-to-completion: a closure goes over, a `Send` value comes back, and nothing can be held open. `LocalRuntime::host` builds a `!Send` object on the confined thread and returns a `Hosted<T>` handle; the object never moves, and callers send closures that borrow it.

The property that makes it useful is that **`Hosted<T>` is `Send` even when `T` is not** — it carries no `T`, only the ability to ask for work on one — so an ordinary `tokio::spawn`ed connection task can own a handle to a capnp session it could never hold directly. Calls are served one at a time, which is correctness rather than a limitation: an `RpcSystem` is not safe to drive concurrently, and a session interleaving `unregisterConnection` with something else would be a protocol bug.

Remaining order: `rpc::Session` → QUIC connector. Doing the connector first would still mean writing a shutdown path that silently cannot work.

**The session cannot replace `register_connection`, so the response reader was extracted instead.** `examples/spike.rs` calls `register_connection` *outside* a `LocalSet`, and a session has to `spawn_local` its `RpcSystem` driver — so the two need different drivers and both must exist. What must not differ is their reading of what the edge said, which is now one function used by both.

That function had never been tested. It is where both of registration's traps live: the response has **two hops with the same name** — the results struct's `result` pointer holds a `ConnectionResponse` whose own `result` is the union, and reading the outer one compiles — and `retryAfter` is **nanoseconds**, a Go `time.Duration`, where reading milliseconds gives a 1000x wrong backoff during an incident. Both now have hermetic tests built from in-memory capnp messages, plus one for a negative `retryAfter`: the field is signed, and casting blindly to `u64` turns `-1` into roughly 584 years, which every caller would read as a permanent failure.

**`rpc::Session` exists.** It opens the control stream, drives its `RpcSystem` on a `spawn_local`'d task, and exposes `register` and `unregister`. A spawned driver rather than `select!` because a session has to keep polling *between* calls — with `select!` the edge's messages would go unread and the stream would stall.

`Session::open` **panics outside a `LocalSet`**, deliberately: a session with nothing polling its system would silently never make progress, which is far worse to diagnose than a panic at construction.

**It is verifiable only against a live edge**, exactly like `register_connection` — there is no capnp peer to test against, which is why `docs/TESTING.md` puts registration in the live tier. Two pieces were pulled into the hermetic tier instead: the response reader above, and the death signal. That signal carries a trap already hit once in `core`'s shutdown — `watch::changed()` fires only on a *transition*, so a stream that died before a call would wait the full RPC timeout rather than failing at once, which on the shutdown path is the difference between a prompt exit and a five-second hang. Three tests cover it: already dead, still alive then dying, and a driver whose sender was dropped.

Worth noting what this does *not* block: the manager already treats a connection that returns from `serve` as safe to cut, so the only thing missing is the unregister call itself. The drain, the deadline, and the `Stopped { drained }` reporting are all in place and tested.

Fixing the abort exposed a second half: two of the waits inside a connection task ignored the signal — the poll for the lead to register, and the staggered start sleep, which is up to three seconds for the last index. Since the drain waits for *every* task, an index asleep waiting its turn would burn the whole grace period doing nothing. A test caught it as `drained: false` when it should have been `true`.

Writing its tests found a real design hole. `Supervisor::exhausted` only reported "every connection gave up" — but §4 gates indices 1..N-1 on connection 0 registering, so a lead that dies *before ever registering* leaves the rest in `Waiting` forever and that condition is never true. The tunnel would hang, healthy-looking, having never carried a byte. Worse than failing: a CLI would sit there instead of exiting non-zero. A lead that gives up having never registered is now terminal, and a lead that dies *after* registering still is not, because by then the others are serving.

The spike's copies are gone rather than left to drift, which needed `nport-core` as a **dev-dependency** of `crates/protocol`. That is a cycle, and it is deliberate: Cargo permits it, it stays out of `nport-protocol`'s library graph, and the alternative was two implementations of the dechunker with only one of them tested — while the untested one is what runs against the live edge. Outside `[dev-dependencies]` it would be the architectural regression `crates/CLAUDE.md` warns about.

**Gate G2 — a port is open on the internet. The project's first real milestone.**

`nport 3000 -s test` works end-to-end against the deployed API on macOS, Linux, and Windows, including WebSocket, graceful Ctrl+C, and server-enforced expiry. It needs 2a and 2b only; **2c is not part of it**, which is the whole reason the gate sits here rather than after the website.

### 2c · `apps/web`

**Starts after G2 closes**, not alongside 2a and 2b. The tracks are still technically parallel — 2c consumes the contract and touches nothing the tunnel needs — but a site that markets a tunnel nobody has yet opened is the wrong thing to be building, and reviewing the design surfaced enough open questions in it to make the sequencing worth stating rather than assuming.

Next.js + OpenNext; v2 marketing parity (section order and copy per `apps/web/CLAUDE.md`); MDX user docs; `/errors/[code]` pages generated from the contract; SEO parity including the four JSON-LD blocks; one GA4 property.

The approved design is `docs/mockup/NPort Site.dc.html` — read `docs/mockup/README.md` first. It adds a `#compare` section the fixed v2 order has no slot for; placing it is a 2c decision.

**Gate G2c.** The site builds, deploys, and passes its own checks. It gates the 3.0 announcement, not the tunnel.

## Phase 3 — Release pipeline and beta

Cross-compile matrix on native runners (`cross` only for the two musl targets); the nine npm packages; `cargo publish`; Homebrew tap; Scoop manifest; GitHub Releases with provenance attestation; `smoke.yml`; **`protocol-canary.yml`**.

Publish `3.0.0-beta.N` and iterate on real user reports.

**Gate G3.** Seven consecutive green nightly smoke runs across six OS targets before `3.0.0` is tagged `latest` on npm.

## Phase 4 — `apps/desktop`

Deliberately last: it consumes a *stable* `crates/core`, and building it earlier would churn core's API for a GUI that no one is using yet.

Tunnel list and one-click start; tray integration; the traffic inspector over `core::inspector`; settings; auto-update via the updater manifest; signing and notarization per platform.

**The scope is `docs/FEATURES.md` §§2–7, §9, and §12** — the mapping table above — against the design in `docs/mockup/NPort Desktop.dc.html`. Two things to settle before components are written, both recorded in `apps/desktop/CLAUDE.md`: the design draws seven surfaces where the planned layout has four views, and every surface in the token sheet is a `backdrop-filter` glass layer, which is the property that degrades worst on WebKitGTK. §8 is excluded, per the mapping table. §12 is design work that has not been done at all — the mockup is macOS Tahoe only.

## Phase 5 — v2 sunset

Keep the legacy shim alive for installed 2.x clients. Then, in order: `npm deprecate nport@2` with a pointer to the 3.x migration note; announce a date; after that date return `426 CLIENT_TOO_OLD`; eventually remove the shim.

Dates and the exact sequence live in `docs/RELEASE.md`.

## Ordering constraints

- **Phase 1 precedes everything.** An unproven data plane invalidates the CLI and desktop designs.
- **Phase 1.5 precedes Phase 2.** Without a frozen contract the tracks collide. ✅ closed
- **Phase 4 follows Phase 3.** The desktop app needs a stable `core`.
- **G2 precedes 2c.** 2a, 2b, and 2c *can* run in parallel once the contract is frozen, and for a while they did. They no longer do: with 2a and 2b both code-complete and nothing deployed, the only work that moves the project is getting a port open, and the site can be built against a tunnel that demonstrably works rather than one that is only tested.
- **`docs/FEATURES.md` §8 precedes nothing.** It is blocked on an ADR, not on a phase.

## Deferred

Not scheduled. Each needs an ADR to promote. See `docs/ARCHITECTURE.md` §9 for why each is out of scope.

TCP/UDP/ICMP tunnelling (ADR-0020) · custom domains · tunnel password protection · multiple ports per tunnel · CLI traffic inspection · request replay in the desktop inspector · self-hosted control-plane one-click deploy.

Three of those appear in `docs/FEATURES.md` as ordinary backlog items — tunnel password protection as §1's edge basic auth, request replay as §2's **Replay**, and the one-click deploy as §9's own-Cloudflare onboarding. Being drawn in the mockup does not schedule them. **Accounts and monetisation** (§8) belong on this list too, and are the one entry here that contradicts an invariant rather than merely postponing a feature.
