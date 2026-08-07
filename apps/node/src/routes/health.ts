import { Hono } from "hono"

import type { Env, Variables } from "../types"

/**
 * `GET /v1/health` — liveness for monitoring.
 *
 * Deliberately shallow: it says this isolate is running, and nothing about Cloudflare's API or the
 * edge. A health check that calls downstream services turns their outage into ours and pages the
 * wrong person.
 */
export const healthRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get("/", (context) =>
  context.json({ status: "ok" }, 200, { "cache-control": "no-store" }),
)
