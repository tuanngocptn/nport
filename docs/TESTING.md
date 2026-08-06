---
applies_to:
  - "**/*.test.ts"
  - "**/tests/**"
  - crates/protocol/tests/**
---

# Testing

The strategy spans two languages, three runtimes (Node, `workerd`, native), and a live external service. That is why it lives in one document instead of being scattered across five `CLAUDE.md` files.

**Status: implemented for every app and crate except `apps/desktop`**, which is untested and waits on Phase 4. `apps/web` now has both its tiers: Vitest over `src/lib` and `src/content`, and Playwright against the built Worker. Its **visual baselines are wired but not armed** — see § Frontend e2e.

## Tiers

| Tier | Where | Runner | Speed | Runs in |
| --- | --- | --- | --- | --- |
| Unit (TS) | `apps/*`, `packages/*` | Vitest | ms | every commit |
| Integration (Workers) | `apps/api/test` | Vitest + `@cloudflare/vitest-pool-workers` | ~s | every commit |
| **E2E (web)** | `apps/web/e2e` | Playwright, against the built Worker | ~50 s | every commit |
| Unit (Rust) | inline `#[cfg(test)]` | `cargo test` | ms | every commit |
| Snapshot (Rust) | `crates/protocol/tests` | `cargo test` + `insta` | ms | every commit |
| Property (Rust) | `crates/protocol`, validators | `proptest` | ~s | every commit |
| **Golden fixtures** | `crates/protocol/tests/fixtures` | `cargo test` | ms | every commit |
| Live edge | `crates/protocol/tests/live` | `cargo test -- --ignored` | ~30 s | nightly, releases |
| **Smoke (local stack)** | `scripts/smoke.mjs` | `pnpm smoke` | ~40 s | before a push, after any dev-fake or CLI change |
| Smoke (end-to-end) | `.github/workflows/smoke.yml` | real tunnels, 3 OS | minutes | nightly, and per staging deploy |
| Canary (protocol) | `.github/workflows/protocol-canary.yml` | live handshake | seconds | every 6 h — **Phase 3, not yet written** |

One row still describes what will exist rather than what runs: **`protocol-canary.yml` is not written** (Phase 3). Everything else is real and gated. `smoke.yml` is — it runs nightly and on every staging deploy, on macOS, Linux and Windows rather than the six targets the plan named, because the other three are cross-compiled and have no runner to smoke them on.

## What must be which

**Unit** — pure logic: subdomain normalization and validation, the reserved list, PoW verification, version comparison, argument parsing, i18n resolution, error-code mapping. Anything with a decision table belongs here, and these are the tests that will catch the most regressions per second of runtime.

**Workers integration, not unit** — anything touching Durable Object storage, alarms, or bindings. Mocking a DO proves nothing: the entire lease design rests on single-threaded execution, at-least-once alarms, and storage surviving isolate death. Test the real semantics in `workerd` or don't claim they work.

Specifically must be integration tests: concurrent claims for the same subdomain serialize and the loser gets 409; a saga interrupted mid-flight compensates on alarm; expiry fires at `min(expires_at, last_heartbeat + 120s)`; the reconciliation cursor resumes correctly; an alarm delivered twice does not double-delete.

**Golden fixtures, not snapshots** — every protocol frame. See below.

### The fake Cloudflare API, and why it is not the fake edge this document rejects

`apps/api/test/fake-cloudflare.ts` is a stateful in-memory Cloudflare REST API: it holds tunnels and DNS records in maps, answers lookups from them, and can be told to fail a named operation. `apps/api`'s tests install it by replacing `globalThis.fetch`, which reaches inside a Durable Object because the pool runs the Worker under test in the same isolate as the test file.

This looks like the thing "Deliberately untested" rules out for `crates/protocol` — a hand-built fake that encodes our assumptions and therefore passes exactly when we are wrong. The distinction is what each fake is being asked to prove:

- A fake *edge* would be asserting our reading of an **undocumented wire protocol**. It would agree with us by construction, which is why golden fixtures come from `cloudflared` instead.
- The fake *Cloudflare API* asserts nothing about Cloudflare. It exists so the saga's own state machine can be exercised: that a failed DNS write leaves no tunnel behind, that compensation finds a tunnel by name when it has no ID, that teardown refuses a record it cannot prove it owns. Those are claims about **our** logic, and they need a collaborator that has state, not one that is correct.

What it therefore does **not** prove is that the request shapes are right. That gap is real and recorded in `docs/ROADMAP.md` §2a: the Cloudflare API paths have never run against the live API. A stub returning canned replies would have hidden it just as well while feeling safer.

#### There is a second fake, and it must never be the one under test

`apps/api/src/cloudflare/dev-fake.ts` is a *different* in-memory Cloudflare, for `wrangler dev`. It exists so `pnpm dev` can provision without credentials (`docs/CONTRIBUTING.md`), it has no failure injection, and it lives in `src/` rather than `test/` because it ships in the dev bundle.

The two can collide, and did. `@cloudflare/vitest-pool-workers` reads `apps/api/.dev.vars` alongside `wrangler.jsonc`, so the `FAKE_CLOUDFLARE=1` that every local dev session sets also reached the test isolate — routing the saga through the dev fake and straight past `test/fake-cloudflare.ts`. Thirty-six tests failed, and every one of them pointed at the saga rather than at the configuration.

The fix is the rule: **anything the suite's meaning depends on is set explicitly in `vitest.config.ts`**, never inherited from whatever is on a contributor's machine. `FAKE_CLOUDFLARE` and `MIN_CLIENT_VERSION` are pinned there now for exactly that reason. When a test starts behaving differently on CI than locally, that block is the first place to look.

## Golden byte fixtures

The regression net for `crates/protocol`. Byte-exact captures of real frames, asserted unchanged.

```
crates/protocol/tests/fixtures/
├── README.md                        provenance, capture date, edge colo, redaction
├── connect_request_http.bin         ✅ live edge, 2026-08-03
├── connect_request_websocket.bin    ✅ live edge, 2026-08-03
├── connect_response_200.bin         ⬜ needs cloudflared
├── connect_response_error.bin       ⬜ needs cloudflared
├── register_connection_call.bin     ⬜ needs cloudflared
├── register_connection_return.bin   ⬜ needs a teed control stream
└── control_stream_bootstrap.bin     ⬜ needs cloudflared
```

`tests/golden_fixtures.rs` decodes each one with the real codecs and asserts its structure, and `crates/core`'s `exchange` tests replay the two request fixtures **end to end** into a loopback origin — the same bytes driving the whole proxy rather than only the decoder, which is the closest thing to an integration test that needs no network. Each `.bin` also pairs with an annotated hexdump in `docs/PROTOCOL.md` or the fixtures README, so a human can see what each byte means without a capture tool.

### The two directions have different provenance rules

**Frames the edge sends can be captured by our own client.** A `ConnectRequest` originates at Cloudflare, so recording one as it arrives yields authentic edge bytes — better provenance than capturing cloudflared, which would only be relaying them. `NPORT_FIXTURE_DIR` makes the spike do this, teeing the reader so the recorded extent is by construction the extent the decoder consumed.

**Frames the client sends must come from cloudflared.** `ConnectResponse`, the registration call, and the control-stream bootstrap are ours to emit, so capturing them from our own client would assert only that the code agrees with itself. Our encoders are covered by `insta` snapshots instead, which is a genuinely weaker claim — it catches *our* regressions, not a disagreement with cloudflared.

### Capturing the client → edge direction

Not done yet, and it needs cloudflared installed locally. Two viable harnesses:

1. **A local fake edge, preferred.** `cloudflared --edge 127.0.0.1:7844 --cacert <our-ca.pem>` works because `tlsconfig.CreateTunnelConfig` *replaces* the root pool when `--cacert` is given rather than adding to it — so cloudflared will trust a self-signed edge and talk to us. Record every byte it sends. Fully reproducible and scriptable from `cargo xtask fixtures`; the cost is implementing the edge half of the registration RPC.
2. **`SSLKEYLOGFILE` plus Wireshark**, decrypting QUIC and diffing frames against ours. No new code, but manual and unrepeatable in CI.

Neither is a prerequisite for anything downstream: the fixtures protect against future drift, and the frames in question are already verified against the live edge by the fact that registration and proxying work.

### Redaction

The edge stamps the capturing machine's public IP into `Cf-Connecting-Ip` and `X-Forwarded-For`. Fixtures are committed to a public repository, so the capture path overwrites those values **in place and at the same length** before writing — preserving every Cap'n Proto offset while removing the PII. Details and the guard test are in the fixtures README.

### Reviewing a fixture change

A changed fixture means one of: our encoder changed (justify it), the pinned cloudflared commit moved (update `docs/PROTOCOL.md` §1 and re-verify), or **the edge changed** (incident — see `docs/OPERATIONS.md`). Never accept a fixture diff without deciding which of the three it is. Fixtures are CODEOWNER-gated for this reason.

## Frontend e2e and visual regression

`apps/web` is tested with Playwright: behavioural assertions plus `toHaveScreenshot()` visual baselines (ADR-0023). **The behavioural half is implemented — 23 specs in `apps/web/e2e` — and the visual baselines are not armed**; see below for what that means and how to arm them.

**It drives the built Worker, not `next dev`** (ADR-0048). `playwright.config.ts` runs `opennextjs-cloudflare build && preview`, which is slower and is the entire point: the first thing this tier found was that **all 33 `/errors/[code]` pages returned 404 from the Worker** while `next build` prerendered every one and the unit tests passed. No tier that reads `.next/` can see a fault in how the Worker reads its own output.

Use `preview`, never bare `wrangler dev` — `populateCache` is what copies prerendered pages into the assets directory, and skipping it reproduces those same 404s against a build that is fine.

Behaviour covered, because nothing else covers it:

- **every** code in the contract resolves at `/errors/<slug>` and renders its own heading — this is where the CLI deep-links users mid-failure, and checking all 33 rather than a sample is the point: the pages are generated, so the interesting failure is a missing subset
- an unknown slug 404s rather than being rendered on demand
- all four JSON-LD blocks are present and parse, and the `FAQPage` questions are visible on the page
- `SoftwareApplication.featureList` names nothing `src/content/site.ts` holds back
- each page declares **its own** canonical, not the home page's
- `sitemap.xml` and `robots.txt` are served, the sitemap has no fragment URLs, and **every URL in it resolves**
- `/opengraph-image` is a real 1200×630 PNG, checked by its signature and IHDR rather than its status code, and the metadata points at it
- **every internal link in the MDX docs resolves to a route the app serves** (`src/content/docs-links.test.ts`). Nine are error slugs, and a typo'd slug is a 404 handed to somebody already debugging. `cargo xtask verify-docs` covers relative links in `docs/` and does not read MDX, so this is the same guarantee for the user-facing half
- the sections appear in the order `apps/web/CLAUDE.md` rule 1 fixes, and no withheld claim reaches the document
- the theme honours the OS preference and a stored `nport-theme`, and the script that sets it is inline, synchronous and in `<head>`

`/docs` is covered too: every registered page is served and titled, an unregistered slug 404s, MDX is styled rather than served raw, and **the CLI reference page lists exactly the flags the binary accepts** — read from `schema/cli.json`, so adding a flag and regenerating changes the page and the assertion together (ADR-0048, defect 38).

**There is no dark-mode toggle.** This list used to require that "the dark-mode toggle persists across a reload". No such control exists — `docs/mockup/NPort Site.dc.html` does not draw one and the mockup is the authority on UI — so what is asserted is what the site does: honour the OS preference and the `nport-theme` key `apps/desktop` writes.

The original objection to screenshot tests was churn, and it was correct. Three constraints answer it:

1. **Visual snapshots run on one OS in CI.** Font rasterisation differs across platforms, so a baseline shared between a macOS laptop and a Linux runner drifts for reasons that have nothing to do with the site. Linux is the baseline; local runs compare behaviour only.
2. **Playwright's pinned browser builds are the baseline's stability guarantee.** Bumping Playwright is therefore a deliberate act that may legitimately update baselines — same discipline as re-pinning the cloudflared commit.
3. **Dynamic regions are masked, not tolerated.** Anything time-, version-, or count-dependent gets `mask:`. A snapshot that fails intermittently teaches people to re-record without reading, which is strictly worse than no snapshot.

A changed baseline is reviewed like a changed golden fixture: decide whether the intent changed, the browser changed, or the site broke. Never re-record on red without deciding which. Baselines live at `apps/web/e2e/__screenshots__/<platform>/`, with the platform in the path so a locally recorded snapshot cannot be mistaken for the committed Linux one.

**Arming them.** `apps/web/e2e/visual.spec.ts` is skipped unless `NPORT_VISUAL=1`, because no Linux baseline exists yet and one cannot honestly be recorded on macOS — committing a macOS snapshot would fail every CI run, which is the churn the original objection was about. To record the first one, on Linux:

```bash
pnpm --filter @nport/web test:e2e:update   # NPORT_VISUAL=1 playwright test --update-snapshots
```

Then commit `__screenshots__/linux/`, drop the `NPORT_VISUAL` guard in that spec, and the `web-e2e` job compares against it from then on. Until that happens, "visual regression" is wired and unarmed — stated here rather than implied by the ADR, so nobody assumes a snapshot is watching the page.

`apps/desktop` is **not** covered by this. Playwright cannot drive a Tauri WebView; that needs `tauri-driver` with WebdriverIO and arrives with Phase 4. The manual per-platform pass below still stands for it.

## Enforcement

The policy is not advisory. `.claude/hooks/require-tests.sh` runs as a `Stop` hook and blocks a turn that changed source in an area without touching that area's tests, at per-area granularity. The area-to-tier mapping and the exemption list live in `.claude/skills/testing-policy/SKILL.md`.

It checks that a test artifact changed, which is a proxy for coverage rather than coverage itself. That limit is deliberate — anything stricter produces false positives on renames and module declarations — and it means the hook catches forgetting, not gaming.

## Snapshots

`insta` covers every encoder in `crates/protocol` at a level above raw bytes — the parsed structure, so a refactor that preserves semantics but reorders fields is visible and reviewable.

`cargo insta review` to accept. Never `cargo insta accept --all` on a protocol change; read each one.

## Property tests

`proptest` for anything with a roundtrip or an invariant:

- `encode(decode(bytes)) == bytes` for every frame codec
- `normalize(normalize(s)) == normalize(s)` — idempotence
- a validated subdomain always produces a hostname that parses as a DNS name
- PoW verification accepts exactly the nonces the solver produces

The subdomain normalizer is the highest-value target: it runs in **both** TypeScript and Rust, and the two must never disagree. Both are driven from one shared fixture file, `packages/contract/fixtures/subdomains.json` — `packages/contract/src/subdomain.test.ts` and `crates/contract/src/subdomain.rs`'s test module — so a divergence fails a build rather than producing a hostname the server accepts and the client rejects.

**That was aspirational for the whole of Phase 2 and read as done.** This paragraph, `subdomain.ts`'s docblock, and the fixture file's own `$comment` all described two consumers; there was one, because the Rust mirror did not exist (`docs/ROADMAP.md`, defect 34). Two lessons came out of writing it, and they generalise past this file:

- **A shared fixture is only as good as the cases in it.** The mirror passed all nine normalization cases with the trailing-dot strip hoisted out of the suffix loop — a real bug — because the input that distinguishes them lived in the TypeScript *test file* rather than in the shared fixture. Any case that pins a rule both languages implement belongs in the fixture; a case only one suite can see is how the halves drift while both are green.
- **The two must agree on the rejection *reason*, not merely on rejecting.** Every length check runs before the charset check, so the unit a language counts in decides what the user is told. `String.length` counts UTF-16 code units, so the Rust side does too (`wire_length`), and a non-ASCII and an astral case are in the fixture to hold it there.

Adding a case to the fixture is the way to change either side. Add it first, then make both pass.

## Live-edge tests

`#[ignore]` by default so `cargo test` stays hermetic and offline. They need a real Cloudflare tunnel token and outbound UDP 7844.

```bash
NPORT_TEST_BACKEND=https://api.nport.link cargo test -p nport-protocol -- --ignored
```

They create real tunnels and **must clean up in a `Drop` guard**, not at the end of the happy path — a panic mid-test otherwise leaks a lease until expiry.

**They must ask for a *generated* name, not `smoke-anything`.** This paragraph used to say the opposite, and it was wrong twice over: `smoke-` is a reserved *prefix*, so claiming one is a `403`; and reserving a prefix is what makes reconciliation **skip** it, which is the reverse of "so reconciliation can identify them" — a leaked `smoke-` lease would have been the one thing cleanup never reaped. A generated `nport-<base32>` name is unguessable, recognisably ours, and reapable. ADR-0036.

### Manual live drivers — Phase 1 only

Throwaway harnesses under `crates/protocol/tests/live/` and `examples/`, driven by hand because they need a tunnel and a person watching. None is a test: `cargo test` never runs them, and they all disappear when `crates/core` takes over the connection lifecycle.

```bash
./crates/protocol/tests/live/tunnel.sh builtin ws-spike 180   # provision, serve, delete on exit
cargo run -p nport-protocol --example ws_client -- wss://ws-spike.nport.link/
./crates/protocol/tests/live/pool.sh builtin pool-spike       # 4 connections, 30 min — criterion 4
```

`tunnel.sh` provisions through the live v2 API, runs the spike, and deletes the tunnel from a `trap` so Ctrl+C still cleans up. Pass a port instead of `builtin` to expose a real local server; `builtin` uses the spike's own origin, which serves a fixed body over HTTP and echoes over WebSocket.

`ws_client` is what closes G1 criterion 3: it alternates text and binary messages, asserts each comes back byte-identical, and finishes with one 64 KiB frame — small frames can round-trip perfectly through a pipe that truncates at a read-buffer boundary. `NPORT_WS_RESOLVE=<edge-ip>` bypasses a resolver that negative-cached the record's NXDOMAIN, which macOS does aggressively for a name created seconds ago.

`pool.sh` closes criterion 4, and **its exit code is the verdict** — the `pool` example prints a four-line checklist and fails if any part did not hold, so nobody has to interpret a wall of log. `NPORT_POOL_KILL_EVERY` forces a disconnect on a rotating connection index; that is a *local* close, so it exercises detection, rotation, and re-registration but not the QUIC idle-timeout path, which needs the network to genuinely disappear. Toggle Wi-Fi for that, and say which one you ran when you report a result.

Run a traffic loop alongside it. Four connections staying registered is the criterion, but a connection can be registered and unroutable; a stream of `200`s across the forced disconnects is what proves it wasn't.

**The token reaches these only through the environment.** Never argv — `ps` shows argv to every local user, which is the v2 defect this rewrite exists to remove.

## Smoke tests

There are two, and they answer different questions.

### `pnpm smoke` — the local stack, on demand

**Every run uses a fresh source address, and one control is lifted deliberately.** The per-source hourly quota and the ADR-0028 difficulty dial are cumulative, so a harness that reuses an address competes with its own history — repeated runs got slower until a proof-of-work solve took long enough to look like the server crashing. Sources are randomised inside the documentation ranges; the hourly quota is raised for the run because the CLI cannot set `cf-connecting-ip`, so every invocation of the binary arrives as the same source. The *concurrency* cap keeps its real value, because that is the one the IPv6 check asserts.

`scripts/smoke.mjs`. Starts `wrangler dev` and a local origin on ports of its own, then drives the real Worker and the real `nport` binary: proof of work at the deployed difficulty, a claim, the journaled saga, the URL, a graceful Ctrl+C, and the lease gone afterwards. It also re-checks the fixes that only a running stack can prove — the per-source cap over IPv6 (ADR-0033), the oversized-input bound (ADR-0034), and the connector-token fetch (ADR-0032).

**It exists because `pnpm test` covers none of that.** The vitest suite runs in real `workerd`, but it never starts `wrangler dev`, never runs the binary, and never loads `src/cloudflare/dev-fake.ts` — so a change to the dev fake could break `pnpm dev` for everybody with the whole gate green. That nearly happened when the connector token moved to its own endpoint, and the first run of this script found two real defects that eleven review passes had not.

The credential is fake, so the edge refuses registration on purpose: everything up to the lease is real, the QUIC dial genuinely happens, and what gets exercised past that point is the retry ladder and the release. A tunnel that carries traffic needs a deployment.

### `smoke.yml` — the only test that opens a port on the internet

**Written and running.** Nightly at 03:20 UTC, on every staging deploy, and on demand, across macOS, Linux and Windows. It provisions a real lease on the deployed control plane, dials Cloudflare's edge over QUIC, creates a tunnel under a **generated** name, asserts a **byte-exact** response through it, exercises a WebSocket echo, then shuts down gracefully and verifies the lease is gone. It is the mechanism behind Gate G2's cross-platform criterion.

Three runners rather than the six targets the plan named: the other three are cross-compiled and GitHub has no runner to smoke them on. **What remains for Phase 3** is the artifact it installs — today it builds the CLI from source, and once the npm packages, Homebrew tap and Scoop manifest exist it should install the *published* one, which is a different claim and the one users depend on.

v2's smoke test only checked that the process stayed alive for 30 s and that the log contained no error strings. It would have passed while serving nothing. Assert on the response body.

## Protocol canary (Phase 3, not yet written)

`protocol-canary.yml`, every 6 hours: minimal handshake against the live edge, no local server, no HTTP request. Just discovery → QUIC → register → unregister.

On failure it opens or updates **one pinned issue** (never a new issue per run) and notifies. This is the earliest warning for the highest-blast-radius failure in the system — an edge protocol change breaks every installed client at once, and users cannot fix it themselves.

Deliberately narrow: it should fail only when the protocol actually breaks. A flaky canary that people learn to ignore is worse than none.

## Coverage

No numeric threshold — a percentage target drives tests written for the metric. Instead, these must have tests, and a PR touching them without one gets sent back:

- every branch in subdomain validation and normalization
- every state transition and compensation in the provisioning saga
- every error code's status mapping
- every protocol frame encoder and decoder
- argument parsing, including the malformed cases v2 got wrong (`nport -s app 3000`, `-s -l vi`, unknown flags)
- shutdown paths, including double Ctrl+C and shutdown mid-provision

## Deliberately untested

Stated so nobody mistakes a gap for an oversight:

- ~~**Marketing page visual appearance.**~~ **Superseded by ADR-0023** — `apps/web` now has Playwright e2e including visual snapshots. The churn objection was real and is answered by constraint rather than optimism; see below.
- **Tauri WebView rendering.** Manual per platform before a desktop release (`docs/RELEASE.md`).
- **Cloudflare's own behaviour.** We test our client against it; we do not test their API.
- **`crates/protocol` against a fake edge.** A hand-built mock edge would encode our *assumptions* about the protocol, so it would pass precisely when we are wrong. Golden fixtures plus live tests instead.

## Running things

```bash
pnpm test                      # all TS
pnpm --filter @nport/api test  # Workers integration only
cargo test                     # all Rust, hermetic
cargo test -p nport-protocol   # protocol only
cargo test -- --ignored        # live edge, needs network + token
cargo insta review             # review snapshot changes
```
