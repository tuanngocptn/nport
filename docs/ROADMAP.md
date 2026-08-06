# Roadmap

Phases and gates. **Individual work items are GitHub Issues labelled `phase-N`, not entries in this file** (ADR-0016).

A gate is a hard stop: every criterion must pass before the next phase starts. Gates exist because the alternative — discovering the data plane doesn't work after building three apps on top of it — is how rewrites die.

## Status at a glance

**✅ done · 🟡 partly · ⬜ not started.** One row per phase and gate, so the state of the project is
readable without scrolling. Each row's detail is in its own section below; nothing here is a fact of
its own, and a row that disagrees with its section is a bug in this table.

| | Phase | Gate | Where it stands |
| --- | --- | --- | --- |
| ✅ | 0 · Docs and skeleton | **G0** ✅ | Lint, typecheck, tests, clippy, fmt and both codegen steps green locally and in CI |
| ✅ | 1 · Protocol spike | **G1** 🟡 | 3 of 5 criteria met outright. Criterion 1 wants a dashboard check, 5 wants five more golden fixtures — both need access, neither is a protocol risk |
| ✅ | 1.5 · Contract freeze | — | Written and tagged `contract-v1` |
| ✅ | 2a · `apps/api` | — | Feature-complete and **deployed to staging**, provisioning real tunnels |
| ✅ | 2b · `crates/core` + `crates/cli` | — | Code-complete and now live-verified end to end on three operating systems |
| ⬜ | 2c · `apps/web` | **G2c** ⬜ | Not started, and now **behind Phase 5** (ADR-0044). Its gate covers the 3.0 announcement, not the tunnel |
| 🟡 | — | **G2** 🟡 | **Five of six met.** A real port is open, on macOS, Linux and Windows, with WebSocket and server-enforced expiry. The gap is graceful Ctrl+C on Windows, which is a limitation of the test harness rather than of the product |
| 🟡 | 3 · Release pipeline and beta | **G3** ⬜ | `smoke.yml` exists and runs nightly on three OSes. The nine npm packages, `cargo publish`, Homebrew, Scoop, provenance and `protocol-canary.yml` do not |
| ⬜ | 4 · `apps/desktop` | — | A booting scaffold. Deliberately last, so it consumes a stable `crates/core` — and now also waits on discovery, which its Nodes screen renders |
| 🚧 | **5 · Federation — registry and nodes** | **G5** ⬜ | **In progress: this is what to build next** (ADR-0044). ADR-0031's design, unchanged. `apps/registry` is not written yet |
| ⬜ | 6 · v2 sunset | — | Waits on 3.0 being `latest` |

**What to build next: Phase 5, in this order** — `packages/contract` (node schema, the two route
groups, three error codes), then `apps/registry`, then `apps/api`'s node fields, then
`crates/core::discovery`. The contract goes first for the same reason it did in Phase 1.5: it is the
serializing dependency, and nothing else can be written against it until it stops moving.

Why this rather than the site or the desktop app: v2 still serves `nport.link`, so nothing downstream
of v3 is urgent, and federation is what turns `apps/api` from "the control plane" into "a node" —
changing its configuration surface and adding a discovery step in front of the client's entry point.
Building two apps against a shape that is about to change is the cost being avoided (ADR-0044).

## Current position

**Phase 1 done, Phase 1.5 closed and tagged, Phase 2a feature-complete, 2b code-complete, and staging is deployed.** The whole control plane — lease lifecycle, abuse controls, reconciliation, and the v2 compatibility shim — is implemented, tested in real `workerd`, and **running at `api.nport.online`**. 2c has not started.

**A port has been opened to the internet** (2026-08-06). The first tunnel provisioned, opened four HA connections to Cloudflare's edge, served a byte-identical body over HTTP/2, and tore down leaving NXDOMAIN — see Gate G2 below for exactly which criteria that did and did not cover. Getting there found four defects nothing offline could have found: `fetch` called with the wrong receiver, so *every* Cloudflare call raised `Illegal invocation`; the site's build script invoking itself until the runner died; staging's client-version floor refusing the only build that would ever point at it; and a Workers account with no `workers.dev` subdomain, which blocks all script uploads.

G1 criteria 2, 3, and 4 met; 5 is partial; 1 is unverified for want of dashboard access. Gate G0 is closed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `cargo fmt --check`, `clippy -D warnings`, `cargo test`, and both codegen steps pass locally and in CI.

`crates/protocol` parses tokens, discovers the edge, completes a QUIC handshake, registers connections, **proxies HTTP end-to-end**, **carries WebSockets**, and **sustains a four-connection pool across forced disconnects**. **Four and a half of the six** open questions in `docs/PROTOCOL.md` §17 are answered, and risks P1, P2, and P3 are closed. Two more fell to source reading on 2026-08-05 rather than to the edge — one of them because the question had the wrong shape, not because it was hard.

| G1 criterion | State |
| --- | --- |
| 1 · `healthy` in the Cloudflare dashboard | **not directly verified** — no dashboard access from here. Four connections registering, reporting their colo, and serving 340 exchanges is strong indirect evidence, but it is not the same check |
| 2 · byte-identical body and headers | ✅ 2026-08-03, both directions including request bodies |
| 3 · WebSocket echo, 100 messages | ✅ 2026-08-03, plus a 64 KiB frame |
| 4 · 30 min across 4 connections and a forced disconnect | ✅ 2026-08-03, 99.6–99.8% per connection, and **338 of 339 requests during the window returned 200** — the pool's exchange count matches the client's success count, so every request that reached it was served |
| 5 · golden fixtures for every frame type | **partial** — 2 of 7, the edge→client ones. The rest need cloudflared (`docs/TESTING.md`) |

The two gaps are both "needs access I do not have" rather than "needs design": criterion 1 wants the Cloudflare dashboard, criterion 5 wants cloudflared installed. Neither blocks Phase 1.5, and neither is a protocol risk — the behaviour they would confirm is already exercised.

## The critical path — open a port to the internet ✅

**Walked, 2026-08-06.** All five steps below are done or answered; a port is open and a real tunnel
carries traffic on three operating systems. The section is kept rather than deleted because each step
records what it was there to find out, and two of those answers are load-bearing — see steps 2 and 5.

The paragraph that follows was written when none of it had happened.

**This is the only work that matters until Gate G2 closes.** `docs/FEATURES.md` describes a much larger product; almost none of it is on this path, and the mapping below says where each part goes instead. The ordering is deliberate: the one thing NPort must do is turn `nport 3000` into a URL that serves a local port, and that has never once happened with this code.

No new code is the blocker. **Deployment and live verification are.**

`pnpm dev` now brings the control plane, the site, and the desktop window up together, and with `FAKE_CLOUDFLARE=1` in `apps/api/.dev.vars` the CLI provisions against it for real: proof of work, claim, saga, `201 Created`, the URL banner, heartbeats, and a clean `DELETE` on exit. It then dials the **actual** Cloudflare edge over QUIC and is refused at registration, because the credential is a fake — so the retry ladder, the give-up, and the lease release are all exercised too.

That moves the boundary a long way: everything except a valid credential is now verifiable offline, including the `ConnectionsExhausted` path. What steps 1 and 2 below still own is the only thing left — whether the Cloudflare API calls that mint a *real* token are correct.

1. ~~**Deploy `apps/api`.**~~ **Done for staging, 2026-08-06.** Terraform owns the zone settings and the rate-limit ruleset, the deploy pipeline owns the Workers, and the runtime secrets are generated and synced by CI rather than typed (ADR-0040, ADR-0043 — the "never CI" rule this step originally carried was deliberately reversed). `docs/DEPLOYMENT.md` is the walkthrough. Production is the same pipeline with a second caller and a second account.
2. ~~**Confirm the Cloudflare API paths against the live API.**~~ **Answered 2026-08-06:** `POST /accounts/{id}/cfd_tunnel` is correct, and the create response carried **no** `token` field — so `GET .../cfd_tunnel/{id}/token` is the live path and ADR-0032's second branch is the one that runs. The original note follows.

   **Confirm the Cloudflare API paths against the live API.** 2a uses the current `cfd_tunnel` resource name where v2 used the legacy `/accounts/{id}/tunnels`. Every provisioning test to date has run against `test/fake-cloudflare.ts`, so the first real create is also the first check that the path is right. This was the single most likely thing to be wrong on first deploy, and **most of it has now been checked without deploying**: every path, parameter and response field was read out of Cloudflare's published OpenAPI schema and cross-checked against its generated Go SDK on 2026-08-05 (`docs/OPERATIONS.md` § Verifying the Cloudflare API surface). That found two real problems, one of which would have failed every single provision. What is still genuinely open is one field the schema and v2 disagree about, and the code now accepts both answers (ADR-0032) — so the first live create resolves it by observation rather than by breaking.
3. ~~**Run `nport 3000 -s test` against it.**~~ **Done 2026-08-06 on macOS**, HTTP only. Every step in the list below ran: proof of work, claim, provision, edge discovery, QUIC handshake, `registerConnection`, requests served from the origin, Ctrl+C, drain, delete.

   **Run `nport 3000 -s test` against it.** One command exercises the whole system in order: proof of work, claim, provision, edge discovery, QUIC handshake, `registerConnection`, an HTTP request served from the origin, the heartbeat, Ctrl+C, the drain, and the delete. Anything that breaks, breaks here.
4. ~~**Repeat on macOS, Linux, and Windows**, plus WebSocket and server-enforced expiry.~~ **Done 2026-08-06** via `.github/workflows/smoke.yml`, which runs on every staging deploy. Graceful Ctrl+C on Windows is the one thing still uncovered, and the reason is the harness: there is no `SIGINT` to send a child process there.
5. 🟡 **Close the two G1 leftovers while a live tunnel exists** — criterion 1 wants the dashboard to say `healthy`, criterion 5 wants the remaining five golden fixtures, and both need exactly the access that step 1 creates.

Not on this path, and not started until G2 closes: the website (2c), the desktop app (Phase 4), and everything in `docs/FEATURES.md` §§1, 3 and 5–14. Two client-side gaps in `docs/FEATURES.md` §4 are real but still not on it — **arbitrary forward targets** and **edge basic auth** — see the mapping below for why each waits.

## `docs/FEATURES.md` — where each area lands

