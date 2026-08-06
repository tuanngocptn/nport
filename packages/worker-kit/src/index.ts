/**
 * `@nport/worker-kit` — the plumbing every NPort Worker shares.
 *
 * Two Workers exist: `apps/api` (a node) and `apps/registry` (the directory). Both refuse requests
 * the same way and both gate writes with the same proof of work, and **neither may have its own copy
 * of either** — ADR-0047. A second error envelope is how one service starts answering in a shape
 * clients do not expect; a second proof-of-work implementation is how one of them ends up verifying
 * something subtly different from what the other issues.
 *
 * **No bindings, no `env`, no Hono.** Everything here is pure enough to test under plain vitest,
 * which is why it can be a package rather than a Worker. Anything needing a binding stays in the app
 * that owns the binding.
 */

export * from "./errors"
export * from "./pow"
