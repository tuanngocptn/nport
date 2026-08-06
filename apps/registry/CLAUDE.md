# apps/registry

## Scope

The node directory at `registry.nport.link`. Hono on Cloudflare Workers. Lists nodes, accepts anonymous registrations, and probes what it lists.

**Not responsible for:** provisioning anything, carrying traffic, choosing a node for a client, or holding a Cloudflare credential. It has no API token, no account id and no zone id — that absence is the point of splitting it out (ADR-0031).

**Status: written, never deployed.** Phase 5, step 2 of 4 (`docs/ROADMAP.md`). `apps/api` does not self-register yet and `crates/core` has no discovery step, so nothing calls this in anger.

## Layout

```
src/index.ts            createApp(fetcher) + { fetch, scheduled }; exports the DO class
src/routes/nodes.ts     GET and POST /v1/nodes — the whole directory
src/routes/challenge.ts proof of work for a registration; flat difficulty, and why
src/routes/health.ts    liveness, deliberately shallow
src/do/directory.ts     the single DO: node table, challenge ledger, probe bookkeeping
src/upstream.ts         the only two outbound calls, and verifyNodeUrl which makes them safe
src/probe.ts            the cron sweep: probe every node, delist the long-dead
src/middleware/         request-id, client-gate, rate-limit, require-bindings
src/env.ts              which bindings are required, and why
src/types.ts            Env and Variables — note what is absent
test/fake-upstream.ts   in-memory DNS and node /v1/meta; throws on an unknown host
```

## Commands

```bash
pnpm --filter @nport/registry test
pnpm --filter @nport/registry typecheck
pnpm --filter @nport/registry dev       # wrangler dev with a local DO
pnpm --filter @nport/registry deploy    # normally CI does this
```

## Rules

1. **Every route is defined in `packages/contract` first**, then `pnpm codegen`, then implemented. Never hand-write a validator.
2. **Never `throw new Error()`.** Throw `ApiError(code)` from `@nport/worker-kit`; `app.onError` builds the envelope.
3. **Capacity is observed, never claimed** (ADR-0046). It comes from a node's `GET /v1/meta` and from nowhere else. A registration that carries `activeTunnels` has it stripped — and there is a test asserting the listed value is the probed one, not the sent one.
4. **`verifyNodeUrl` runs before any subrequest.** It is the load-bearing check here: it stops the registry being an open fetch proxy, and it is what makes the DNS proof cover the URL we actually fetch. A registration whose URL is not under the proved domain must cost zero subrequests.
5. **The TXT proof's strings come from `packages/contract`** — `nodeProofRecordName`, `nodeProofRecordValue`, `nodeProofSatisfied`. Never retype them: the registry, the operator and `docs/API.md` have to agree, and the docs quote the function rather than restating it.
6. **No module-level mutable state.** Isolates are shared across callers. `createApp(fetcher)` and `runScheduled(env, fetcher)` take their outbound `fetch` as a parameter so tests inject a fake without one.
7. **No CORS headers, ever.** Their absence is an abuse control.
8. **Never log a raw IP.** Source identity is `HMAC(ip, secret)` over the address prefix, from `@nport/worker-kit` — sharing that function is what stops defect 9's IPv6 hole reappearing here.
9. **The list is advisory.** A client caches it, so a registry that is down must never stop a tunnel being created. Anything that makes this load-bearing at provision time breaks the property the whole design rests on.
10. **Selection is the client's.** The registry returns the list, in registration order, including `down` and full nodes. It does not rank, filter, or recommend.

## Common tasks

**Add a rejection reason** — `NODE_REJECTION_REASONS` in `packages/contract/src/node.ts` → use it in `details.reason` → assert it in `test/nodes.test.ts`. The code stays `REGISTRATION_REFUSED`; the reason is what tells an operator which check failed.

**Change a probe threshold** — `wrangler.jsonc` § vars, both environments. `test/probe.test.ts` overrides them per test, so no test asserts the deployed numbers.

**Change what a probe reads** — `Observation` in `src/upstream.ts`, then `recordSuccess` in the DO. Remember `/v1/meta` publishes `minClientVersion`, not the node's own version, so a probe cannot learn a node's build.

## Gotchas

- **`isolatedStorage` does not exist in vitest-pool-workers 0.20** and passing it is silently ignored, so DO state leaks between tests. Every suite here clears the two tables in `beforeEach` *and* `afterEach`.
- **Test difficulty is pinned to 4 bits** in `vitest.config.ts`, because a test that registers several nodes does several solves and vitest's per-test budget is 5 s. **A single 20-bit solve is about 1.2 s**, not a hang: `workerd` does ~870k `crypto.subtle.digest`/sec, measured. The earlier note here said a 20-bit solve "times out", which is wrong in a way that matters — it invites the conclusion that proof of work is infeasible inside a Worker, and node self-registration depends on it being fine.
- **`test/fake-upstream.ts` must never be more generous than reality.** It quotes TXT `data` because a real resolver does, and answers NXDOMAIN as a 200 with no `Answer` rather than a 404. `apps/api`'s fake once invented a field Cloudflare does not send and the whole suite agreed with the resulting bug (`docs/ROADMAP.md`, defect 8).
- **Drive the real app, not a copy of its wiring.** `createApp` exists so tests exercise the middleware stack that ships. A hand-assembled test app keeps passing after someone removes the client gate — defect 25, which this app's first probe test committed before it was caught.
- **One Durable Object for everything.** Unlike `apps/api`, which shards per subdomain and per source: there are at most `MAX_NODES` rows and the cron reads all of them anyway, so sharding would buy nothing and cost the one property that matters — that id uniqueness is decided in one place with no `await` between the check and the insert.
- **A registration is a refresh when the domain matches.** Same id plus a different domain is `id-taken`, which is the takeover case; same id plus the same domain is an upsert, which is how a node re-registers on boot.