`docs/FEATURES.md` is the backlog the mockup implies, written from the desktop design. It is a **feature inventory, not a plan**: per ADR-0016 the work items are GitHub Issues, and this table is the only thing that assigns them phases.

Renumbered when the design gained the federated architecture — it now has fourteen areas, and the two at the top are new.

| Area | Lands in | State |
| --- | --- | --- |
| 1 · Registry | **Phase 5** | new. ADR-0031 |
| 2 · Node | **2a** + Phase 5 | `apps/api` already *is* a node; it gains self-registration and a capacity field |
| 3 · Node selection in the client | **Phase 5** + Phase 4 | `core::discovery` is Phase 5; the Nodes screen over it is Phase 4 |
| 4 · Core tunnel engine | **2b** | built, bar host targeting and edge basic auth |
| 5 · Request inspector | Phase 4 | `core::inspector` built in 2b; the UI over it is Phase 4 |
| 6 · Tunnels screen | Phase 4 | — |
| 7 · New tunnel | Phase 4 | — |
| 8 · History & presets | Phase 4 | — |
| 9 · Menu bar & window lifecycle | Phase 4 | — |
| 10 · Settings | Phase 4 | the custom backend URL already exists — CLI `--backend` and `~/.nport/config.toml` |
| 11 · Supporter account & monetisation | **nowhere — blocked** | contradicts invariant 1 and ADR-0007 |
| 12 · Onboarding | Phase 4 | the own-Cloudflare path is `docs/SELF_HOSTING.md`, which exists; the *UI* for it is undesigned, and under ADR-0031 it doubles as "become a node" |
| 13 · Packaging & distribution | Phase 3 | — |
| 14 · Cross-platform design | Phase 4 | blocked on design work, not on code |

**§11 cannot be built as written.** Email entry, OTP verification, a persisted session, and a server-side supporter lookup are an account system: auth, a user database, and a login. Invariant 1 says "no accounts, no auth, no signup — **ever**", ADR-0007 rejected even *optional* accounts on the grounds that every optional auth system becomes load-bearing, and `docs/ARCHITECTURE.md` §9 lists accounts as out of scope. Its own note concedes the design authenticates nothing — possession of an address is not proof of donation. **Promoting it needs an ADR that supersedes ADR-0007**, and that is a product decision, not a roadmap entry. Until one exists, §11 is not scheduled and the sponsored-card slot it wraps is not either.

Two items in §4 are genuinely new client-side scope:

- **Arbitrary forward targets** (`127.0.0.1`, LAN IPs, container names) are cheaper than they look. `core::exchange` already takes a `SocketAddr` and the local target **never appears in the API contract** — `createTunnelRequestSchema` carries a subdomain and nothing else — so this touches `TunnelConfig`, the CLI's flag surface, and the pre-flight probe, and reopens nothing frozen at 1.5. It waits only because it is not needed to open a port. **The design's assumed `-h` flag is unavailable**: `-h` is `--help`, guaranteed by a test, and taking it would break the rule that help answers immediately. Use `--host`, or fold it into the positional as `host:port`.
- **Edge basic auth** is `docs/ARCHITECTURE.md` §9's "tunnel password protection", explicitly out of scope for 3.0 and already in Deferred below. It needs an ADR like §11 does, though a far less contentious one.

Four things `docs/FEATURES.md` leaves open are already settled in code, and the answers belong here rather than being re-derived: the inspector ring is **1000 exchanges with a 32 KiB body preview** (`core::inspector`); the CLI config file is **`~/.nport/config.toml`**, not `.json`; the CLI ships **three** languages, `en`/`vi`/`es`, where the design shows two; and **SSE already passes through**, because `core::exchange` streams rather than buffering — the same property that makes gRPC and long downloads work.

## Phase 0 — Docs and skeleton ✅

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

## Phase 1 — Protocol spike ✅ (blocked everything, now unblocked)

The highest-risk work, done first and alone. A throwaway `crates/protocol/examples/spike.rs` — no `TunnelManager`, no CLI, no abstraction. Just prove the protocol works from Rust.

**No backend work is needed.** Point the spike at the existing v2 `api.nport.link`, which already mints real tunnel tokens in exactly the format `docs/PROTOCOL.md` §3 describes. This is why Phase 1 can precede Phase 2.

Ordered sub-steps, each independently verifiable:

1. ~~Parse a tunnel token; assert the redaction and zeroize behaviour~~ — **done**, `crates/protocol/src/token.rs`
2. ~~Edge discovery — start with the direct A/AAAA shortcut (`docs/PROTOCOL.md` §4), add SRV after~~ — **done**, `crates/protocol/src/edge.rs`; both paths verified against the live edge on 2026-08-03. **The DoT fallback is now implemented too** and verified against `1.1.1.1:853` on 2026-08-05, so all three of §4's discovery paths exist rather than two of three (ADR-0035)
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

**Four are answered, and only one of the four needed the edge.** Q1, Q4 and Q6 came from reading the pinned source; Q3 needed a live handshake. The lesson §17 records after Q1 held twice more: *"unresolvable" sometimes means "not yet read carefully enough"*. Q4 is the one worth knowing about — it asked for the full set of `ConnectionError.cause` strings, and the answer is that there is no such set to enumerate, because `shouldRetry :Bool` carries the decision and `cause` is prose. A question can be unanswerable because it is the wrong question.

The two left are deliberately unequal. **Q2's remaining half** — whether the edge rejects an unknown feature string — source cannot answer, because cloudflared only ever *sends* features; it needs one live registration carrying a bogus one, a minute's work the next time a live tunnel exists. **Q5** — per-account connection and rate limits — is left alone on purpose: answering it means driving someone's account into a Cloudflare limit, and the number would be one Cloudflare can change without telling us. `core::supervisor`'s four-connection bound and retry budget already turn such a limit into an ordinary retryable refusal.

**If G1 fails, take the ADR-0017 ladder** — HTTP/2 transport first, then the `CloudflaredConnector` shim. Do not extend the timebox by pressing on; the ladder exists precisely so that a failure here costs a transport, not the release.

## Phase 1.5 — Contract freeze ✅

Short, and the real serializing dependency. Until it exists, Phase 2's tracks cannot parallelize. After it, they barely interact.

- [x] `packages/contract`: 30 error codes, 6 routes, subdomain normalization and validation, shared `fixtures/subdomains.json` — the numbers as frozen at `contract-v1`; Phase 5 has since added 3 codes and a second route table, all additive
- [x] `docs/ERRORS.md` **generated** from the registry
- [x] `schema/nport-api.openapi.json` with named component schemas, and `schema/errors.json` for the metadata JSON Schema cannot express
- [x] `crates/contract` generated by `cargo xtask codegen` (ADR-0025 — not `typify`, and why)
- [x] tag `contract-v1` — annotated, pushed 2026-08-04

**Gate G1.5 — closed 2026-08-03, tagged 2026-08-04.** `pnpm codegen && cargo xtask codegen` leave the tree clean, `crates/contract` compiles, and every code round-trips: 78 TypeScript tests including a check that `docs/ERRORS.md` and the registry agree in both directions, plus 13 Rust tests including the documented error envelope.

The tag waited on two things, both now satisfied: a remote, and the contract having met **real** Durable Objects rather than only a type-checker. Phase 2a exercised all six routes and all thirty codes end to end before `contract-v1` was cut. Two additions landed in between, both purely additive — `validateSubdomainShape` and `checkSubdomainShape`, which let a path parameter refer to a generated `nport-` name that the claim validator must still reject.

## Phase 2 — Three parallel tracks 🟡

### 2a · `apps/api` ✅

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
- [x] 214 tests in real `workerd`

Closed here: **R3** (the saga journals every step before its side effect and compensates in reverse), **R4** (one DO per normalized name, and the read-check-journal sequence holds no `await`, so concurrent claims cannot both win), **R6** (`expires_at` is server-owned and a heartbeat does not extend it), **R7** (a lease cannot be taken while live, and no DNS record is deleted unless it is a `CNAME` whose content is exactly `<tunnel_id>.cfargotunnel.com`), and **R9** — all five layers: zone limiting is a dashboard setting, the Workers rate limiter is keyed on `HMAC(source, secret)` + ASN where a source is an IPv4 address or an IPv6 prefix (ADR-0033), `SourceQuota` bounds concurrent and hourly creates per source, proof of work escalates per source, and the global cap returns 503. Also **R5**, **R10**, and **R11**.

Three things worth knowing before this deploys:

- **The Cloudflare API paths are checked against the schema, not against the live API.** v2 used the legacy `/accounts/{id}/tunnels`; this uses the current `cfd_tunnel` name for the same resource. Every path and field now matches Cloudflare's published schema and its generated Go SDK, and the two places they diverge are documented in `docs/OPERATIONS.md` rather than assumed away. Nothing here has still ever run against the live API.
- **The global cap is soft.** `MAX_ACTIVE_TUNNELS` is checked before the claim, so a burst of simultaneous creates can overshoot by roughly its own concurrency. It is a capacity guard, not a security boundary — the per-source caps are what bound a single abuser, and those *are* hard: `SourceQuota.reserve` takes the slot and records the attempt in one synchronous, await-free step.
- **Zone-level rate limiting is a dashboard setting, not code.** `docs/ARCHITECTURE.md` §7's outermost layer lives in the Cloudflare dashboard for `api.nport.link` and has not been configured, because nothing is deployed. `docs/OPERATIONS.md` owns it.
- **A permanently failing teardown holds its name.** Deliberate — the alternative is issuing a URL that points at a tunnel we could not confirm is gone. The watchdog alarm retries, and the reconciliation cron now backs it up.
- **The v2 shim is the weakest path in the system, deliberately.** It gets the rate limiter, the per-source caps, and the global cap — but **no proof of work**, because a 2.x client cannot solve a challenge, and no `ownerToken`, because the concept did not exist when those clients shipped. Its delete is authorized by source hash against a lease explicitly flagged `legacy`, so it can never reach a `/v1` tunnel. Every day it stays open is a day the cheapest way to create a tunnel is the old one; `docs/RELEASE.md` owns the sunset.
- **The sweep will not delete a DNS record it cannot prove it owns, and therefore leaves some orphans behind.** An orphan has no lease to say what its record should point at, so the proof used instead is the orphan tunnel's own ID — which means the record is deleted *before* the tunnel, while the proof still exists. A record pointing anywhere else is logged and left for a human (`docs/OPERATIONS.md`). Closing that gap automatically would mean deleting records on weaker evidence than invariant 8 allows, which is v2's takeover defect.

