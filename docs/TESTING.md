---
applies_to:
  - "**/*.test.ts"
  - "**/tests/**"
  - crates/protocol/tests/**
---

# Testing

The strategy spans two languages, three runtimes (Node, `workerd`, native), and a live external service. That is why it lives in one document instead of being scattered across five `CLAUDE.md` files.

**Status: no tests exist yet.** This is the plan Phase 0 and later implement.

## Tiers

| Tier | Where | Runner | Speed | Runs in |
| --- | --- | --- | --- | --- |
| Unit (TS) | `apps/*`, `packages/*` | Vitest | ms | every commit |
| Integration (Workers) | `apps/api/test` | Vitest + `@cloudflare/vitest-pool-workers` | ~s | every commit |
| **E2E + visual (web)** | `apps/web/e2e` | Playwright | ~10 s | every commit |
| Unit (Rust) | inline `#[cfg(test)]` | `cargo test` | ms | every commit |
| Snapshot (Rust) | `crates/protocol/tests` | `cargo test` + `insta` | ms | every commit |
| Property (Rust) | `crates/protocol`, validators | `proptest` | ~s | every commit |
| **Golden fixtures** | `crates/protocol/tests/fixtures` | `cargo test` | ms | every commit |
| Live edge | `crates/protocol/tests/live` | `cargo test -- --ignored` | ~30 s | nightly, releases |
| Smoke (end-to-end) | `.github/workflows/smoke.yml` | real tunnels, 6 OS | minutes | nightly, releases |
| Canary (protocol) | `.github/workflows/protocol-canary.yml` | live handshake | seconds | every 6 h |

## What must be which

**Unit** — pure logic: subdomain normalization and validation, the reserved list, PoW verification, version comparison, argument parsing, i18n resolution, error-code mapping. Anything with a decision table belongs here, and these are the tests that will catch the most regressions per second of runtime.

**Workers integration, not unit** — anything touching Durable Object storage, alarms, or bindings. Mocking a DO proves nothing: the entire lease design rests on single-threaded execution, at-least-once alarms, and storage surviving isolate death. Test the real semantics in `workerd` or don't claim they work.

Specifically must be integration tests: concurrent claims for the same subdomain serialize and the loser gets 409; a saga interrupted mid-flight compensates on alarm; expiry fires at `min(expires_at, last_heartbeat + 120s)`; the reconciliation cursor resumes correctly; an alarm delivered twice does not double-delete.

**Golden fixtures, not snapshots** — every protocol frame. See below.

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

`tests/golden_fixtures.rs` decodes each one with the real codecs and asserts its structure. Each `.bin` also pairs with an annotated hexdump in `docs/PROTOCOL.md` or the fixtures README, so a human can see what each byte means without a capture tool.

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

`apps/web` is tested with Playwright: behavioural assertions plus `toHaveScreenshot()` visual baselines (ADR-0023). Not yet implemented — it lands with Phase 2c.

Behaviour that must be covered, because nothing else covers it:

- `/docs/[[...slug]]` resolves for every MDX file, and an unknown slug 404s
- `/errors/[code]` renders for a real code from the contract — this is where the CLI deep-links users mid-failure
- the dark-mode toggle persists across a reload, and the anti-FOUC script runs before first paint
- all four JSON-LD blocks are present and parse as JSON
- `sitemap.xml` and `robots.txt` are served, and the sitemap contains no fragment URLs

The original objection to screenshot tests was churn, and it was correct. Three constraints answer it:

1. **Visual snapshots run on one OS in CI.** Font rasterisation differs across platforms, so a baseline shared between a macOS laptop and a Linux runner drifts for reasons that have nothing to do with the site. Linux is the baseline; local runs compare behaviour only.
2. **Playwright's pinned browser builds are the baseline's stability guarantee.** Bumping Playwright is therefore a deliberate act that may legitimately update baselines — same discipline as re-pinning the cloudflared commit.
3. **Dynamic regions are masked, not tolerated.** Anything time-, version-, or count-dependent gets `mask:`. A snapshot that fails intermittently teaches people to re-record without reading, which is strictly worse than no snapshot.

A changed baseline is reviewed like a changed golden fixture: decide whether the intent changed, the browser changed, or the site broke. Never re-record on red without deciding which.

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

The subdomain normalizer is the highest-value target: it runs in **both** TypeScript and Rust, and the two must never disagree. Drive both from one shared fixture file (`packages/contract/fixtures/subdomains.json`) with a test on each side, so a divergence fails a build rather than producing a hostname the server accepts and the client rejects.

## Live-edge tests

`#[ignore]` by default so `cargo test` stays hermetic and offline. They need a real Cloudflare tunnel token and outbound UDP 7844.

```bash
NPORT_TEST_BACKEND=https://api.nport.link cargo test -p nport-protocol -- --ignored
```

They create real tunnels under `smoke-*` and **must clean up in a `Drop` guard**, not at the end of the happy path — a panic mid-test otherwise leaks a lease until expiry. The `smoke-*` prefix is reserved (`docs/ARCHITECTURE.md` §7) so reconciliation can identify them.

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

`smoke.yml`, nightly and on every release, across six runners. Installs the published artifact — not a local build — creates `smoke-<os>-<runid>.nport.link`, asserts a **byte-exact** response through the tunnel, exercises a WebSocket echo, then shuts down gracefully and verifies the lease is gone.

v2's smoke test only checked that the process stayed alive for 30 s and that the log contained no error strings. It would have passed while serving nothing. Assert on the response body.

## Protocol canary

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
