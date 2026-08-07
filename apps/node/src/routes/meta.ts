import { Hono } from "hono"

import { registerWithRegistry } from "../register"
import type { Env, Variables } from "../types"

/**
 * How stale a registration may get before request traffic refreshes it.
 *
 * Below the node's own five-minute cron, so a busy node re-registers on whichever of the two comes
 * first, and well below the registry's `NODE_DOWN_AFTER_SECONDS` (600 on staging) so a single missed
 * cron cannot take a node that is serving traffic out of the directory.
 *
 * Not a var: it is a property of the interaction between two schedules rather than a knob, and getting
 * it wrong in either direction is silent — too high and a busy node still ages out, too low and every
 * poll pays for a proof-of-work solve.
 */
const HEARTBEAT_AFTER_MS = 240_000

/**
 * `GET /v1/meta` — limits, discovered rather than hardcoded.
 *
 * The point is that caps can be tuned in production without shipping a client. v2 hardcoded its
 * four-hour limit in the CLI as a `setTimeout`, which is why it was both wrong and bypassable
 * (defect R6).
 *
 * **The registry no longer reads this endpoint** (ADR-0049 reversed ADR-0046): the node reports its own
 * capacity when it registers, and nothing probes. `activeTunnels` is still published here because it is
 * what a *client* selects on.
 *
 * **It is also where a busy node keeps itself listed.** The same Durable Object hop that produces the
 * count claims a registration heartbeat when one is due, and the registration runs in `waitUntil` so no
 * caller waits for a proof-of-work solve. See `Registry.snapshot` for why traffic is a better liveness
 * signal than a cron tick.
 */
export const metaRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get(
  "/",
  async (context) => {
    const env = context.env

    // **Still one Durable Object hop**, and the only one on this route. It counts against the
    // subrequest budget (rule 13), which is worth stating because this endpoint is polled by every
    // client at startup. `snapshot` returns the count *and* claims a heartbeat in that one call
    // rather than adding a second hop to the most-polled route on the node.
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))
    const { activeTunnels, shouldRegister } = await registry.snapshot(
      HEARTBEAT_AFTER_MS,
      Date.now(),
    )

    if (shouldRegister) {
      // **After the response, never before it.** Registration costs a proof-of-work solve — about
      // 1.2 s of CPU at the registry's 20-bit floor — and no client polling `/v1/meta` at startup
      // should wait for it. `waitUntil` keeps the isolate alive for the work without holding the
      // request, and `registerWithRegistry` swallows its own failures, so nothing here can turn a
      // registry outage into a failed `/v1/meta`.
      context.executionCtx.waitUntil(registerWithRegistry(env))
    }

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