**Every review pass of this track's concurrency and cleanup has found a reachable bug in code that had already passed the full gate.** Fifteen so far, all fixed and tested:

1. An absent-row window across an outbound RPC, letting a second claim start a saga on a name still being torn down.
2. A mid-saga lease reclaimed on a wall-clock check that never verified the saga was actually dead — which left a live tunnel with no lease, so nothing would reap it.
3. A shared placeholder that let simultaneous generated-name creates pass the per-source cap on one slot: five tunnels against a cap of three.
4. `reserve` overwriting a *confirmed* hold's expiry, and the failure path then deleting it — so a source at its cap could re-request a name it already held, take the correct `409`, and come away one slot lighter. Repeatable per lease, which defeated the concurrency cap entirely, bounded only by the hourly quota.
5. The sweep cursor advancing only after a clean run, so a single undeletable orphan would pin reconciliation to its page and starve every other page — R8 again, through a door nobody was watching.
6. **`core::tunnel` never watched the connection pool give up.** Its `select!` had two arms — the user stopping, and the lease expiring — and a pool that exhausts its retries announces `ShuttingDown` and then simply *stops*. The broadcast sender lives in the handle that function owns, so the stream never closes to say so. A tunnel whose four connections all died therefore sat with nothing to serve, sent no terminal event, and left the CLI hanging while it looked healthy — defect R1's exact shape, reintroduced one layer up from where it was fixed. Found by reading the `select!` and asking what was *not* in it.
7. The heartbeat re-announcing `Provisioned` on every beat, which reprints the CLI's whole URL banner twice a minute. A heartbeat does not extend a lease (defect R6), so the number is normally identical; it is now announced only when the server actually moves it.
8. **The reconciliation sweep never left page 1.** `listTunnels` decided whether another page existed from `result_info.total_pages` — a field the tunnels list does not send. The DNS list does, which is where the assumption came from. So `hasMore` was permanently `false`, the cursor reset to page 1 on every run, and nothing past the first ten tunnels in the account was ever examined: **R8 for the third time**, and this one was invisible because `test/fake-cloudflare.ts` invented the field. Found by reading Cloudflare's published schema rather than the code, which is the only place the mistake was visible. `hasMore` is now page fullness and depends on no metadata at all.
9. **Every per-source abuse control was free to bypass over IPv6.** Source identity is `HMAC(ip, secret)`, and the rate limiter, the concurrency cap and the hourly quota are all keyed on it. A client is allocated a 64-bit prefix at the smallest and chooses the rest of the address itself — so a different address per request meant a different identity, a different `SourceQuota` object, and a fresh cap, at no cost and with no botnet. Three of R9's five layers, gone for anyone on IPv6, which IPv4 never exposed because a client controls exactly one address there. Identity is now keyed on the prefix (ADR-0033). Found by following a comment that claimed the ASN in the key stopped a botnet spreading across one network — it cannot, since extra key material can only split an identity, never merge two — and asking what *actually* bounded a source.
10. **A quadratic normalizer, reachable unauthenticated on the path with no proof of work.** `normalizeSubdomain` stripped the zone suffix in a loop by re-slicing, copying the whole remaining string each pass — O(n·k), with k growing with n. `"a"` plus `".nport.link"` repeated measured 4 ms at 11 KiB, 87 ms at 54 KiB and **12.5 s at 645 KiB**. `/v1` was bounded by its schema; the v2 shim was not, because v2's request shape is not in the contract so the shim reads its own body, and it passed whatever arrived straight in. Its refusal also echoed the raw value back, making a megabyte in a megabyte out. Fixed at both layers (ADR-0034): the function is linear, and the bound lives at the contract's entry points where no caller can forget it. `challenge`, `nonce` and `ownerToken` were unbounded strings for the same reason and are now bounded too.
11. **Reconciliation could not reap an orphaned generated name — the commonest kind.** A generated name is `nport-<base32>`, so its tunnel is `nport-nport-<base32>` and the subdomain the sweep extracts starts with `nport-`: a reserved prefix, therefore skipped. Since a generated name is what every `nport 3000` without `-s` gets, the sweep was structurally unable to reap most orphans — **R8's family for the fourth time**. The deny list answers two questions and only one is the sweeper's, so `isProtectedFromCleanup` now refines `isReserved` by excluding the two prefixes only NPort creates (ADR-0036). Found by writing a smoke test, whose own `smoke-` names were refused `403` — which exposed a contradiction in `docs/TESTING.md`: it reserved `smoke-` "so reconciliation can identify them", when reserving a prefix is exactly what makes reconciliation leave it alone.
12. **`URL=$(nport 3000)` returned four lines.** The `Provisioned` banner was a single stdout string holding the URL *and* `forwarding to`, `expires`, and `press Ctrl+C` — while the doc comment on `Stream` promised "the URL goes to stdout and everything else to stderr". `--quiet` hid it by suppressing the extras, which made the flag the only way to script the CLI rather than the default, and the existing test cemented the behaviour by asserting the stdout line *contained* `localhost:3000`. `event` now returns lines with their own streams, so the URL stands alone on stdout and the banner goes to stderr where the rest of the chatter already was.
13. **The server could not shorten its own grace period.** `GET /v1/meta` publishes `heartbeatIntervalMs` as a quarter of the grace, for the reason `apps/api/CLAUDE.md` states — "so clients discover rather than hardcode it" — and `core::tunnel` hardcoded 30 s and never called `Api::meta()`, which was dead code in a client that had a method for it. Lower the grace to 60 s and a client still beating every 30 s has one miss of headroom instead of four; lower it to 30 s and every tunnel dies on schedule with nothing saying why. Invariant 3 makes the server authoritative for time limits, and a client picking its own beat rate is a client enforcing one. Now discovered and clamped (ADR-0037).
14. **A broken config file was always reported in English.** `main` printed `thiserror`'s Display for a config failure and returned, and it did so *before* resolving the language — because resolution consulted the config, which is the thing that had just failed. So `--lang es` and `NPORT_LANG=vi` were both ignored on the one path where a user is already puzzled. That is **defect R20's shape reappearing in `crates/cli` itself**: prose reaching a user outside the i18n path, which the layering rule exists to prevent. The ordering was not necessary — the flag and the environment are exactly the two sources still available when the file is unusable — so the language is now resolved without the config's contribution, and the line follows the shape the port probe already used: translated sentence, registry code, then the specific reason in parentheses. That reason stays English on purpose: "unknown field `porrt`, expected one of …" is what makes it actionable, and it is a technical detail rather than a sentence.
15. **An hourly-quota refusal sent no `Retry-After`, while carrying the exact instant it frees up in the body.** `docs/API.md` says "Every `429` and `503` carries `Retry-After`", and the handler derived it from `details.retryAfter` alone — so `RATE_LIMITED` and `CAPACITY_EXHAUSTED` got one and `CREATE_QUOTA_EXCEEDED`, which counts time as an absolute `resetAt`, got none. The header is the field standard tooling and our own retry ladder read, and the server knew the answer. It is now derived from whichever field a refusal carries, clamped to 1 s–1 h. `CONCURRENCY_LIMIT` still has none, and that stays deliberate: a source at its cap frees a slot by closing a tunnel, not by waiting, so a header there would invite the loop it should discourage — which is the distinction `docs/API.md` now draws instead of overclaiming.

    Two contract inaccuracies fell out of the same read. `CAPACITY_EXHAUSTED` has always sent `details.retryAfter` while the registry documented no details at all — and the registry is the authority a client reads, so it now says so. And `CREATE_QUOTA_EXCEEDED`'s action was "Wait; `details.resetAt`", which is a worse instruction than honouring the header it now gets.

16. **A local origin's malformed chunked framing could panic the connector, or exhaust its memory.** Two defects of one family, both in the response decoder, and both about a chunk-size line the code trusted further than it had checked.

    `proxy::decode_chunked` bounds-checked with `rest.len() < size + 2`, where `size` came from hex the origin sent. `ffffffffffffffff` is `usize::MAX`, so the add overflowed: a panic in debug, and in release a wrap to `1` that sailed past the check and panicked on the slice instead. Either way it is a panic, and `crates/CLAUDE.md` says why that matters more here than the arithmetic suggests — "`crates/core` is linked in-process by the desktop app, so a panic there kills the GUI. Return errors; do not panic." Now `checked_add`.

    Production's path is `exchange::dechunk`, which avoids that overflow by construction — it `take`s the declared size and compares what arrived — but read the size line with `read_until(b'\n', …)`, which has **no ceiling**. An origin that streams bytes and never sends a newline grows the buffer until the process dies. `MAX_RESPONSE_HEAD` exists for exactly this reason one layer up, and its docblock already states the general case: "A non-HTTP server listening on the port — or one that never terminates its head — must not make the connector buffer without bound." A chunk-size line is the same sentence; the bound was simply missing. `MAX_CHUNK_SIZE_LINE` is 1 KiB, checked *before* copying so the ceiling is the bound rather than the bound plus whatever the reader happened to hand over.

    Both are reachable by the operator's own origin rather than by a remote caller, so neither is a hole a stranger can use — but "the local server misbehaved" is not a reason for the tunnel to disappear without a message, and on desktop it is a window vanishing.

17. **A response header written without a space after the colon was silently dropped, and two of those headers decide how the body is framed.** `ResponseHead::parse` split header lines on `": "`. The space is optional — RFC 9110 §5.1 is `field-line = field-name ":" OWS field-value OWS`, and `OWS` is `*( SP / HTAB )`, so it may be empty or a tab. An origin writing `Location:/x` lost its redirect. An origin writing `Transfer-Encoding:chunked` lost the *dechunking*, and the chunk-size lines went to the browser as page content — `5`, `hello`, `6`, ` world`, `0` where the page should have been. That is the failure `proxy.rs`'s own module docblock says the module exists to prevent, reappearing through the header parser rather than the body one. Now split on the colon, with `OWS` trimmed from both sides.

    Two things made it findable. The docblock said "two headers are removed and neither is optional", which is a claim about *which* headers do not survive — and the split removed a third category it never mentioned. And the crate had two header parsers that disagreed: the test fake in `tunnel.rs` split on `':'` and this one on `": "`. **Two parsers for one format, differing, means at least one is wrong** — and it is worth checking which even when the strict one looks more careful, because a proxy's job is to relay what was actually said.

    The leniency is deliberately asymmetric with what RFC 9112 §5.1 says about whitespace *before* the colon, which a proxy should reject. It fails safe here for one specific reason, now written next to the code: this parser is the only one downstream, because `transfer-encoding` is hop-by-hop and `content-length` is stripped, so the framing is always re-derived and the origin's own framing headers are never relayed for a second parser to read differently. That reasoning does not travel — a parser that forwards those headers must not copy it.

