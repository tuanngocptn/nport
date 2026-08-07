# apps/gateway

## Scope

The public front door for a deployment: `api.nport.link` (production), `api.nport.online` (staging). It applies the cross-cutting concerns once and dispatches to the internal services over Cloudflare service bindings (ADR-0049).

**This is the only Worker in a deployment with a route.** `apps/node` (the node) and `apps/registry` declare none and set `workers_dev: false`, so they are reachable through their bindings and nowhere else. `pnpm deploy:check` fails the deploy if either grows one.

**Not responsible for:** provisioning anything, storing anything, or holding a Cloudflare credential. It has no Durable Object and no cron. If a change here needs either, it belongs in a service.

**Status: deployed to staging** since 2026-08-06, fronting real tunnels on `api.nport.online`.

## Layout

```
src/index.ts                          the app: middleware, three dispatch rules, the error envelope
src/env.ts                            what must be bound before it serves; requireBindings
src/types.ts                          Env, Variables, and the two forwarded header names
src/middleware/                       request-id, client-gate, rate-limit
test/dispatch.test.ts                 what crosses the binding, and what is overwritten first
test/conformance.test.ts              every contract path reaches the right service
test/legacy-gap.test.ts               the v2 shim is unreachable, deliberately, and this says so
wrangler.jsonc vitest.config.ts tsconfig.json
```

## Commands

```bash
pnpm --filter @nport/gateway dev      # wrangler dev; the bindings need the other Workers running
pnpm --filter @nport/gateway test     # real workerd, with the services stubbed
pnpm --filter @nport/gateway deploy   # normally CI does this
```

## Rules

1. **Never hold a Cloudflare credential.** The gateway terminates every public request, so it is the largest attack surface in a deployment and the one thing that must not be able to provision. Tunnels are the node's job.
2. **Forwarded headers are set, never inherited.** `x-nport-source-hash` and `x-nport-request-id` are overwritten on every forward. A caller who could choose their own source hash would adopt any identity and walk past every per-source cap in `SourceQuota` at once.
3. **The internal services trust those headers because they are unreachable.** That is a deployment property, not a cryptographic one — give either service a `routes` entry and rule 2's guarantee evaporates silently.
4. **Dispatch by path prefix only.** `/v1/nodes*` → registry, `/v1/*` → node. The contract keeps the two route tables disjoint and three conformance tests hold it there; a router that needed to inspect a body would mean the contract had gone wrong.
5. **`REGISTRY` is optional, `NODE` is not.** A node-only deployment omits the registry binding, so `/v1/nodes` does not exist there rather than 404ing — that is what makes role a deployment rather than a configuration flag.
6. **`/v1/health` is answered here and never forwarded**, and is exempt from the client gate, the rate limiter and the binding check. An uptime monitor sends no NPort headers and must be able to tell a running-but-misconfigured Worker from a dead one. It is `SHARED_ROUTES` in `packages/contract` — a third table for what the front door owns. All four properties are asserted rather than trusted, across **two** files: `test/conformance.test.ts` covers answered-here-not-forwarded, the contract's response shape, and the client-gate exemption; `test/dispatch.test.ts` covers the rate-limiter exemption and the binding-check exemption.
7. **Every failure carries a code.** The config check is Hono middleware rather than a guard in the `fetch` export, because a throw outside the app never reaches `onError` and `workerd` answers with a bare 500.

## Gotchas

- **Hono context does not cross a service binding.** `c.var.sourceHash` is meaningless on the other side; that is why it travels as a header.
- **The rate limiter counts in a fixed window aligned to the wall clock, not a sliding one.** A test that sends `limit + 1` requests can therefore see them split across two windows and trip nothing — which is what made `dispatch.test.ts` pass locally, pass on one CI workflow and fail on another, on the same commit (`docs/ROADMAP.md`, defect 45). Anything asserting the limiter *engages* must send more than **twice** the limit, and `vitest.config.ts` injects the real ceiling so the loop cannot be sized against a number that has since changed.
- **`namespace_id` for the rate limiter must be unique per Worker.** 1003 is this one, and it is now the only `ratelimits` binding in the repo — the node's 1001 and the registry's 1002 went with their limiters. The numbers stay reserved so a service later given its own limiter does not collide.
- **A service binding still counts against the subrequest budget** (50 on the free plan). It skips DNS and TLS, not accounting.
- **The stubs in `vitest.config.ts` echo the request back**, which is what lets a test assert on the headers the gateway set rather than on a status code. Binding to the real services would test three Workers and answer a different question.
- **`service` names the deployed script, not the app directory.** They match today — `apps/node` deploys as `nport-node` — and a binding naming a script no `wrangler.jsonc` deploys is rejected by Cloudflare *after* the other Workers have already gone out. `checkReachability`'s neighbour in `scripts/deploy-check.mjs` catches it first; it exists because the gateway shipped bound to `nport-node` for a day while the script was still `nport-api`.
- **`pnpm dev` and `pnpm smoke` run this Worker too**, and the service bindings resolve through wrangler's dev registry between concurrent `wrangler dev` sessions. Pointing a client at the node's port directly gets `INTERNAL`, correctly: no gateway, no identity.
