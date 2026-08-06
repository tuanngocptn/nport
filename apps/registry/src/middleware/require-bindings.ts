import { ApiError } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"

import { missingBindings } from "../env"
import type { Env, Variables } from "../types"

/**
 * Rejects a request the Worker is not configured to serve.
 *
 * Runs before anything reads a secret, so a misconfiguration is one clear log line rather than an
 * opaque failure inside whichever primitive happened to need the value first.
 */
export const requireBindings: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  const missing = missingBindings(context.env)
  if (missing.length > 0) {
    // The only place the binding names appear. Never in the response — telling an anonymous caller
    // which secret is unset is free reconnaissance.
    console.error("misconfigured worker", {
      requestId: context.get("requestId"),
      missing,
      hint: "wrangler secret put <NAME>, or apps/registry/.dev.vars for local development",
    })
    throw new ApiError("INTERNAL")
  }
  await next()
}
