# apps/node

## Scope

**The node service**: it provisions tunnels. Hono on Cloudflare Workers. Validates requests, claims subdomain leases, provisions Cloudflare tunnels and DNS records, and reaps expired leases.

**It has no hostname of its own.** Requests arrive through `apps/gateway`'s service binding; `wrangler.jsonc` declares no `routes` and sets `workers_dev: false` (ADR-0049), which is what makes it safe for `src/middleware/forwarded.ts` to believe `x-nport-source-hash`.

**Not responsible for:** carrying tunnel traffic (it never touches the data path), user identity (there is none), the connector protocol, or the cross-cutting middleware — client gate, rate limiter and request id are the gateway's. Under ADR-0031 it is **a node**: one deployment, one Cloudflare account, one domain. It self-registers with `apps/registry` when `REGISTRY_URL` is set, and is a private deployment when it is not.

**Status: deployed to staging** and serving real tunnels since 2026-08-06. **It was `apps/api`** until ADR-0049: the name belonged to the hostname rather than to this Worker, and `api.nport.link` is the gateway's. Commits before the rename use the `api` scope, which is no longer accepted.
## Layout

```
src/index.ts            Hono app; exports { fetch, scheduled } + all three DO classes
src/routes/             tunnels, challenge, health, meta
src/middleware/         forwarded (reads the gateway's identity), require-bindings
src/do/subdomain-lease.ts   DO per subdomain: atomic claim, saga journal, expiry alarm
src/do/registry.ts          singleton DO: global index, cap, challenge ledger
src/do/source-quota.ts      DO per source: concurrency, hourly quota, PoW difficulty
src/reconcile.ts        the cron sweep: orphan tunnels only, and what it may delete
src/register.ts         registration = heartbeat, fired by cron *and* traffic (ADR-0049)
src/routes/legacy.ts    the v2 method-dispatch shim, and why it is weaker than /v1
src/cloudflare/client.ts    the only place this Worker calls Cloudflare
src/cloudflare/factory.ts   the only place a client is constructed
src/cloudflare/dev-fake.ts  DEV ONLY: an in-memory Cloudflare, behind FAKE_CLOUDFLARE
src/domain/             owner-token, generated-name — pure logic, unit-tested. (subdomains →
                        packages/contract; PoW, envelope and source identity → worker-kit)
src/env.ts              which bindings are required, and why
test/                   workerd integration tests + test/fake-cloudflare.ts
```

## Commands

```bash
pnpm smoke                            # end-to-end against wrangler dev — the only tier that runs dev-fake.ts
pnpm dev                              # this, plus apps/web and apps/desktop
pnpm dev:node                         # wrangler dev with local DOs
pnpm --filter @nport/node test         # vitest-pool-workers
pnpm --filter @nport/node typecheck
pnpm --filter @nport/node deploy       # normally CI does this
pnpm wrangler secret put <NAME>       # runtime secrets, never via CI
```

## Rules

1. **Every route is defined in `packages/contract` first.** Add the schema there, `pnpm codegen`, then implement. Never hand-write a validator.
2. **Never `throw new Error()`.** Throw `ApiError(code)` from `@nport/worker-kit` with a code from the registry. `app.onError` maps it to a status and builds the envelope. The envelope and proof of work are **shared with `apps/registry`** (ADR-0047) — a second copy of either is how one service starts answering in a shape no client parses for.
3. **All Cloudflare API calls go through `src/cloudflare/client.ts`**, and every client is built by `src/cloudflare/factory.ts`. Never `fetch` the CF API directly — the client owns retry, backoff, idempotency, and error mapping — and never `new CloudflareClient` at a call site, or one caller ends up on the real API while the other is on the dev fake.
4. **Anything that must be atomic lives in a Durable Object.** Never in KV, never in module scope.
5. **Every mutation is idempotent.** DO alarms are at-least-once and clients retry.
6. **Journal saga steps before the side effect they describe**, so replay-based compensation is safe.
7. **Never delete a DNS record you cannot prove you own** — verify the CNAME target first (invariant 8).
8. **Never surface an upstream Cloudflare error message.** Log it, return `UPSTREAM_CLOUDFLARE_ERROR` with a `requestId`.
9. **No CORS headers, ever.** Their absence is an abuse control (`docs/API.md`).
10. **`Retry-After` runs in both directions.** Outbound: a 429 or 503 that knows when it frees up must say so. `retryAfterSeconds` in `@nport/worker-kit` derives it from `details.retryAfter` (a duration) or `details.resetAt` (an instant), clamped to 1 s–1 h. A refusal carrying neither — `CONCURRENCY_LIMIT` — deliberately sends no header, because waiting is not the remedy. Inbound: `CloudflareClient` reads the header off a retryable upstream response, honours a delay under a second, and **stops retrying** when it is longer — spending the remaining subrequests on a service that just said "wait 30 s" is how a short rate-limit block becomes a long one.
11. **No module-level mutable state.** Isolates are shared across callers.
12. **Never log a token, an `ownerToken`, or a raw IP.** Source identity is `HMAC(ip, secret)` only.
13. **`GET /v1/meta` costs one Durable Object hop**, and it is the only route that reads storage without provisioning. It is polled by every client at startup, so the hop is deliberate: `activeTunnels` is what makes federated selection possible, and a node that could not report its own headroom would be picked blind. **The registry no longer polls it** — the node sends the same number on its own cron (ADR-0049).
14. **Fail closed on a missing `x-nport-source-hash`.** `src/middleware/forwarded.ts` refuses rather than synthesising one. A synthesised hash would work quietly and give every direct caller one shared identity, with every cap in `docs/ARCHITECTURE.md` §7 keyed on it.
15. Watch the subrequest budget — 50 on the free plan, and a Durable Object hop counts. Provisioning makes **3** Cloudflare calls (`create-tunnel`, `tunnel-token`, `create-dns`), 4 when a DNS conflict forces an ownership check; teardown makes 4. `test/tunnels.test.ts` asserts both lists, so a new saga step shows up as a failing test rather than as a number in a comment. Any loop over CF calls needs an explicit bound.

