/**
 * `@nport/worker-kit` — the plumbing every NPort Worker shares.
 *
 * Three Workers exist: `apps/gateway` (the front door), `apps/node` (a node) and `apps/registry` (the
 * directory). All three refuse requests the same way, two gate writes with the same proof of work,
 * and one derives a source identity the other two read — and **none may have its own copy of any of
 * it** (ADR-0047). A second error envelope is how one service starts answering in a shape clients do
 * not expect. A second proof-of-work implementation is how one ends up verifying something subtly
 * different from what the other issues. A second source-identity function is how `docs/ROADMAP.md`'s
 * defect 9 comes back: keying on a full IPv6 address rather than its /64 silently removes every
 * per-source control, because a client owns at least 2^64 addresses and can pick a fresh one per
 * request. And a second spelling of a forwarded header name is how every caller in the world ends up
 * sharing one identity — see `forwarded.ts`.
 *
 * **No bindings, no `env`, no Hono.** Everything here is pure enough to test under plain vitest,
 * which is why it can be a package rather than a Worker. Anything needing a binding stays in the app
 * that owns the binding.
 */

export * from "./errors"
export * from "./forwarded"
export * from "./ip-hash"
export * from "./pow"
export * from "./version"
