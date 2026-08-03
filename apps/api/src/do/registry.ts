import { DurableObject } from "cloudflare:workers"

import type { Env } from "../types"

/**
 * The singleton: global lease index, reconciliation cursor, and counters.
 *
 * The cursor is what makes cleanup bounded per run but unbounded over time — v2's cron handled ~10
 * tunnels per invocation with no ordering, so the oldest could starve indefinitely (defect R8).
 *
 * **Not implemented.** Next slice of Phase 2a, with the reconciliation sweep. Declared now for the
 * same reason as `SubdomainLease`.
 */
export class Registry extends DurableObject<Env> {}