18. **Edge metadata was written verbatim into the origin's request head, so a CRLF in it would have injected a header — or a second request.** `request_head` builds an HTTP/1.1 head with `writeln!(head, "{name}: {value}\r")`, where both come from Cap'n Proto `Text` the edge sent. A value of `a\r\nX-Injected: yes` produced two headers on the origin's socket; a longer payload produces a whole second request.

    **This one is different from the seventeen before it: there is no known way to reach it.** Cloudflare parses the client's request before we see it, and neither HTTP/1.1 (a bare CR ends the field) nor HTTP/2 (RFC 9113 §8.2.1 — a field value "MUST NOT contain" CR, LF or NUL, and a receiver must treat the message as malformed) can carry one through. Calling it a vulnerability would be overclaiming. What it is, precisely, is a **safety property held by a peer nobody here controls and nobody had written down** — and `crates/protocol/CLAUDE.md` opens by saying that peer's protocol is "undocumented, unversioned in practice, and owned by someone else" that "can change it without notice." An unstated dependency on such a peer is worth converting into an enforced check even when it is currently satisfied, because the cost is one pass over bytes already in cache and the failure mode is silent request splitting into the user's own server.

    Enforced twice, deliberately: `read_connect_request` rejects the whole request at the decode boundary, so nothing downstream — the inspector, the h2 fallback that is not written yet — has to repeat it; and `request_head` skips an offending header anyway, because it is `pub` and takes a struct any caller can build. `dest` is checked more strictly than the metadata, since the request line is space-delimited and a raw space reframes it too. `docs/PROTOCOL.md` §7 now records the rule *and* that it is ours rather than cloudflared's — upstream needs no such check, because the Go `http.Request` it builds never reconstitutes a raw head.

    The find came from asking the mirror-image question of the seventeenth. That one was a parser being too strict about bytes coming *from* the origin; this is a writer being too trusting about bytes going *to* it. **After fixing a bug in one direction of a proxy, check the other direction for its opposite** — the two halves are written by the same person on the same day, and a fault in one is evidence about the other, not merely a reason to feel finished.

19. **An origin that ends its header lines with a bare LF got no response at all.** `ResponseHead::read` scanned for `\r\n\r\n` and nothing else, so a head terminated `\n\n` was never found to end: the connector read on to `MAX_RESPONSE_HEAD` or to EOF and reported `LOCAL_REQUEST_FAILED`. RFC 9112 §2.2 says the terminator is CRLF but that "a recipient MAY recognize a single LF as a line terminator and ignore any preceding CR", and **curl and llhttp both do** — so the author of a hand-rolled server tested it with curl, with a browser, with `fetch`, and it worked every time. The tunnel was the only thing that failed, and it failed with an error blaming their server. That population — someone's fifty-line server written this afternoon — is precisely who NPort is for.

    The mixed case was worse than a rejection, because it succeeded. With a CRLF terminator and bare LFs *between* fields, `split("\r\n")` merged the fields into one header whose value carried a raw newline: `[("Content-Type", "text/plain\nX-Real: yes")]`. Every merged header silently vanished, and the survivor's value was a thing no HTTP value may contain. Now the terminator is any of the four combinations, longest match at a position winning so a real `\r\n\r\n` is never read as one of its own shorter prefixes, and lines split on the LF with a preceding CR dropped.

    That merged value also closed the loop on the eighteenth. A response header now cannot contain an LF, because the split consumes it — but a bare CR mid-value still survived, and these headers go back to the edge as metadata for it to write into a response head toward the browser. So the check written for metadata *arriving* from the edge now runs on headers *leaving* toward it, sharing one predicate rather than a second copy of the reasoning. The reachability caveat inverts along with the direction: the request-side check guards against a peer that cannot currently send the bytes, and the response-side one guards against the user's own origin, which can send anything it likes. Neither is a hole in NPort. Only one of them is triggerable.

20. **The nineteenth's fix was incomplete: the head accepted a bare LF, the chunk framing still did not.** Same origin, same afternoon, same `\n` — a server that writes bare LFs in its status line writes them after each chunk too, and only half of that was fixed. Both decoders had it. `proxy::decode_chunked` scanned for `\r\n` to find a size line and then skipped a fixed two bytes past the data; `exchange::dechunk`, the one production runs, did `read_exact` into a two-byte buffer and **checked neither byte**.

    The streaming failure is worth spelling out because of where it surfaced. With bare LFs the two-byte read consumed the terminator *and the first digit of the next size line*, so the body decoded fine for one chunk and then failed with `size "" is not hexadecimal` — an error naming the size line, two steps downstream of the terminator that had eaten it. A message that accurate about the wrong thing is how a ten-minute bug becomes an afternoon.

    Now both match a terminator rather than skipping bytes: CRLF or a bare LF, and anything else is a `MalformedChunk` that names the chunk it followed. That makes the decoders *stricter* in one direction while making them lenient in the other — the old code accepted any two bytes at all, so a genuinely corrupt stream was consumed silently and mis-blamed later.

    The lesson is not about line endings. **A leniency fix has a blast radius, and it is every place the same producer's bytes are parsed.** "The head accepts bare LF" was the fix I set out to make; "this origin uses bare LF everywhere" was the fact I had actually established, and those are not the same size. After changing what one parser tolerates, enumerate every other parser reading from the same source before calling it done — `grep` for the old assumption, and check the list is empty rather than assuming it is.

21. **A WebSocket greeting frame reached the edge but never reached the inspector's record.** On a `101`, bytes arriving in the same segment as the handshake come back in `ResponseHead::leftover`, and the WebSocket path wrote them straight to the edge — then the two copy tasks *assigned over* `downward`, so the record began after them. The frame was forwarded correctly; only the record was wrong. `response_body.bytes` was `[]` where it should have held the greeting, `total` undercounted by its length, and `truncated()` returned `false`, so a UI had no signal that it was showing a partial pipe. `BodyPreview::truncated`'s own docblock names that failure — "a UI showing a preview without saying so is lying quietly" — and this was the version with the lie one layer deeper, because the field built to report it said everything was fine.

    A server that pushes initial state on connect sends its greeting in the same write as the `101`. That is the common case for a chat app or a live dashboard, not an edge one, and the inspector is the desktop app's entire reason to exist (ADR-0015).

    **What made it invisible is that a test already covered these bytes.** `a_websocket_upgrade_pipes_bytes_both_ways_untouched` sends the handshake and the frame in one write, with a comment saying that is exactly what makes the `leftover` path matter — and it asserts the frame arrives at the edge, which it always did. One path through those bytes was proved and the other was not, and the passing assertion made the gap look covered. **A test that exercises a code path is not a test of everything that path does**: the wire and the record are two consumers of one buffer, and only one of them had an assertion.

22. **The drift checker skipped two of the five layout blocks it claims to cover, and eleven paths had rotted behind the gap.** Root `CLAUDE.md`'s anti-drift section promises "`cargo xtask verify-docs` checking that every path in a repo-map block exists", and `verify_docs.rs`'s own docblock repeats it — "a `CLAUDE.md` that names a file which was renamed". Its `LAYOUT_DOCS` list held five entries and omitted `apps/web/CLAUDE.md` and `apps/desktop/CLAUDE.md`. Adding them turned up six dead paths in one and five in the other, including a Layout block instructing an agent to edit `src-tauri/src/events.rs` in an app whose `src-tauri/src/` contains `main.rs` and `lib.rs`.

    The fix is the two list entries plus honest blocks: absent-but-intended paths are now parenthesised, which is the convention the checker already honours and which its own comment argues for — a planned path "must be visibly distinct from a file that is there, or the block lies". Two limitations stay, deliberately: only the first token on a line is checked, so a filename in the description column is not (that rule is what keeps the checker from crying wolf on `RequestTable, JsonTree`), and prose outside a fence is not checked at all.

    **The lesson is about the shape of the thing that failed.** This was not a wrong line of code; it was a *list* that a guarantee was written over. Every doc rule in this repository is enforced by one of these — `LAYOUT_DOCS`, `LINKED_DOCS`, `UNTRANSLATED`, `NPORT_OWNED_PREFIXES` — and a hand-maintained list is exactly as trustworthy as the last person who added a file. When a doc claims a check covers a category, count the category and count the list.

23. **`TunnelEvent` is `#[non_exhaustive]`, so the rule "handle it in all three or it goes nowhere" had nothing but prose behind it.** No variant is unhandled today — this is a guard, not a defect. But the failure it guards is silent by construction: a consumer in another crate must carry a wildcard, the CLI's is `_ => Vec::new()`, and adding a variant in `core` compiles everywhere while rendering as nothing. Demonstrated rather than argued: adding a probe variant left `cargo build -p nport` green.

    Inside the defining crate the attribute does not apply, so `crates/core/src/event.rs` now holds an exhaustive match whose only job is to stop compiling when the enum grows, and `crates/cli` holds the behavioural half that asserts each of the seven variants renders something and that the three `ShutdownReason`s render *differently* — an identical pair is how a `_` arm hides. Both were verified by breaking them. This is the mechanism `i18n.rs` already used for error codes; it simply had not been applied to the other enum crossing the same boundary.

24. **A one-second wall-clock assertion failed while the code was correct.** `building_a_client_config_is_fast` asserted config construction takes under a second. It takes ~0.3s warm and ~0.8s cold — `aws-lc-rs` initialisation — so the bound sat inside the normal range and went red whenever the full suite ran in parallel on a busy machine, which is how it surfaced here. Its own comment says what it is really for: catching work proportional to the `2^60` stream limit, which does not take 1.1 seconds, it never finishes. The bound is now ten seconds and the name says `does_not_wedge`.

    **A test that fails while the code is correct is the mirror of the one that passes while the code is broken, and it costs more.** A false pass hides one bug; a false failure teaches the reader to re-run the suite instead of reading it, which hides every bug after it. Both come from the same mistake — an assertion calibrated to something other than the property it is named for.

