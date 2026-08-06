# schema/

Language-neutral generated contract artifacts. All four are **generated** from `packages/contract` and **committed**, and all four feed `cargo xtask codegen`, which emits `crates/contract/src/generated.rs` with a purpose-built emitter — not `typify` ([ADR-0025](../docs/DECISIONS.md)).

| File | Holds | Exists because |
| --- | --- | --- |
| `nport-api.openapi.json` | the OpenAPI description of a **node's** API | the request and response shapes, also rendered on the website |
| `nport-registry.openapi.json` | the OpenAPI description of the **registry's** API | a separate service on a separate host. One `servers` entry cannot describe both, and a client generated from a merged document would call `api.nport.link/v1/nodes` ([ADR-0046](../docs/DECISIONS.md)) |
| `errors.json` | each code's status, retryability, slug and `details` keys | **JSON Schema cannot express them.** The document can say `code` is one of 33 strings; it cannot say `SUBDOMAIN_IN_USE` is a 409 not worth retrying, which is exactly what the Rust client branches on |
| `subdomain.json` | the length bounds, the zone suffix, and the reserved lists | the Rust mirror needs the same 53 reserved names, and a second copy kept by hand is a list that is correct until somebody forgets |

They are committed on purpose: a diff on one of these files is the clearest possible signal that a contract change is about to affect the Rust client, so it belongs in code review rather than being regenerated invisibly in CI.

Do not hand-edit them. `pnpm codegen` regenerates all four; CI fails if the result differs from what is committed.

Phase 1.5 in [`docs/ROADMAP.md`](../docs/ROADMAP.md), closed and tagged `contract-v1`.
