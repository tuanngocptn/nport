# schema/

Language-neutral generated contract artifacts.

`nport-api.openapi.json` is the OpenAPI description of the control-plane API. It is **generated** from `packages/contract` and **committed**, then consumed by `crates/contract` (via `typify`) and rendered on the website.

It is committed on purpose: a diff on this file is the clearest possible signal that an API change is about to affect the Rust client, so it belongs in code review rather than being regenerated invisibly in CI.

Do not hand-edit it. `pnpm codegen` regenerates it; CI fails if the result differs from what is committed.

**Not implemented.** Phase 1.5 in [`docs/ROADMAP.md`](../docs/ROADMAP.md).
