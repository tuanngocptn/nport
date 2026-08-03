## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] lint, typecheck, and tests pass in both languages
- [ ] `pnpm codegen && cargo xtask codegen` leave the tree clean
- [ ] tests added for new behaviour (`docs/TESTING.md` lists what must be covered)
- [ ] docs updated if this touches anything a doc's `applies_to:` globs cover
- [ ] an ADR added to `docs/DECISIONS.md` for any architecture or dependency decision
- [ ] no `@generated` file hand-edited
- [ ] no secret, token, or raw IP in code, tests, or logs
- [ ] commit subjects follow `type(scope): description`

## If this touches `crates/protocol`

<!-- Delete this section if it does not. -->

- [ ] every new constant cites `file:symbol` in the pinned cloudflared commit
- [ ] golden fixture captured from **cloudflared**, not from our own encoder
- [ ] `insta` snapshots reviewed one by one, not accepted in bulk
- [ ] `docs/PROTOCOL.md` updated in this same PR
- [ ] `src/h2.rs` still compiles (ADR-0017)
