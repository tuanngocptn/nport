/**
 * `@nport/worker-kit` — the plumbing every NPort Worker shares.
 *
 * Two Workers exist: `apps/api` (a node) and `apps/registry` (the directory). Both refuse requests
 * the same way, both gate writes with the same proof of work, and both identify a source the same
 * way — and **neither may have its own copy of any of the three** (ADR-0047). A second error envelope
 * is how one service starts answering in a shape clients do not expect. A second proof-of-work
 * implementation is how one ends up verifying something subtly different from what the other issues.
 * And a second source-identity function is how `docs/ROADMAP.md`'s defect 9 comes back: keying on a
 * full IPv6 address rather than its /64 silently removes every per-source control, because a client
 * owns at least 2^64 addresses and can pick a fresh one per request.
 *
 * **No bindings, no `env`, no Hono.** Everything here is pure enough to test under plain vitest,
 * which is why it can be a package rather than a Worker. Anything needing a binding stays in the app
 * that owns the binding.
 */

export * from "./errors"
export * from "./ip-hash"
export * from "./pow"
export * from "./version"
