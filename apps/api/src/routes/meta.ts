import { Hono } from "hono"

import type { Env, Variables } from "../types"

/**
 * `GET /v1/meta` — limits, discovered rather than hardcoded.
 *
 * The point is that caps can be tuned in production without shipping a client. v2 hardcoded its
 * four-hour limit in the CLI as a `setTimeout`, which is why it was both wrong and bypassable
 * (defect R6).
 */
export const metaRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get("/", (context) =>
  context.json({
    minClientVersion: String(context.env.MIN_CLIENT_VERSION),
    tunnelDurationMs: Number(context.env.LEASE_TTL_SECONDS) * 1000,
    // Half the grace period: two heartbeats must fit inside it, or a single dropped request
    // ends a healthy tunnel.
    heartbeatIntervalMs: (Number(context.env.HEARTBEAT_GRACE_SECONDS) * 1000) / 4,
    // The floor, not what any particular caller will be issued: difficulty rises per source with
    // recent creates (ADR-0028), and a challenge carries its own difficulty. Advertising the floor is
    // what a client needs in order to size its solver, not a promise about the next challenge.
    powDifficulty: Number(context.env.POW_DIFFICULTY_BITS),
    maxConcurrentPerSource: Number(context.env.MAX_CONCURRENT_PER_SOURCE),
    maxCreatesPerHourPerSource: Number(context.env.MAX_CREATES_PER_HOUR_PER_SOURCE),
  }),
)
