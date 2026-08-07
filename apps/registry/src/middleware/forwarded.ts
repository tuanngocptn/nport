import { ApiError, readForwarded } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"

import type { Env, Variables } from "../types"

/**
 * Reads what the gateway worked out, instead of working it out again (ADR-0049).
 *
 * The twin of `apps/node/src/middleware/forwarded.ts`, and the same three middlewares are gone from
 * here: `requestId`, `clientGate` and `rateLimit`. All three were cross-cutting, all three existed in
 * near-identical form in both Workers, and none could move to `packages/worker-kit`, whose boundary
 * forbids reading a binding. A gateway in front of both holds them once.
 *
 * The header *names* do come from `worker-kit`, because they are the one part with no binding in it and
 * the one part where a misspelling is silent.
 */
export const forwarded: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  /**
   * The two paths that read no binding and need no identity, exempted for the same reason
   * `requireBindings` exempts them: an uptime monitor sends no NPort headers, and a person who typed
   * the API host into a browser is not a caller at all.
   */
  if (
    context.req.path === "/v1/health" ||
    (context.req.path === "/" && context.req.method === "GET")
  ) {
    await next()
    return
  }

  const { sourceHash, requestId } = readForwarded(context.req.raw.headers)

  /**
   * **Fail closed.** No source hash means the request did not come through a gateway — which should be
   * impossible, since this Worker declares no `routes` and no `workers_dev` hostname. Serving it anyway
   * would mean serving it with no per-source identity, so every caller reaching this Worker directly
   * would share one, and the rate limit that protects `GET /v1/nodes` from being polled flat would
   * apply to all of them together.
   *
   * Synthesising a hash here is the tempting alternative and the worse one: it would work, quietly.
   */
  if (sourceHash === undefined) {
    console.error("request reached the registry without a gateway", { path: context.req.path })
    throw new ApiError("INTERNAL")
  }

  context.set("sourceHash", sourceHash)
  // Usually Cloudflare's own `cf-ray`, which the gateway prefers so a quoted id matches their logs.
  // A local fallback keeps the envelope's field non-empty if only this header goes missing.
  context.set("requestId", requestId ?? crypto.randomUUID())

  await next()
}