25. **The link checker read three files while claiming to read all of them — the same defect as the twenty-second, in the list beside it.** Root `CLAUDE.md` promises "every markdown link resolves"; `LINKED_DOCS` held `README.md`, `docs/CONTRIBUTING.md`, `docs/ROADMAP.md`. Thirty-five tracked markdown files exist. Found by running the twenty-second's own lesson — count the category, count the list — against the next const in the same file, which took about a minute.

    `LINKED_DOCS` is gone rather than extended. There is no per-file judgement to make about whether a relative link should resolve, so the set is derivable and a const was the wrong shape for it; layout blocks stay explicit because only some files have one. `SKIPPED_DIRS` excludes `docs/mockup` (reference-only by design) and `.claude/worktrees`, which holds live checkouts of *other* branches — reporting their problems here is the "fail on someone else's outage" failure this checker is otherwise careful about.

    Widening from three files to thirty-five immediately produced a **false** failure, which is the interesting half. `docs/ARCHITECTURE.md` documents subdomain validation as `` `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$` `` — and `[a-z0-9](` is `](` exactly, so the scanner read a regex as a link. Fixed in the scanner, not in the prose that tripped it: fenced blocks and inline code spans are blanked before scanning, preserving byte positions so `` [`TunnelManager`](crates/core/src/tunnel.rs) `` still resolves. The checker's own docblock says "the failure mode to avoid is a checker nobody trusts because it cries wolf", and a broader check is exactly when that starts to bite.

    The scanner then found a bug in *itself*, on the commit that introduced it. My own roadmap entry for this fix used a double-backtick span — the idiomatic way to write code containing a backtick, and a form these docs use constantly — and the per-character toggle made the two-backtick opener cancel itself, so the span stayed visible and a placeholder inside it was reported as a broken link. CommonMark opens a span with a run of N backticks and closes it with a run of exactly N; that is what it does now. **The checker caught it by failing on the very change that added it**, which is the strongest argument available for widening a check: three files never exercised the parser hard enough to notice.

    **`verify_docs.rs` had no tests at all** — the file enforcing every documentation rule in the repository. It has six now, and writing them caught two mistakes of mine in a row. The first was in a test: asserting the walk skips `.git` by substring, which also condemns `.github/pull_request_template.md` — a boundary error of the same family as the `": "` header split, in the assertion rather than the code. The second is the sharper one: `markdown_discovery_finds_the_docs_and_skips_the_noise` passed with the call site reverted to the three-entry list, because it tested `markdown_files` in isolation and not that anything *called* it. That is the twenty-first's lesson recurring inside the fix for the twenty-second — testing the helper is not testing the wiring — and it took a second test driving `check_relative_links` against a temporary tree to close.

26. **The twenty-fifth's fix broke the Windows job, and only the matrix could see it.** `markdown_discovery_finds_the_docs_and_skips_the_noise` compared a `to_string_lossy` path against the literal `"docs/ROADMAP.md"`. On Windows that path renders `docs\ROADMAP.md`, so the assertion failed there while macOS and Linux passed — and the full local gate passes on one separator, so nothing short of CI could catch it. The checker itself was correct: `link_checking_covers_every_discovered_file` was green on Windows in the same run.

    Fixed with one `repo_relative` helper that both the problem messages and the tests use, rather than by patching the assertion — the asymmetry was that two places derived the same string independently, which is the shape that let them disagree. The new test builds its input with `join`, so the separator is whatever the platform uses, and asserts forward slashes, which is the form the docs are written in.

    **Two things worth keeping.** First, the revert-check habit has a blind spot: reverting this fix leaves every test green on this machine, because the defect is not expressible here. For anything touching paths, process spawning, or line endings, "I reverted it and the test failed" is not available and CI is the instrument — `docs/ROADMAP.md`'s own G2 criterion is macOS, Linux **and** Windows for exactly this reason. Second, this is the first defect on this branch that the local gate could not have found, after twenty-five that it could have and did not. That is not an argument for trusting the gate less; it is an argument for knowing which class of change escapes it.

27. **`pnpm smoke` reported a leaked port on every single run, and the leak was never real.** `cleanup()` sends `SIGKILL` to the detached process group, and the next statement asks whether the port is still held. The kernel does not reap the group and release the listening socket in that tick — measured, the port frees in about a tenth of a second — so the warning fired unconditionally. It now waits up to three seconds for the port to free and warns only if it does not.

    This one is worth recording because of what it cost rather than what it broke. Nothing in the product was wrong. But the warning appeared after all thirty-six checks passed, ten-plus times across this session, and each time I ran the `lsof … | xargs kill -9` it suggested — work that was never necessary, on a harness that was telling me the truth about nothing. **A check that fires when nothing is wrong cannot tell you when something is**: a genuine leaked `workerd` would have looked identical, and the guard exists precisely because a leaked one makes the *next* run measure the previous run's server, which is a defect that already happened once here.

    It is the twenty-fourth's lesson pointed at a warning rather than an assertion, and the two together cover the pair: a test that fails while the code is correct, and a warning that fires while nothing is wrong. Both teach the reader to ignore the instrument. Proved in both directions before committing — a free port returns in one millisecond, a genuinely held one is still reported.

28. **Four CI workflows were described in the present tense and none of them exist.** `docs/TESTING.md`'s tier table listed `smoke.yml` and `protocol-canary.yml` with cadences ("nightly, releases", "every 6 h") beside tiers that genuinely run, and `docs/RELEASE.md` instructed pushing a tag so `release-cli.yml` and `release-desktop.yml` would build. `.github/workflows/` holds `ci.yml` and `codegen-drift.yml`. All four are Phase 3/4 deliverables and all four need a deployed control plane, so none *could* exist before G2 — the docs simply never said so.

    Same shape as the twenty-second, one layer out: a doc asserting the existence of files, in prose rather than a layout block, where `verify-docs` cannot see it. Found by the same move — take the category the docs name, list what is on disk, diff.

    **It is deliberately not automated, and the reason is worth keeping.** A checker for this would have to recognise "not yet written", and `verify_docs.rs` argues against exactly that: "phrase-matching on 'not yet written' would be a checker that fails the moment someone words it differently." Layout blocks are checkable because they have a *syntax* for planned entries — the parenthesis convention — and prose does not. So this category stays a review item rather than a gate, which is a real limit and better stated than papered over with a fragile check.

29. **The list audit came back mostly clean, which is the result worth recording.** Applying the twenty-second's method to every remaining hand-maintained list behind a guarantee: `UNTRANSLATED` is correct and enforced in *both* directions — every code not listed must carry all three languages, and nothing listed may actually be translated — against `ErrorCode::ALL`, which is generated rather than typed. `HOP_BY_HOP_HEADERS` is the complete RFC 2616 §13.5.1 set plus the non-standard `proxy-connection`. Only `path_candidates`' extension list had a gap: five extensions, missing `.tsx`, `.mjs`, `.jsonc`, `.html` and `.capnp`, so a bare filename with one of those was skipped rather than checked. Enumerated what it was actually hiding — one entry, `index.html`, which exists — so this closed a latent gap and not a current lie. **A method that finds nothing is still worth running, and worth reporting as nothing.**

30. **`retry::backoff` panics on a NaN jitter fraction, and nothing can currently send one.** `clamp` returns NaN unchanged and `Duration::mul_f64` then panics — "cannot convert float seconds to Duration". `crates/CLAUDE.md` is explicit that a panic in `crates/core` kills the desktop app's window. Traced the single production caller to `manager::jitter_fraction`, which divides a bounded integer by a constant and so is always finite: **this is a guard on a `pub` function's documented precondition, not a live defect**, and belongs in the same category as the eighteenth rather than with the reachable ones.

    It is still worth the line, because the intent was already there and silently incomplete. The docblock says "a jitter fraction in `0.0..=1.0`", and a test named `a_jitter_fraction_outside_the_range_cannot_extend_the_wait` asserts exactly that defence — written with `clamp`, which handles both infinities and not the third non-finite value. **A defence that covers two of three cases reads as complete**; the way to check one is to enumerate what the guard's own function can receive rather than what the caller happens to send. NaN now falls back to the full window rather than zero, because the failure this function exists to prevent is a herd retrying too soon.

31. **The Cloudflare client ignored `Retry-After` and retried straight through a 429.** `isRetryableStatus` treats 429 as worth another attempt, and the ladder then slept its fixed 150 ms and 600 ms regardless of what the upstream said. A `Retry-After: 30` therefore cost three subrequests instead of one, spent within about a second and a half, with no realistic chance the third would land — and aimed at the one Cloudflare account this entire deployment runs on (ADR-0031). Hammering through a rate limit is how a short block becomes a long one.

    The fix is not "wait 30 seconds": a Worker request has a user at the end of it and cannot absorb that. It is to use the number in the direction it points — honour a delay under a second, and **stop immediately** when the delay is longer than the request could ever wait, because the remaining attempts are then being spent rather than saved. An unreadable header falls back to the ladder, which is deliberate: `Number("")` is `0` and an HTTP-date is not a number at all, so a mis-parse would read as "retry now" and be worse than what it replaced.

    Found by the mirror-image move again, and it is becoming the most reliable one here. The fifteenth was about our API *sending* `Retry-After` correctly; the unasked question was whether we *honour* one when someone sends it to us. **Every protocol courtesy has two directions, and implementing one is not evidence about the other** — `apps/api/CLAUDE.md` rule 10 spells out our obligation to send the header and says nothing about reading one.

    The two retry ladders in this repository still differ on jitter — `crates/core/src/retry.rs` uses full jitter and argues in its docblock that partial jitter "still leaves a peak", while the client uses `base + random×base`. That difference is defensible rather than a defect: the Rust ladder de-synchronises thousands of independent clients, where a near-zero draw is fine, and the client's floor guarantees a minimum spacing against an upstream that rate-limits per account. Left as it is, recorded here so the next reader does not have to re-derive whether it was an oversight.

