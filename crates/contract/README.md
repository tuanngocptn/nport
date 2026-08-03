# nport-contract

**Generated.** Rust mirror of the control-plane API contract — request and response types, and the error-code enum.

Do not hand-edit anything in this crate. The authority is `packages/contract` (zod), which generates `schema/nport-api.openapi.json`, which generates the Rust here via `typify`. CI fails on drift.

To change a type: edit `packages/contract`, then run `pnpm codegen && cargo xtask codegen`.

**Not implemented.** Phase 1.5 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md). Rationale in [ADR-0009](../../docs/DECISIONS.md).
