# apps/api

## Scope

The control plane at `api.nport.link`. Hono on Cloudflare Workers. Validates requests, claims subdomain leases, provisions Cloudflare tunnels and DNS records, and reaps expired leases.

**Not responsible for:** carrying tunnel traffic (it never touches the data path), user identity (there is none), or the connector protocol.

**Status: Phase 2a complete.** Lease lifecycle, abuse controls, reconciliation cron, and the v2 compatibility shim. Not yet deployed, and the Cloudflare API paths are unverified against the live API (`docs/ROADMAP.md`).

## Layout

```
src/index.ts            Hono app; exports { fetch, scheduled } + all three DO classes
src/routes/             tunnels, challenge, health, meta
src/middleware/         request-id, client-gate, require-bindings, rate-limit
src/do/subdomain-lease.ts   DO per subdomain: atomic claim, saga journal, expiry alarm
src/do/registry.ts          singleton DO: global index, cap, challenge ledger
src/do/source-quota.ts      DO per source: concurrency, hourly quota, PoW difficulty
src/reconcile.ts        the cron sweep: orphan tunnels only, and what it may delete
src/routes/legacy.ts    the v2 method-dispatch shim, and why it is weaker than /v1
src/cloudflare/client.ts    the only place this Worker calls Cloudflare
src/cloudflare/factory.ts   the only place a client is constructed
src/cloudflare/dev-fake.ts  DEV ONLY: an in-memory Cloudflare, behind FAKE_CLOUDFLARE
src/domain/             pow, ip-hash, owner-token, generated-name — pure logic, unit-tested
                        (subdomain validation lives in packages/contract, not here)
src/errors.ts           ErrorCode → HTTP status; codes imported from @nport/contract
src/env.ts              which bindings are required, and why
test/                   workerd integration tests + test/fake-cloudflare.ts
```

## Commands

```bash
pnpm smoke                            # end-to-end against wrangler dev — the only tier that runs dev-fake.ts
pnpm dev                              # this, plus apps/web and apps/desktop
pnpm dev:api                          # wrangler dev with local DOs
pnpm --filter @nport/api test         # vitest-pool-workers
pnpm --filter @nport/api typecheck
pnpm --filter @nport/api deploy       # normally CI does this
pnpm wrangler secret put <NAME>       # runtime secrets, never via CI
```

## Rules

1. **Every route is defined in `packages/contract` first.** Add the schema there, `pnpm codegen`, then implement. Never hand-write a validator.
2. **Never `throw new Error()`.** Throw `ApiError(code)` with a code from the registry. The error-handler middleware maps it to a status and builds the envelope.
3. **All Cloudflare API calls go through `src/cloudflare/client.ts`**, and every client is built by `src/cloudflare/factory.ts`. Never `fetch` the CF API directly — the client owns retry, backoff, idempotency, and error mapping — and never `new CloudflareClient` at a call site, or one caller ends up on the real API while the other is on the dev fake.
4. **Anything that must be atomic lives in a Durable Object.** Never in KV, never in module scope.
5. **Every mutation is idempotent.** DO alarms are at-least-once and clients retry.
6. **Journal saga steps before the side effect they describe**, so replay-based compensation is safe.
7. **Never delete a DNS record you cannot prove you own** — verify the CNAME target first (invariant 8).
8. **Never surface an upstream Cloudflare error message.** Log it, return `UPSTREAM_CLOUDFLARE_ERROR` with a `requestId`.
9. **No CORS headers, ever.** Their absence is an abuse control (`docs/API.md`).
10. **`Retry-After` runs in both directions.** Outbound: a 429 or 503 that knows when it frees up must say so. `retryAfterSeconds` in `errors.ts` derives it from `details.retryAfter` (a duration) or `details.resetAt` (an instant), clamped to 1 s–1 h. A refusal carrying neither — `CONCURRENCY_LIMIT` — deliberately sends no header, because waiting is not the remedy. Inbound: `CloudflareClient` reads the header off a retryable upstream response, honours a delay under a second, and **stops retrying** when it is longer — spending the remaining subrequests on a service that just said "wait 30 s" is how a short rate-limit block becomes a long one.
11. **No module-level mutable state.** Isolates are shared across callers.
12. **Never log a token, an `ownerToken`, or a raw IP.** Source identity is `HMAC(ip, secret)` only.
13. Watch the subrequest budget — 50 on the free plan, and a Durable Object hop counts. Provisioning makes **3** Cloudflare calls (`create-tunnel`, `tunnel-token`, `create-dns`), 4 when a DNS conflict forces an ownership check; teardown makes 4. `test/tunnels.test.ts` asserts both lists, so a new saga step shows up as a failing test rather than as a number in a comment. Any loop over CF calls needs an explicit bound.