## Common tasks

**Add an endpoint** — `packages/contract` (schema + route) → `pnpm codegen` → `src/routes/` → test in `test/` → `docs/API.md` if the lifecycle changes.

**Add an error code** — `packages/contract/src/errors.ts` → `pnpm codegen` → translate it in `crates/cli/src/i18n.rs`, or add it to that file's `UNTRANSLATED` test list with the reason a user cannot act on it; a test enforces one or the other. Nothing to change here: the status travels with the code through `@nport/worker-kit`.

**Change the provisioning saga** — `docs/ARCHITECTURE.md` §3a first, then `src/do/subdomain-lease.ts`. Every new step needs a journal entry, a compensation, and an integration test that kills the isolate mid-saga.

**Change a limit or an abuse cap** — `wrangler.jsonc` `vars`, surface it in `GET /v1/meta` so clients discover rather than hardcode it, note the value in `docs/OPERATIONS.md`, and check `test/abuse-controls.test.ts` reads the var instead of the number. **Federate this node, or stop it** — `NODE_ID`, `PUBLIC_URL`, `REGISTRY_URL` and `NODE_VERSION` in `wrangler.jsonc` § vars. **`REGISTRY_URL` is the switch**: unset it and the node never registers and is never listed, which is the private deployment in `docs/SELF_HOSTING.md`. `PUBLIC_URL` is the **gateway's** hostname — this Worker has none — and must be under `CF_DOMAIN`, because the registry refuses a URL outside the domain being proved. It is also what `src/register.ts` fetches to prove itself reachable before every heartbeat. Publishing the TXT record is the operator's job — `docs/API.md` § The registry API says which record.

**Normalize a user-supplied name** — always through `zoneSuffix(env)`, never the contract's default. A node builds URLs from `CF_DOMAIN` and must accept those hostnames back; normalizing against `.nport.link` meant every deployment but the public one refused its own URLs (`docs/ROADMAP.md`, defect 36). The sweeper is the one exception, and deliberately: its input is a bare name from a tunnel name, never a hostname.

**Add a reserved subdomain** — `packages/contract/src/subdomain.ts` plus a fixture case. A reserved *name* is also protected from cleanup; a reserved *prefix* may not be, because `nport-` and `smoke-` are ours to reap (`isProtectedFromCleanup`, ADR-0036).

## Gotchas

- **DO alarms are at-least-once.** A handler that deletes on second delivery must tolerate the record already being gone.
- **`src/cloudflare/dev-fake.ts` has no unit tests and never will — `pnpm smoke` is its coverage.** Nothing in `pnpm test` loads it, so a change there can break `pnpm dev` for everyone with the whole gate green. Run `pnpm smoke` after touching it.
- **`test/fake-cloudflare.ts` is only worth what it gets right, and it must never be more generous than Cloudflare.** It once returned a `result_info.total_pages` on the tunnels list, which that endpoint does not send — so the sweep silently never left page 1 and the suite agreed with the bug. Before trusting a fake response shape, check it: `docs/OPERATIONS.md` § Verifying the Cloudflare API surface.
- **The sweep advances its cursor *before* doing the work, not after.** Advancing only on success looks tidier and lets one undeletable orphan pin the sweep to its page forever, starving every other page — v2's defect R8 through a different door.
- **The test env is not the deployed env, in two ways that both bite.** `.dev.vars` reaches the test isolate — `vitest-pool-workers` reads it alongside `wrangler.jsonc` — so a local `FAKE_CLOUDFLARE=1` routed the saga past `test/fake-cloudflare.ts` and failed 36 tests, all pointing at the saga rather than the config; anything the suite's meaning depends on is pinned in `vitest.config.ts` (`docs/TESTING.md`). And `isolatedStorage` was removed in 0.20 and is *silently ignored*, so DO state leaks between tests unless a suite calls `reset()` in an `afterEach`.
- **Tests send `x-nport-source-hash`, not `cf-connecting-ip`** — that is what arriving through the gateway looks like, and `test/gateway.ts` has the helper. It also makes the per-source tests more honest: they used to rely on the middleware hashing an address, so every one was silently a test of the HMAC too. The rate limiter is the gateway's now, so a test can no longer spend its budget on it — but anything needing many creates from one source still has to drive `SourceQuota` directly or vary the hash.
- **`idFromName(subdomain)` requires the *normalized* subdomain.** Normalizing after deriving the ID gives two DOs for one logical name, and the whole atomicity guarantee evaporates. Normalize first, always.
- **A `wrangler rollback` reverts code, not DO schema.** Migrations are forward-only; deploy schema changes in two compatible steps (`docs/RELEASE.md`).
- **The legacy v2 shim must keep working** until the sunset date. It deliberately does *not* reproduce v2's subdomain-takeover or unauthenticated-delete behaviour — those were the bugs.
- **The shim answers in v2's body shape, and that includes failures raised in middleware.** A rate-limited 2.x client would otherwise receive the `/v1` envelope and print `[object Object]`, so `app.onError` picks the shape by path. Any new middleware on `/` inherits this automatically; any new *response* shape does not.
- **`POST /` has no proof of work**, because a 2.x client cannot solve one. It is the cheapest path to a tunnel that exists, held in check only by the rate limiter, the per-source caps, and the global cap — which is the argument for sunsetting on schedule (`docs/RELEASE.md`).
- `GET /` is a 301 to `https://nport.link`, matching v2. Some users hit the API root by hand.