32. **The generated contract derived `Debug` on the struct holding the connector credential.** `CreateTunnelResponse` carries both the `ownerToken` and the `tunnelToken`, and the generated field's own doc comment reads "Connector credential. Returned ONCE. Never logged, never in argv" — with `#[derive(Debug, …)]` on the line above it. `docs/conventions/rust.md` states the rule plainly: "Never `#[derive(Debug)]` on a struct holding a token or secret." `DeleteTunnelRequest` and `HeartbeatRequest` carried the same bearer proof.

    **Nothing formats one today** — no `{:?}` reaches a lease anywhere in the tree — so this closed the hole before it was a leak, and belongs with the eighteenth and thirtieth rather than the reachable defects. What makes it worth the work anyway is the size of the failure: one `tracing::debug!("{lease:?}")` added later puts a live connector credential in a log, and `crates/core` is a library the desktop app links. The revert-check shows exactly what that line would have printed.

    Fixed in the generator, not the generated file (invariant 6). Structs with a `*Token` field lose the derive and gain a redacting `Debug` — the credential prints as `<redacted>`, everything else prints normally, because a `Debug` that is simply *absent* pushes a consumer toward printing fields one at a time, which is how the secret reaches a log anyway. `crates/protocol`'s `TunnelToken` had already solved this for the parsed credential; the contract types were the copy that had not.

    **The rule is keyed on the field name, deliberately.** A list of secret-bearing struct names in `codegen.rs` would be the same hand-maintained-list-behind-a-guarantee that the twenty-second, twenty-fifth and twenty-ninth entries are all about. `*Token` is this contract's word for a credential, so a field added tomorrow is covered by construction rather than by memory.

33. **A pass that found nothing, and the reason is the most useful thing in this list.** Four targeted checks, each against an explicitly documented claim, all four correct:

    - The mirror of the thirty-second in TypeScript. Every `console.*` in `apps/api/src` passes named fields — `subdomain`, `code`, `status`, `operation`, `String(error)` — never a whole request or response object, so rule 12 holds. The mirror also does not really apply: TypeScript has no auto-derived debug printing, so there is no equivalent of the derive to get wrong.
    - `crates/cli/src/args.rs` against defect R15. Port accepted positionally and as `-p`, `--help`/`--version` answering before anything else happens, unknown flags refused, adjacent flags not consuming each other's values — seven tests including the exact v2 regression (`nport -s app 3000` silently tunnelling 8080).
    - The locale precedence in `crates/CLAUDE.md` rule 5. The signature is `Lang::detect(flag, configured, env)`, which *reads* as though the config file outranks `NPORT_LANG`; the body orders them the documented way. Checked precisely because the signature suggested otherwise.
    - The two gotchas `crates/protocol/CLAUDE.md` names with their failure modes: `retryAfter` is nanoseconds (`Duration::from_nanos`, tested at `2_000_000_000` → 2 s, with a second test for a negative value being dropped rather than wrapping into roughly 585 years), and registration errors classify on `shouldRetry` rather than on cause text.

    **Where the defects were is the point.** Almost none of the thirty-two were in code carrying an explicit written claim *and* a test enforcing it — that combination is what the four checks above found, and it held every time. They were in the gaps: a claim with nothing enforcing it (the twenty-third), a claim whose enforcement covered part of its scope (the twenty-second, twenty-fifth, thirtieth), a reason that was wrong (the ninth), or code nobody had written a claim about at all (the sixteenth through twenty-first, all in the data path). **Reviewing where the documentation is confident is the least productive use of a pass**; the yield is in the places where a rule is stated and its enforcement is assumed, and in the places where nothing is stated at all.

34. **The Rust subdomain mirror did not exist, and two files said it did.** `packages/contract/src/subdomain.ts` opened with "**Mirrored in Rust** so the CLI can reject a bad name instantly instead of spending a round trip on it, and both implementations run against `fixtures/subdomains.json` so they cannot drift". `fixtures/subdomains.json`'s own `$comment` said its cases were exercised "by `packages/contract/src/subdomain.test.ts` AND by `crates/contract`'s Rust mirror". `crates/contract/src/` held `generated.rs` and `lib.rs`; nothing in `crates/` normalized or validated a subdomain, and the CLI sent whatever `-s` it was given and waited for the server to say `INVALID_SUBDOMAIN`.

    So the fixture file — which exists for one purpose, cross-language agreement — had one consumer, and the round trip the docblock promised to avoid was being spent on every mistyped name. `nport -s my_app` now fails in about a millisecond with `invalid-characters`. **The prediction above was right about the thirty-fourth being where nothing is claimed, and wrong about where to look**: this was a claim stated twice, confidently, in the file that would have had to make it true. The sentence to distrust is not the one with no enforcement behind it but the one asserting that enforcement *elsewhere* exists — `verify-docs` can check that a path in a layout block resolves and cannot check that a paragraph's "mirrored in Rust" resolves to anything at all.

    Built as generated constants plus hand-written rules (ADR-0045), because writing it exposed the question the missing mirror had been hiding: `RESERVED_SUBDOMAINS` is 53 names, and a second hand-kept copy is defects 22, 25 and 29 again. `schema/subdomain.json` is a third generated artifact so a reserved name is added once; only NFKC, the suffix strip and label validation are reimplemented, pinned by the shared fixtures.

    **Three things came out of it that generalise.**

    First, **the revert-check has to run against the shared fixture, not just the new code.** The mirror passed all nine normalization cases with the trailing-dot strip hoisted out of the suffix loop — a real bug producing `myapp.` — because the input that distinguishes the two lived in `subdomain.test.ts` rather than in the fixture. A shared corpus is only as shared as its weakest case; the case is now in the fixture, where it fails both languages. That is defect 21's lesson ("a test that exercises a code path is not a test of everything that path does") with the missing assertion in a *data file* rather than in a test body.

    Second, **agreeing to refuse is not agreeing.** Every length check runs before the charset check, so the unit a language counts in decides which reason the user is told. `String.length` counts UTF-16 code units, so `wire_length` does too — `chars().count()` would call two emoji `too-short` where the server calls them `invalid-characters`. A mirror that disagrees about *why* is worse than no mirror, because two error messages for one input read as two different problems.

    Third, **writing the wiring test found a live interaction nobody had written down**: `-s -myapp` never reaches the validator, because clap refuses `-myapp` as an unknown flag first. That is CLI rule 3 working, not a gap — but it means a leading-hyphen name can only arrive through `--subdomain=`, and the test that asserts the reason has to use that form. Pinned in `crates/cli/tests/refuses_early.rs`, which drives the real binary for defect 25's reason: testing `check_subdomain` proves nothing about whether anything calls it, and for two phases nothing did.

    Two smaller inaccuracies fell out of the same read, both present-tense claims about generated code. `crates/contract/README.md` and `schema/README.md` said the Rust mirror is generated "via `typify`", which **ADR-0025 rejected** in favour of the purpose-built emitter; both also still said "**Not implemented.** Phase 1.5", a phase closed and tagged `contract-v1`. And `ErrorCode::ALL`'s generated doc comment said "in registry order" when `serde_json`'s `Value` is a `BTreeMap` and sorts the keys — harmless, since every caller iterates, and now it says alphabetically.

35. **Seven ADRs were missing from the decision index, in the file that states the rule.** `docs/DECISIONS.md` says "New entries: next number, status `Accepted`, and a one-line entry in the index." The body held 44 entries and the index held 37: ADR-0038 through ADR-0044 — the whole Terraform and secrets series, plus ADR-0044, which is the one saying what to build next.

    Not a code defect, and worse placed than one. The index is what a reader scans to learn whether a question is already settled, so a decision missing from it is a decision that gets re-litigated — precisely what the file's opening line ("these are settled, and re-litigating them wastes time") exists to prevent. Found by the twenty-second's method pointed at the one list in this repository that is maintained entirely by hand and had no checker at all.

    `verify-docs` now checks both directions, which is a fourth check in a module whose docblock said three. An index row with no ADR behind it matters as much as the reverse: it promises a decision nobody wrote.

The shape is nearly the same each time: **a check separated from the state change it guards** — by an `await` in the first two, by a key two requests could share in the next two, by a failure path in the fifth, and in the sixth by a `select!` arm that was never written. In every case a comment nearby asserted the invariant the code failed to enforce, which is the most reliable place to look. The passing suite caught none of them; each was found by reading, then reproduced with a test written afterwards. Every prediction that one more existed has been correct — assume a thirty-sixth.

**Where to look has shifted, and the thirty-fourth is why.** "Look where nothing is claimed" found the data-path defects and then stopped paying: 34 and 35 were both in places where something *was* claimed, loudly, and the claim was about work done somewhere else — "mirrored in Rust", "a one-line entry in the index". A rule with no enforcement is visible to anyone who reads it. **A rule that delegates its enforcement is invisible, because the sentence looks complete.** So the question to carry into the next pass is not "what is unclaimed" but "which claims are about a file other than the one making them" — and for each, go and look at that other file rather than trusting the cross-reference. Both of the last two took under a minute to confirm once asked that way.

The eighth is the one that changes how to look, because reading the code could not have found it: the code was self-consistent and the test double agreed with it. **A fake that is more generous than the API it stands in for does not test the code, it agrees with it.** The only place the mistake existed was in the gap between the fake and Cloudflare's published schema, so the check that found it was reading the schema — which is now a standing step in `docs/OPERATIONS.md` rather than a thing that happened once.

The ninth came back to the older method and shows why it keeps working: the comment next to the key said the ASN was there to stop a botnet spreading across one network, which is not something extra key material can do. **A wrong reason in a comment is worth more than no comment, because it names the property nobody had checked** — and checking that one led straight to the address itself. Both halves of the eighth and ninth are the same instruction from different directions: verify the claim, not the code that rests on it.

The tenth is the same instruction a third time, and the cheapest of the three to repeat: `requestedSubdomainSchema`'s comment said its bound existed "to stop a megabyte of text reaching the normalizer", and three fields beside it had no bound while a fourth caller bypassed the schema entirely. **A stated reason is a claim about every place it applies, not only the line it sits on.** Reading one and asking "where else is this true?" found a quadratic function nobody had timed.