## Common tasks

**Add an endpoint** — `packages/contract` (schema + route) → `pnpm codegen` → `src/routes/` → `src/errors.ts` if new codes → test in `test/` → `docs/API.md` if the lifecycle changes.

**Add an error code** — `packages/contract/src/errors.ts` → `pnpm codegen` (regenerates `docs/ERRORS.md`, `crates/contract`, and the website page) → translate it in `crates/cli/src/i18n.rs`, or add it to that file's `UNTRANSLATED` test list with the reason a user cannot act on it; a test enforces one or the other → assert the status mapping in a test.

**Change the provisioning saga** — `docs/ARCHITECTURE.md` §3a first, then `src/do/subdomain-lease.ts`. Every new step needs a journal entry, a compensation, and an integration test that kills the isolate mid-saga.

**Change a limit** — `wrangler.jsonc` `vars`, surface it in `GET /v1/meta` so clients discover rather than hardcode it, and note the value in `docs/OPERATIONS.md`.

**Add a reserved subdomain** — `packages/contract/src/subdomain.ts` plus a fixture case. A reserved *name* is also protected from cleanup; a reserved *prefix* may not be, because `nport-` and `smoke-` are ours to reap (`isProtectedFromCleanup`, ADR-0036).

**Change an abuse limit** — `wrangler.jsonc` § vars, then confirm `GET /v1/meta` still reports it (clients discover limits rather than hardcoding them) and that `test/abuse-controls.test.ts` reads the var instead of the number.

## Gotchas

- **DO alarms are at-least-once.** A handler that deletes on second delivery must tolerate the record already being gone.
- **`src/cloudflare/dev-fake.ts` has no unit tests and never will — `pnpm smoke` is its coverage.** Nothing in `pnpm test` loads it, so a change there can break `pnpm dev` for everyone with the whole gate green. Run `pnpm smoke` after touching it.
- **`test/fake-cloudflare.ts` is only worth what it gets right, and it must never be more generous than Cloudflare.** It once returned a `result_info.total_pages` on the tunnels list, which that endpoint does not send — so the sweep silently never left page 1 and the suite agreed with the bug. Before trusting a fake response shape, check it: `docs/OPERATIONS.md` § Verifying the Cloudflare API surface.
- **The sweep advances its cursor *before* doing the work, not after.** Advancing only on success looks tidier and lets one undeletable orphan pin the sweep to its page forever, starving every other page — v2's defect R8 through a different door.
- **`.dev.vars` reaches the test isolate**, because `vitest-pool-workers` reads it alongside `wrangler.jsonc`. A local `FAKE_CLOUDFLARE=1` therefore routed the saga past `test/fake-cloudflare.ts` and failed 36 tests, all pointing at the saga rather than the config. Anything the suite's meaning depends on is pinned in `vitest.config.ts` (`docs/TESTING.md`).
- **Durable Object state leaks between tests.** `vitest-pool-workers` 0.20 removed `isolatedStorage`, and passing it is *silently ignored* — so a suite that writes any DO state must call `reset()` from `cloudflare:test` in an `afterEach`, or you get failures that depend on test order.
- **The four abuse controls are layered, and a test that spends its requests on the outer one is not testing the inner one.** The rate limiter allows 60 requests per minute per source, and a create costs two (challenge, then create) — so anything needing more than ~30 creates from one address must drive `SourceQuota` directly or use a different `cf-connecting-ip`.
- **`idFromName(subdomain)` requires the *normalized* subdomain.** Normalizing after deriving the ID gives two DOs for one logical name, and the whole atomicity guarantee evaporates. Normalize first, always.
- **A `wrangler rollback` reverts code, not DO schema.** Migrations are forward-only; deploy schema changes in two compatible steps (`docs/RELEASE.md`).
- **The legacy v2 shim must keep working** until the sunset date. It deliberately does *not* reproduce v2's subdomain-takeover or unauthenticated-delete behaviour — those were the bugs.
- **The shim answers in v2's body shape, and that includes failures raised in middleware.** A rate-limited 2.x client would otherwise receive the `/v1` envelope and print `[object Object]`, so `app.onError` picks the shape by path. Any new middleware on `/` inherits this automatically; any new *response* shape does not.
- **`POST /` has no proof of work**, because a 2.x client cannot solve one. It is the cheapest path to a tunnel that exists, held in check only by the rate limiter, the per-source caps, and the global cap — which is the argument for sunsetting on schedule (`docs/RELEASE.md`).
- `GET /` is a 301 to `https://nport.link`, matching v2. Some users hit the API root by hand.
