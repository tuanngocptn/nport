# nport-contract

Rust mirror of the control-plane API contract — request and response types, the error-code enum, and subdomain normalization.

The authority is `packages/contract` (zod). It generates `schema/nport-node.openapi.json`, `schema/errors.json` and `schema/subdomain.json`, and `cargo xtask codegen` turns those three into `src/generated.rs` with a purpose-built emitter — **not `typify`**, and [ADR-0025](../../docs/DECISIONS.md) says why. CI fails on drift.

To change a type, a code, or a reserved name: edit `packages/contract`, then run `pnpm codegen && cargo xtask codegen`.

## What is generated and what is not

`src/generated.rs` is generated and off-limits to hand edits — it carries a `@generated` banner (invariant 6). The other two files are hand-written, because neither thing in them is expressible in JSON Schema:

| File | Why it is hand-written |
| --- | --- |
| `src/lib.rs` | the error envelope, which needs a typed `ErrorCode` where JSON Schema can only say "string" |
| `src/subdomain.rs` | NFKC folding, the zone-suffix strip, and label validation — rules, not shapes |

`src/subdomain.rs` uses **generated constants and hand-written logic**, and the split is the point: the 53 reserved names come through `schema/subdomain.json` so they exist once, while the rules are reimplemented and pinned against `packages/contract/fixtures/subdomains.json`, which both this crate's tests and the TypeScript suite read. Add a case there first, then make both sides pass.

Its purpose is early refusal: `nport -s my_app` fails in a millisecond instead of spending a proof-of-work solve and a round trip. **The server stays authoritative** (invariant 3) — this never decides anything, it only declines to ask.

Phase 1.5 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md), closed and tagged `contract-v1`.
