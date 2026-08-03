# apps/api

## Scope

The control plane at `api.nport.link`. Hono on Cloudflare Workers. Validates requests, claims subdomain leases, provisions Cloudflare tunnels and DNS records, and reaps expired leases.

**Not responsible for:** carrying tunnel traffic (it never touches the data path), user identity (there is none), or the connector protocol.

**Status: not implemented.** Phase 2a.

## Layout

```
src/index.ts            Hono app; exports { fetch, scheduled } + both DO classes
src/routes/             tunnels, challenge, health, meta
src/middleware/         request-id, client-gate, rate-limit, pow, error-handler
src/do/subdomain-lease.ts   DO per subdomain: atomic claim, saga journal, expiry alarm
src/do/registry.ts          singleton DO: global index, sweep cursor, counters
src/cloudflare/         typed CF API client with retry, backoff, idempotency
src/domain/             subdomain, reserved, pow, ip-hash — pure logic, heavily unit-tested
src/errors.ts           ErrorCode → HTTP status; codes imported from @nport/contract
test/
```

## Commands

```bash
pnpm dev:api                          # wrangler dev with local DOs
pnpm --filter @nport/api test         # vitest-pool-workers
pnpm --filter @nport/api typecheck
pnpm --filter @nport/api deploy       # normally CI does this
pnpm wrangler secret put <NAME>       # runtime secrets, never via CI
```

## Rules

1. **Every route is defined in `packages/contract` first.** Add the schema there, `pnpm codegen`, then implement. Never hand-write a validator.
2. **Never `throw new Error()`.** Throw `ApiError(code)` with a code from the registry. The error-handler middleware maps it to a status and builds the envelope.
3. **All Cloudflare API calls go through `src/cloudflare/client.ts`.** Never `fetch` the CF API directly — the client owns retry, backoff, idempotency, and error mapping.
4. **Anything that must be atomic lives in a Durable Object.** Never in KV, never in module scope.
5. **Every mutation is idempotent.** DO alarms are at-least-once and clients retry.
6. **Journal saga steps before the side effect they describe**, so replay-based compensation is safe.
7. **Never delete a DNS record you cannot prove you own** — verify the CNAME target first (invariant 8).
8. **Never surface an upstream Cloudflare error message.** Log it, return `UPSTREAM_CLOUDFLARE_ERROR` with a `requestId`.
9. **No CORS headers, ever.** Their absence is an abuse control (`docs/API.md`).
10. **No module-level mutable state.** Isolates are shared across callers.
11. **Never log a token, an `ownerToken`, or a raw IP.** Source identity is `HMAC(ip, secret)` only.
12. Watch the subrequest budget — 50 on the free plan. Provisioning uses ~4; any loop over CF calls needs an explicit bound.

## Common tasks

**Add an endpoint** — `packages/contract` (schema + route) → `pnpm codegen` → `src/routes/` → `src/errors.ts` if new codes → test in `test/` → `docs/API.md` if the lifecycle changes.

**Add an error code** — `packages/contract/src/errors.ts` → `pnpm codegen` (regenerates `docs/ERRORS.md`, `crates/contract`, and the website page) → add translations in `crates/cli` → assert the status mapping in a test.

**Change the provisioning saga** — `docs/ARCHITECTURE.md` §3a first, then `src/do/subdomain-lease.ts`. Every new step needs a journal entry, a compensation, and an integration test that kills the isolate mid-saga.

**Change a limit** — `wrangler.jsonc` `vars`, surface it in `GET /v1/meta` so clients discover rather than hardcode it, and note the value in `docs/OPERATIONS.md`.

**Add a reserved subdomain** — `src/domain/reserved.ts` plus a unit test. The sweeper shares this list, so a name added here is also protected from cleanup.

## Gotchas

- **DO alarms are at-least-once.** A handler that deletes on second delivery must tolerate the record already being gone.
- **`vitest-pool-workers` needs `isolatedStorage`** per test, or DO state leaks between cases and you get failures that depend on test order.
- **`idFromName(subdomain)` requires the *normalized* subdomain.** Normalizing after deriving the ID gives two DOs for one logical name, and the whole atomicity guarantee evaporates. Normalize first, always.
- **A `wrangler rollback` reverts code, not DO schema.** Migrations are forward-only; deploy schema changes in two compatible steps (`docs/RELEASE.md`).
- **The legacy v2 shim must keep working** until the sunset date. It deliberately does *not* reproduce v2's subdomain-takeover or unauthenticated-delete behaviour — those were the bugs.
- `GET /` is a 301 to `https://nport.link`, matching v2. Some users hit the API root by hand.
