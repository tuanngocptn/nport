import { DurableObject } from "cloudflare:workers"

import type { Env } from "../types"

/**
 * One Durable Object per **normalized** subdomain: atomic claim, saga journal, expiry alarm.
 *
 * `idFromName(subdomain)` gives a single-threaded writer per name by construction, which is what
 * makes a concurrent double-claim impossible rather than merely unlikely (defect R4). The subdomain
 * **must** be normalized before deriving the ID — normalizing afterwards yields two objects for one
 * logical name and the atomicity guarantee evaporates (`apps/api/CLAUDE.md` § Gotchas).
 *
 * **Not implemented.** Next slice of Phase 2a: the journaled provisioning saga
 * (`docs/ARCHITECTURE.md` §3a) and the alarm-driven teardown. Declared now because
 * `wrangler.jsonc` binds it and its migration tag `v1` is already committed — a binding whose
 * class does not exist is a deploy-time failure.
 */
export class SubdomainLease extends DurableObject<Env> {}