**The eleventh and twelfth came from a different method entirely, and it is the one to reach for next: run the thing.** Both live in code no tier executes — `pnpm test` drives real `workerd` but never starts `wrangler dev`, never runs the `nport` binary, and never loads `src/cloudflare/dev-fake.ts`. Writing `scripts/smoke.mjs` found both inside ten minutes, after eleven passes of reading had found neither. Reading catches a claim that contradicts its code; only running catches a claim that nothing executes. `pnpm smoke` is now a tier in `docs/TESTING.md` so this stops being a thing that happened once.

The eleventh also shows the eighth and ninth lessons compounding: `docs/TESTING.md` gave a *reason* ("so reconciliation can identify them") that was the exact inverse of what the mechanism did, and following that inversion is what surfaced a defect two layers away in the sweep.

The fifteenth is the same again in the other direction — a documented promise nothing kept — and it shows why the two halves are worth checking separately. "Every 429 carries `Retry-After`" was a claim about the *response*, and the only way to test it was to make each 429 happen and look at the headers. Reading the handler would have shown one field being consulted, which looks complete until you enumerate the refusals that reach it.

**The sixteenth came from picking the area no earlier pass had opened: the data path.** Fifteen reviews had circled the control plane, the lease, the CLI's surface — everything with a documented promise to check against. `crates/core/src/proxy.rs` and `exchange.rs` have almost none, because the thing they must not do (trust a length the peer sent) is not a project decision anyone wrote down. **When the reading methods stop yielding, change the territory rather than the technique** — and prefer the code that parses bytes somebody else chose, since that is where a missing bound is a crash rather than a wrong answer.

It also sharpened the revert-check into something more specific. Reverting the fix and re-running is what proves a test is worth its line — but the first version of the `dechunk` test **passed with the bug reintroduced**, because it matched only the error *variant*, and an unbounded read reaches the same `MalformedChunk` by a different route (read to EOF, then fail to parse the hex). The assertion has to name the reason, not the shape. **A test that fails for a different reason than the one you are fixing is a test that will go green on the bug's return** — the revert-check catches that only if you read *why* it failed, not just that it did.

The seventeenth confirms the territory was the right change and adds one cheap check to repeat: **when a repository parses one format in two places, diff the two parsers.** `tunnel.rs`'s test fake and `proxy.rs`'s production parser split header lines differently, and the disagreement was visible from a two-line grep — no reasoning about RFCs needed to *find* it, only to decide which one was right. Both of the last two bugs were in code that reads bytes chosen by something outside the repository, which is where a missing bound crashes and a too-strict parse corrupts. That is now the first place to look, not the last.

The eighteenth extends that from reading to **writing**, and adds the one distinction worth keeping straight: it is the first entry here that describes something no one can currently trigger. Recording it as a bug alongside seventeen reachable ones would be dishonest, and dropping it because it is unreachable would keep an unwritten assumption about someone else's service load-bearing. The useful form is the third one — fix it, enforce it at the boundary, and write down both the rule and the reason it was safe without it, so the next person to read `request_head` does not have to re-derive Cloudflare's parser behaviour to know why the check is there.

The nineteenth is the strongest argument yet for the direction the last three took, and it names the test the others were groping toward: **ask what a tool the user already trusts would accept.** curl accepts a bare-LF head. So the author of a small server has already proved to themselves that it works, and a connector stricter than curl does not look strict — it looks broken, and it looks broken in a way that blames them. Two of the last three bugs were the same mistake against the same yardstick: `": "` versus a colon, and `\r\n` versus a newline. Both times the standard permitted the lenient reading and every widely-used client took it. For anything the connector parses that a user's own server produces, the right question is not "what does the RFC require" but "what does curl already accept" — the RFC answers whether leniency is *allowed*, and curl answers whether strictness will be *blamed on us*.

The thirteenth is the ninth's lesson again, and the cheapest place to keep applying it: a published field with a documented purpose that nothing read. `apps/api/CLAUDE.md` says a limit goes in `/v1/meta` "so clients discover rather than hardcode it" — so the check is simply *does anything call `meta()`*, and the answer was no.

**Two lessons came out of the smoke work itself, and both are about instrumentation rather than product.** First: **an assertion that passes whether or not the bug is present is worse than no assertion.** The heartbeat check went green with the fix reverted, because it waited eleven seconds against a twenty-second grace — caught only by deliberately reverting and watching it pass. Reverting a fix to confirm the test fails is now the habit, not an optional flourish. Second: **a harness that shares state between runs is measuring the previous run.** The smoke test reused one source address, so the per-source hourly quota and the ADR-0028 difficulty dial accumulated across runs until a solve was slow enough to look like the server crashing — the abuse controls working correctly, on the wrong target. Each run now uses a fresh source, and the one control it cannot avoid (the CLI cannot set `cf-connecting-ip`) is lifted explicitly for the run rather than fought.

A third came out of the fourteenth, and it is a tooling trap rather than a lesson about tests: **`mv backup.rs src.rs` preserves the backup's mtime**, so cargo saw a file older than its own artifact, considered the crate fresh, and kept the *reverted* binary. Both directions of the revert-check then looked wrong at once, which is the confusing signature to remember. `touch` the file after restoring it, or the check is measuring the previous build.

**A pass that found nothing is worth recording too, so the next one does not repeat it.** Three claims were checked and hold: `GET /v1/tunnels/:subdomain` returns exactly `subdomain`, `active` and `expiresAt` — the contract's "carries nothing an attacker could use" is true of the hand-built response, not just of the schema; **no `access-control-*` header appears on any route** and `OPTIONS` gets a 400, so R9's browser layer is real rather than assumed; and all thirty `docsUrl` slugs agree between `apps/api` and `crates/cli`, which matters because three places derive them and a mismatch would print a 404 at a user.

What that pass did produce is a **budget test**. `apps/api/CLAUDE.md` and `docs/ARCHITECTURE.md` §6 both quoted a provisioning subrequest count and nothing asserted it, so the number had drifted to "~5" when a provision actually makes **three** Cloudflare calls and a teardown four. The free plan's ceiling of 50 is hard, and a Durable Object hop counts against it, so a saga that grows a step moves the whole request closer to failing outright. `test/tunnels.test.ts` now asserts both lists exactly — a new step shows up as a failing test rather than as a stale comment — and the four places quoting the old number are corrected.

One flaky test came out of the same work, worth recording for what it was asserting: the "refuses an unsolved challenge" case used a hardcoded `nonce: "0"`, which satisfies the 4-bit difficulty these tests run at one time in sixteen. A 6%-flaky test claiming proof of work is enforced is the worst possible thing to be flaky about. It now searches for a nonce verified *not* to satisfy the difficulty.

### 2b · `crates/core` + `crates/cli` ✅

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

**A heartbeat failure is not fatal; a missing lease is.** The interval comes from `GET /v1/meta`, which publishes it as a quarter of whatever grace the server is running — so a blip costs nothing, retrying on the normal schedule is the whole response, and an operator who shortens the grace gets a client that follows (ADR-0037). It was a hardcoded 30 s against a published value nobody read, which meant the grace could not be shortened at all. What ends the tunnel is the server saying the lease no longer exists — no number of retries brings it back, and a client still beating at a tunnel nobody can reach is R1's "looks healthy, serves nothing" state exactly.

**The teardown gets one attempt and no retry.** Releasing the lease is idempotent and skipping it is safe, because the lease expires on its own — so a shutdown path that waited on the network would hang precisely when the network is what failed, and a user pressing Ctrl+C is entitled to a prompt exit. The one place it *is* worth doing eagerly is a lease that was claimed and then could not be connected to: releasing it there returns the name immediately instead of holding a hand-picked subdomain for its full duration.

**The CLI is four of v2's defects, in the order `main` does things.** Parse first, so `--help` and `--version` answer before a config file is read or a socket opened — v2's `nport -v` hung on a fresh install behind a prompt. Probe the local port *before* provisioning, so a closed port is `LOCAL_PORT_CLOSED` rather than a URL that answers 502. Never prompt, and never detect a TTY (ADR-0019). And make shutdown structural: `Tunnel::shutdown` consumes the value, so the second Ctrl+C has no second shutdown to start — it exits with 130 and leaves the lease to expire, which `docs/API.md` guarantees is safe.

`nport -s app 3000` has a test of its own. v2 parsed the port positionally only, so that command tunnelled the default port while printing a URL that looked entirely correct.

**The URL goes to stdout and everything else to stderr**, so `URL=$(nport 3000)` works — without `--quiet`, which is now a way to suppress the banner rather than the only way to script the CLI. That was not true until the twelfth bug below: the banner was one stdout string carrying the URL and three lines of decoration. No colour, no spinner, no cursor movement anywhere: the output has to be identical in a terminal, in CI, in Docker, and through a pipe, and a line that redraws itself is unreadable in the last three.

**Not every error code is translated, and the gap is deliberate rather than unfinished — but it was six codes wider than intended.** The registry has thirty; the six in `i18n.rs`'s `UNTRANSLATED` list are server-side or would only reach a user through a bug in the client, and they render as the code plus its documentation URL: a worse line than a sentence, a much better one than a guess, and one that cannot go stale because the page behind it is generated from the same registry. Everything else is translated into all three languages, and **a test now enforces that in both directions**, so adding a code to the registry forces a decision instead of falling through. Six client-facing codes had been falling through, including `EDGE_REGISTRATION_REFUSED` — the ending of every `pnpm dev` run, and the likeliest real edge failure — which printed as a bare `0: [EDGE_REGISTRATION_REFUSED]` beside three sibling edge codes that all had prose. A missing *interface* string, by contrast, was always a compile error: that catalogue is a match over an enum, not a lookup that can return `None`.

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

**Four of five criteria met, 2026-08-06.**

The first tunnel served real traffic from a laptop: `nport 8099 --backend https://api.nport.online`
provisioned a lease, opened four HA connections to Cloudflare's Hong Kong edge (`hkg09`, `hkg10`,
`hkg01`, `hkg08`), and returned the origin's body **byte-identical** over HTTP/2 with a `cf-ray`
header. Ctrl+C drained and exited; teardown left the hostname at `NXDOMAIN`, so both the tunnel and
the DNS record were removed. The per-source hourly cap then refused a reclaim with
`CREATE_QUOTA_EXCEEDED`, which is `docs/ARCHITECTURE.md` §7 working rather than a fault.

