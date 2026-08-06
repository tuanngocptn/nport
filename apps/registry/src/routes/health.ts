import { Hono } from "hono"

import type { Env, Variables } from "../types"

/**
 * `GET /v1/health` — liveness for monitoring.
 *
 * Deliberately shallow: it says this isolate is running, and nothing about whether the nodes it lists
 * are up. A health check that probes downstream turns someone else's outage into ours and pages the
 * wrong person — and here it would be especially wrong, since a directory full of `down` nodes is the
 * registry working correctly.
 */
export const healthRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get("/", (context) =>
  context.json({ status: "ok" }, 200, { "cache-control": "no-store" }),
)
