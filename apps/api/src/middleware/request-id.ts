import type { MiddlewareHandler } from "hono"

import type { Env, Variables } from "../types"

/**
 * Attaches a request ID, preferring Cloudflare's own `cf-ray`.
 *
 * Reusing `cf-ray` means the ID a user quotes in an issue is the same one that appears in
 * Cloudflare's logs, which is the difference between a five-minute lookup and a fishing trip.
 */
export const requestId: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  const ray = context.req.header("cf-ray")
  context.set("requestId", ray ?? crypto.randomUUID())
  await next()
}