`.github/workflows/smoke.yml` then made that repeatable and cross-platform. Every staging deploy now
runs `scripts/smoke-live.mjs` on **ubuntu, macos and windows**, and each one provisions a real tunnel,
checks a byte-identical body, a 404 passed through as a 404, ten concurrent requests, and **twenty
WebSocket messages echoed in order**.

| G2 criterion | State |
| --- | --- |
| macOS | ✅ locally and on `macos-latest` |
| Linux | ✅ `ubuntu-latest` |
| Windows | ✅ `windows-latest` |
| WebSocket | ✅ 20 messages in order, on all three |
| Graceful Ctrl+C | ✅ on POSIX. **Windows is not covered**: there is no `SIGINT` to send a child process, so the drain path cannot be exercised the way a user would exercise it |
| Server-enforced expiry | ✅ an abandoned lease is reclaimed in ~120 s, matching `HEARTBEAT_GRACE_SECONDS` |

Expiry is checked by `--expiry`, which is the interesting half of v2's defect R6: the client is
`SIGKILL`ed so it never releases anything — the crash, the closed laptop, the severed network — and
the assertion is that the **DNS record disappears**, since that is the one thing only the server can
do. "The URL stops serving" would prove nothing: killing the connector does that instantly. The
record held for 106 s, flapped while the deletion propagated across resolver PoPs, and was gone by
137 s. It runs nightly rather than per deploy, because it costs an extra create and two and a half
minutes for a property that does not change between commits.

**What is left is Ctrl+C on Windows, and that is a limitation of the harness rather than of the
product** — there is no `SIGINT` to send a child process there, so the drain path cannot be driven
the way a user drives it. Everything else on this gate has now run against the live API on three
operating systems: the connector, the provisioning saga, the compensations, the ownership-proof
teardown, the server-authoritative expiry, and the abuse controls.

Four defects surfaced getting here that nothing offline could have found — `fetch` called with the
wrong receiver so *every* Cloudflare call raised `Illegal invocation`; the site's build script
invoking itself until the runner died; staging's client-version floor refusing the only build that
would ever point at it; and a Workers account with no `workers.dev` subdomain, which blocks all
script uploads. Three more were in the harness rather than the product, and each looked like a
product fault: negative DNS caching, a mistyped WebSocket GUID, and a frame decoder that assumed one
TCP read is one frame.

### 2c · `apps/web` ⬜

**Starts after Phase 5**, not alongside 2a and 2b, and no longer merely "after G2" — that gate closed on 2026-08-06 and federation took the slot (ADR-0044). The tracks are still technically parallel — 2c consumes the contract and touches nothing the tunnel needs — but a site that markets a tunnel nobody has yet opened is the wrong thing to be building, and reviewing the design surfaced enough open questions in it to make the sequencing worth stating rather than assuming.

Next.js + OpenNext; v2 marketing parity (section order and copy per `apps/web/CLAUDE.md`); MDX user docs; `/errors/[code]` pages generated from the contract; SEO parity including the four JSON-LD blocks; one GA4 property.

The approved design is `docs/mockup/NPort Site.dc.html` — read `docs/mockup/README.md` first. It adds a `#compare` section the fixed v2 order has no slot for; placing it is a 2c decision.

**Gate G2c.** The site builds, deploys, and passes its own checks. It gates the 3.0 announcement, not the tunnel.

## Phase 3 — Release pipeline and beta 🟡

Cross-compile matrix on native runners (`cross` only for the two musl targets); the nine npm packages; `cargo publish`; Homebrew tap; Scoop manifest; GitHub Releases with provenance attestation; `smoke.yml`; **`protocol-canary.yml`**.

Publish `3.0.0-beta.N` and iterate on real user reports.

**Gate G3.** Seven consecutive green nightly smoke runs across six OS targets before `3.0.0` is tagged `latest` on npm.

## Phase 4 — `apps/desktop` ⬜

Deliberately last: it consumes a *stable* `crates/core`, and building it earlier would churn core's API for a GUI that no one is using yet.

Tunnel list and one-click start; tray integration; the traffic inspector over `core::inspector`; settings; auto-update via the updater manifest; signing and notarization per platform.

**The scope is `docs/FEATURES.md` §§5–10, §12 and §14, plus the Nodes screen in §3** — the mapping table above — against the design in `docs/mockup/NPort Desktop.dc.html`. Two things to settle before components are written, both recorded in `apps/desktop/CLAUDE.md`: the design draws seven surfaces where the planned layout has four views, and every surface in the token sheet is a `backdrop-filter` glass layer, which is the property that degrades worst on WebKitGTK. §8 is excluded, per the mapping table. §12 is design work that has not been done at all — the mockup is macOS Tahoe only.

## Phase 5 — Federation: a registry and many nodes 🚧 **← next**

**Unblocked, and now the active phase (ADR-0044).** G2 closed on 2026-08-06, and this runs ahead of
2c, 3 and 4 rather than merely being allowed to: v2 still serves users, so nothing downstream of v3
is urgent, and this is the change that turns `apps/api` into a node. Doing it while there is one
deployment and no users on it is as cheap as it will ever be. ADR-0031 owns the design. Today's control plane is one Worker on one account and one zone, and three ceilings bind at once — DNS records per zone, tunnels per account, and the per-account API rate limit. A zone cannot span accounts, so each shard needs its own domain as well as its own account.

`apps/api` becomes a **node**, essentially unchanged: it is already one deployment bound to one zone with its own credentials. `apps/registry` is new and small — a directory that accepts registrations, probes what it lists, and answers `GET /v1/nodes`. It holds no Cloudflare credentials and provisions nothing. `crates/core` gains a discovery step before the `Api` client it already has.

- [x] `packages/contract`: `nodeSchema`, the list and registration schemas, `activeTunnels` on `GET /v1/meta`, and three codes — `NO_NODE_AVAILABLE`, `NODE_UNREACHABLE`, `REGISTRATION_REFUSED`. **Done**, plus what writing it settled (ADR-0046): a second OpenAPI document because the registry is a separate host, capacity **probed rather than claimed**, both `/v1/meta` capacity fields optional so an older node still parses, and the DNS TXT proof's record name and value derived from one function so the registry, the operator and the docs cannot spell them differently
- `apps/registry`: the `Directory` DO, open registration behind proof of work and a DNS TXT domain proof, and a cron that probes and delists
- `apps/api`: `NODE_ID`, `PUBLIC_URL`, `REGISTRY_URL`, self-registration on the existing `scheduled` export, and current usage on `/v1/meta`
- `crates/core::discovery`: fetch, cache to `~/.nport/nodes.json`, probe a few in parallel, pick the fastest with capacity, fail over — but **never after `POST /v1/tunnels` has been sent**, which is not idempotent

**Why after G2.** Nothing is deployed and the Cloudflare API paths have never met the live API. Federating an unproven provisioning path multiplies one unknown by N. Waiting costs nothing: the instance that closes G2 becomes node #1 and keeps serving `*.nport.link`.

**The registry is advisory.** The client caches the list, so a registry that is down does not stop a tunnel being created. That is what allows a single directory without a single point of failure, and it is the property to protect if this design is ever revised.

**Gate G5.** Two nodes on two Cloudflare accounts and two domains, both listed; a client discovers, picks, provisions, and fails over to the second when the first is stopped mid-run.

## Phase 6 — v2 sunset ⬜

Keep the legacy shim alive for installed 2.x clients. Then, in order: `npm deprecate nport@2` with a pointer to the 3.x migration note; announce a date; after that date return `426 CLIENT_TOO_OLD`; eventually remove the shim.

Dates and the exact sequence live in `docs/RELEASE.md`.

## Ordering constraints

- **Phase 1 precedes everything.** An unproven data plane invalidates the CLI and desktop designs.
- **Phase 1.5 precedes Phase 2.** Without a frozen contract the tracks collide. ✅ closed
- **Phase 4 follows Phase 3.** The desktop app needs a stable `core`.
- **G2 precedes 2c.** ✅ closed. 2a, 2b, and 2c *can* run in parallel once the contract is frozen, and for a while they did. They no longer do: with 2a and 2b both code-complete and nothing deployed, the only work that moved the project was getting a port open, and the site can now be built against a tunnel that demonstrably works rather than one that is only tested.
- **Phase 5 precedes 2c and Phase 4.** ADR-0044. Federation changes `apps/api`'s configuration surface and puts a discovery step in front of the client's entry point, so a site documenting how a client finds a server, and a desktop app whose Nodes screen renders that discovery, are both cheaper to write after it than before. v2 still serves users, so nothing downstream is urgent enough to outweigh writing the contract once.
- **`docs/FEATURES.md` §11 precedes nothing.** It is blocked on an ADR, not on a phase.
- **G2 precedes Phase 5.** ✅ closed. Federating a provisioning path that had never run against the live Cloudflare API would have multiplied one unknown by the number of nodes. It has now run, on three operating systems, so this constraint is satisfied rather than merely waived. Phase 5 touches the contract, `apps/api`, and `crates/core`, none of which the release pipeline owns — so 3 can still run alongside it. **The numbers are a reading order, not a queue.**

## Deferred

Not scheduled. Each needs an ADR to promote. See `docs/ARCHITECTURE.md` §9 for why each is out of scope.

TCP/UDP/ICMP tunnelling (ADR-0020) · custom domains · tunnel password protection · multiple ports per tunnel · CLI traffic inspection · request replay in the desktop inspector · self-hosted control-plane one-click deploy.

**Defending a tunnel against the node that issued it.** From Phase 5 a node runs on someone else's Cloudflare account, and the account that owns the zone can attach a Worker route to the hostname — seeing and modifying full request and response bodies, undetectably from the client. Nothing here defends against that, deliberately: NPort is for development and demos, and the exposure is documented in `README.md`, `docs/ARCHITECTURE.md` §1, and ADR-0031 rather than mitigated. Promoting it would mean some combination of trust tiers with signed node entries, an operator identity, and a client-side consent step — a large surface, and one worth designing properly rather than bolting on. Do not confuse this with the *documentation* of the exposure, which is not deferred and is already written.

Three of those appear in `docs/FEATURES.md` as ordinary backlog items — tunnel password protection as §4's edge basic auth, request replay as §5's **Replay**, and the one-click deploy as §12's own-Cloudflare onboarding. Being drawn in the mockup does not schedule them. **Accounts and monetisation** (§11) belong on this list too, and are the one entry here that contradicts an invariant rather than merely postponing a feature.
