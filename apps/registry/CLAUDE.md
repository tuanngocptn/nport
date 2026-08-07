# apps/registry

## Scope

The node directory. Hono on Cloudflare Workers. Lists nodes, accepts anonymous registrations, and ages what it lists.

**It has no hostname of its own.** Requests arrive on `/v1/nodes*` through `apps/gateway`'s service binding, and `wrangler.jsonc` declares no `routes` and sets `workers_dev: false` (ADR-0049). **Master deployments only** — a node operator deploys gateway + node and this Worker never reaches their account.

**Not responsible for:** provisioning anything, carrying traffic, choosing a node for a client, holding a Cloudflare credential, or *checking* whether a node is up. It has no API token, no account id and no zone id — that absence is the point of splitting it out (ADR-0031).

**Status: deployed to staging** since 2026-08-07, listing node #1 at `api.nport.online/v1/nodes`. Still the only registry in the world, by design — a node deployment has none.

## Layout

```
src/index.ts            createApp(fetcher) + { fetch, scheduled }; exports the DO class
src/routes/nodes.ts     GET and POST /v1/nodes — the whole directory
src/routes/challenge.ts proof of work for a registration; flat difficulty, and why
src/routes/health.ts    liveness, deliberately shallow
src/do/directory.ts     the single DO: node table, challenge ledger, the staleness sweep
src/upstream.ts         the one outbound call, and verifyNodeUrl which keeps it safe
src/sweep.ts            the cron: age every listing, delist the long-silent. Fetches nothing
src/middleware/         forwarded (reads the gateway's identity), require-bindings
src/env.ts              which bindings are required, and why
src/types.ts            Env and Variables — note what is absent
test/fake-upstream.ts   in-memory DNS; throws on an unknown host
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
3. **Capacity is claimed, and `status` is not** (ADR-0049 reverses ADR-0046). `activeTunnels` and `maxActiveTunnels` come from the registration body; `status` is absent from the schema and is always `up` on a registration, because a node that just called is up and a node asking to be listed `down` is asking for what not calling already achieves. Absent capacity stays **absent**, never `0` — a node that looks idle is sorted to the front of every client's list.
4. **`verifyNodeUrl` still runs, and still before anything on the network.** Nothing fetches a node's URL any more, so it is no longer an open-fetch-proxy guard — it is what keeps the DNS proof meaningful: the TXT record proves `<domain>`, so a URL outside `<domain>` is a URL the proof says nothing about, and the directory would be advertising a host the operator has shown no control of.
5. **Nothing here fetches a node.** One outbound call exists, to a DNS resolver. Adding a fetch to a URL a stranger supplied re-opens the amplification surface ADR-0049 closed, and the thing it would learn is what the node already tells us.
6. **The TXT proof's strings come from `packages/contract`** — `nodeProofRecordName`, `nodeProofRecordValue`, `nodeProofSatisfied`. Never retype them: the registry, the operator and `docs/API.md` have to agree, and the docs quote the function rather than restating it.
7. **No module-level mutable state.** Isolates are shared across callers. `createApp(fetcher)` takes its outbound `fetch` as a parameter so tests inject a fake without one. `runScheduled(env)` does not, because it makes no outbound call — a parameter that exists only for tests is one a reader has to rule out.
8. **Fail closed on a missing `x-nport-source-hash`.** `src/middleware/forwarded.ts` refuses rather than synthesising. Synthesising would work, quietly, and every caller reaching this Worker directly would share one identity — which is only impossible while rules about `routes` and `workers_dev` hold, and `pnpm deploy:check` is what holds them.
9. **No CORS headers, ever.** Their absence is an abuse control.
10. **This Worker never sees an IP.** The gateway hashes it and forwards the result, which is stronger than a rule about not logging one.
11. **The list is advisory.** A client caches it, so a registry that is down must never stop a tunnel being created. Anything that makes this load-bearing at provision time breaks the property the whole design rests on.
12. **Selection is the client's.** The registry returns the list, in registration order, including `down` and full nodes. It does not rank, filter, or recommend.

## Common tasks

**Add a rejection reason** — `NODE_REJECTION_REASONS` in `packages/contract/src/node.ts` → use it in `details.reason` → assert it in `test/nodes.test.ts`. The code stays `REGISTRATION_REFUSED`; the reason is what tells an operator which check failed.

**Change a staleness threshold** — `NODE_DOWN_AFTER_SECONDS` / `NODE_DELIST_AFTER_SECONDS` in `wrangler.jsonc` § vars, **both environments**. `test/sweep.test.ts` passes its own, so no test asserts the deployed numbers. Both are seconds of silence, not counts: nothing counts anything here.

**Change what a node reports** — `registerNodeRequestSchema` in `packages/contract`, then `src/routes/nodes.ts` and the `node` table. A field the node cannot be trusted to assert about itself does not belong in that schema; `status` is the example, and capacity is the accepted exception (ADR-0049).

## Gotchas

- **`isolatedStorage` does not exist in vitest-pool-workers 0.20** and passing it is silently ignored, so DO state leaks between tests. Every suite here clears the two tables in `beforeEach` *and* `afterEach`.
- **Every test must send `x-nport-source-hash`**, because that is what arriving through the gateway looks like and `forwarded` refuses anything else. `test/nodes.test.ts` has a `GATEWAY` constant for it.
- **Test difficulty is pinned to 4 bits** in `vitest.config.ts`, because a test that registers several nodes does several solves and vitest's per-test budget is 5 s. **A single 20-bit solve is about 1.2 s**, not a hang: `workerd` does ~870k `crypto.subtle.digest`/sec, measured. The earlier note here said a 20-bit solve "times out", which is wrong in a way that matters — it invites the conclusion that proof of work is infeasible inside a Worker, and node self-registration depends on it being fine.
- **`test/fake-upstream.ts` must never be more generous than reality.** It quotes TXT `data` because a real resolver does, and answers NXDOMAIN as a 200 with no `Answer` rather than a 404. `apps/node`'s fake once invented a field Cloudflare does not send and the whole suite agreed with the resulting bug (`docs/ROADMAP.md`, defect 8). Its **node half is now unused** and deliberately kept: it throws on an unknown host, so a registration that somehow fetched a node would fail loudly rather than quietly pass.
- **Drive the real app, not a copy of its wiring.** `createApp` exists so tests exercise the middleware stack that ships. A hand-assembled test app keeps passing after someone removes a middleware — defect 25, which this app's first sweep test committed before it was caught.
- **One Durable Object for everything.** Unlike `apps/node`, which shards per subdomain and per source: there are at most `MAX_NODES` rows and the sweep reads all of them anyway, so sharding would buy nothing and cost the one property that matters — that id uniqueness is decided in one place with no `await` between the check and the insert.
- **The `node` table's schema is the constructor.** `CREATE TABLE IF NOT EXISTS` only applies to a fresh object, so a column change takes effect nowhere that has already run — safe today **only because this Worker has never been deployed**. After the first deploy, a column change needs an explicit `ALTER TABLE`.
- **A registration is a refresh when the domain matches.** Same id plus a different domain is `id-taken`, which is the takeover case; same id plus the same domain is an upsert, which is how a node re-registers on boot.
