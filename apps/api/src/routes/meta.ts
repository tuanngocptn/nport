import { Hono } from "hono"

import type { Env, Variables } from "../types"

/**
 * `GET /v1/meta` — limits, discovered rather than hardcoded.
 *
 * The point is that caps can be tuned in production without shipping a client. v2 hardcoded its
 * four-hour limit in the CLI as a `setTimeout`, which is why it was both wrong and bypassable
 * (defect R6).
 *
 * **This endpoint is now also how the registry sees this node.** `apps/registry` probes it on a
 * five-minute cron and stores `activeTunnels` against `maxActiveTunnels` as the node's observed
 * capacity, which is what a client selects on (ADR-0046). Capacity is read here and claimed nowhere:
 * a node that could assert its own emptiness in a registration would be picked first by everyone.
 */
export const metaRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get(
  "/",
  async (context) => {
    const env = context.env

    // One Durable Object hop, and the only one on this route. It counts against the subrequest
    // budget (rule 13), which is worth stating because this endpoint is polled: by every client at
    // startup and by the registry every five minutes. One hop for the number that makes federated
    // selection possible is the trade, and `activeCount` is a single indexed count.
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))
    const activeTunnels = await registry.activeCount()

    return context.json({
      minClientVersion: String(env.MIN_CLIENT_VERSION),
      tunnelDurationMs: Number(env.LEASE_TTL_SECONDS) * 1000,
      // Half the grace period: two heartbeats must fit inside it, or a single dropped request
      // ends a healthy tunnel.
      heartbeatIntervalMs: (Number(env.HEARTBEAT_GRACE_SECONDS) * 1000) / 4,
      // The floor, not what any particular caller will be issued: difficulty rises per source with
      // recent creates (ADR-0028), and a challenge carries its own difficulty. Advertising the floor is
      // what a client needs in order to size its solver, not a promise about the next challenge.
      powDifficulty: Number(env.POW_DIFFICULTY_BITS),
      maxConcurrentPerSource: Number(env.MAX_CONCURRENT_PER_SOURCE),
      maxCreatesPerHourPerSource: Number(env.MAX_CREATES_PER_HOUR_PER_SOURCE),
      activeTunnels,
      maxActiveTunnels: Number(env.MAX_ACTIVE_TUNNELS),
    })
  },
)
