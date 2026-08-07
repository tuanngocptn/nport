# schema/

Language-neutral generated artifacts, all **generated** and all **committed**.

Four describe the contract: they come from `packages/contract` and feed `cargo xtask codegen`, which emits `crates/contract/src/generated.rs` with a purpose-built emitter — not `typify` ([ADR-0025](../docs/DECISIONS.md)). **`cli.json` runs the other way** — Rust to JSON, not JSON to Rust — and is the one file here that is not about the API.

| File | Holds | Exists because |
| --- | --- | --- |
| `nport-node.openapi.json` | the OpenAPI description of a **node's** API | the request and response shapes, also rendered on the website |
| `nport-registry.openapi.json` | the OpenAPI description of the **registry's** API | a separate service, **now behind the same hostname** ([ADR-0049](../docs/DECISIONS.md)). Both documents carry the same `servers` entry, so the split no longer rests on the host — it rests on the two path spaces being disjoint and each document's components being reachable from its own routes. A client generated from a merged document would call `/v1/nodes` on a node-only deployment, where nothing answers it |
| `errors.json` | each code's status, retryability, slug and `details` keys | **JSON Schema cannot express them.** The document can say `code` is one of 33 strings; it cannot say `SUBDOMAIN_IN_USE` is a 409 not worth retrying, which is exactly what the Rust client branches on |
| `subdomain.json` | the length bounds, the zone suffix, and the reserved lists | the Rust mirror needs the same 53 reserved names, and a second copy kept by hand is a list that is correct until somebody forgets |
| `cli.json` | every flag and positional `nport` accepts, with its help text | the flag reference on the website has to be the flags the binary parses. Generated from `Args::command()` in `crates/cli`, so it cannot disagree with `--help` — three `CLAUDE.md` files claimed it existed for weeks before it did (defect 38) |

They are committed on purpose: a diff on one of these files is the clearest possible signal that a contract change is about to affect the Rust client, so it belongs in code review rather than being regenerated invisibly in CI.

Do not hand-edit them. `pnpm codegen` regenerates the four contract documents and `cargo xtask codegen` regenerates `cli.json`; CI fails if either result differs from what is committed.

Phase 1.5 in [`docs/ROADMAP.md`](../docs/ROADMAP.md), closed and tagged `contract-v1`.
