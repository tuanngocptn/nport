# TypeScript conventions

Applies to `apps/node`, `apps/web`, `apps/desktop/src`, and `packages/*`.

Carried forward from v2, which got these right. Biome enforces most of them mechanically (ADR-0013) — prefer a lint rule over a paragraph here.

## Strictness

`strict: true`. **Never `any`.** If a type is genuinely unknown, use `unknown` and narrow it. `as` casts need a comment saying why the compiler cannot see what you can.

`noUncheckedIndexedAccess` is on, so `arr[0]` is `T | undefined`. Handle it.

## Types vs interfaces

`interface` for object shapes, `type` for unions, intersections, and aliases.

```ts
interface TunnelLease {
  subdomain: string
  expiresAt: number
}

type LeaseState = "FREE" | "CLAIMING" | "ACTIVE" | "RELEASING"
```

## Imports

Type-only imports are explicit — Biome's `useImportType` enforces it:

```ts
import type { Context } from "hono"
import { Hono } from "hono"
```

Order is external → internal → types, organized automatically by Biome's assist action. Do not hand-sort.

No `.js` extensions on relative imports. v2 required them because it was hand-rolled ESM on Node; here the bundlers and `workerd` handle resolution.

## Naming

| Element | Convention | Example |
| --- | --- | --- |
| Files | `kebab-case` | `subdomain-lease.ts` |
| React components | `PascalCase` file and export | `Hero.tsx` |
| Classes | `PascalCase` | `CloudflareClient` |
| Functions, variables | `camelCase` | `normalizeSubdomain` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_ACTIVE_TUNNELS` |
| Types, interfaces | `PascalCase` | `TunnelLease` |

## Validation and the contract

Every API input is validated by a zod schema from `packages/contract`, wired through `@hono/zod-validator`. **Never hand-write a validator** — that is how generated types and runtime checks drift, which is exactly the bug class v2 shipped (ADR-0009).

The contract is the authority. If a route needs a new field, add it to `packages/contract` first, regenerate, then use it.

## Errors

Never `throw new Error("...")` in `apps/node`. Throw a typed error carrying a code from the registry:

```ts
throw new ApiError("SUBDOMAIN_IN_USE", { expiresAt })
```

The error-handler middleware maps the code to a status and builds the response envelope. Codes come from `packages/contract`; see `docs/ERRORS.md`.

Never include an upstream Cloudflare error message in a response. Log it, return `UPSTREAM_CLOUDFLARE_ERROR`.

## Workers specifics

- No Node built-ins unless `nodejs_compat` is enabled and you actually need them.
- No module-level mutable state. A Worker isolate is reused across requests from different callers; module scope is not per-request. v2's singletons would be a correctness bug here, not just a testability one.
- Never leave a promise floating. `await` it, or pass it to `ctx.waitUntil()`.
- Bindings come from `env`, never from a module-level import.
- Watch the subrequest budget (50 on the free plan). Provisioning uses ~4; anything that loops over Cloudflare API calls needs an explicit bound.

## React

Server-first in `apps/web`: `"use client"` needs a justification, since the site's job is fast static delivery. `apps/desktop` is entirely client-side, so the rule does not apply there.

No inline hex colours anywhere. Colours come from `packages/design-tokens` via Tailwind utilities (ADR-0014).

## Tests

Vitest. `apps/node` uses `@cloudflare/vitest-pool-workers` so Durable Object storage and alarms run in real `workerd` — a mocked DO proves nothing about the semantics the design depends on. See `docs/TESTING.md`.

## Generated files

Never hand-edit anything with a `@generated` banner: `schema/nport-node.openapi.json`, `schema/nport-registry.openapi.json`, `docs/ERRORS.md`. Edit the source and run `pnpm codegen`. CI fails on drift.

`apps/desktop/src/generated/bindings.ts` will join that list in Phase 4 and is **not** on it yet: the file does not exist, `tauri-specta` is not a dependency, and `apps/desktop` has no `codegen` script (`docs/ROADMAP.md`, defect 42).
