# @nport/contract

**The authority for the control-plane API.** zod schemas, route definitions, and the error registry.

Everything else is generated from here:

```
packages/contract  ──►  schema/nport-node.openapi.json  ──►  crates/contract
       │
       ├──►  docs/ERRORS.md
       └──►  apps/web  /errors/[code] pages
```

`apps/node` imports the schemas directly and validates with `@hono/zod-validator`, so runtime validation and the generated types come from one definition and cannot drift. That drift is exactly the bug class v2 shipped — see [ADR-0009](../../docs/DECISIONS.md) and [ADR-0018](../../docs/DECISIONS.md).

Adding or changing an endpoint, a field, or an error code **starts here**, then `pnpm codegen`.

`fixtures/subdomains.json` holds the shared normalization and validation cases, exercised by tests in both TypeScript and Rust so the two implementations cannot disagree.

**Not implemented.** Phase 1.5 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md) — and it is the serializing dependency for all of Phase 2.
