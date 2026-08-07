import { ApiError } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"

import type { Env, Variables } from "./types"

/**
 * What this Worker needs before it serves anything.
 *
 * Deliberately short. `apps/node` requires six secrets and eight vars because it talks to Cloudflare;
 * the gateway talks to nobody but its own bindings, so the list is the shared abuse controls and the
 * services it dispatches to. Checking it up front turns a misconfiguration into one clear line rather
 * than a failure inside whichever primitive reached for the value first.
 */
const REQUIRED_SECRETS = ["IP_HASH_SECRET"] as const
const REQUIRED_VARS = ["MIN_CLIENT_VERSION"] as const

/**
 * `REGISTRY` is **not** required. Its absence is how a node-only deployment is expressed (ADR-0049),
 * so demanding it would make every node operator run a directory they do not want.
 */
const REQUIRED_BINDINGS = ["RATE_LIMITER", "NODE"] as const

export function missingBindings(env: Env): string[] {
  const missing: string[] = []
  for (const name of [...REQUIRED_SECRETS, ...REQUIRED_VARS]) {
    const value = env[name as keyof Env]
    if (typeof value !== "string" || value.length === 0) missing.push(name)
  }
  for (const name of REQUIRED_BINDINGS) {
    if (env[name as keyof Env] === undefined) missing.push(name)
  }
  return missing
}

/**
 * Refuses to serve anything if the Worker is misconfigured.
 *
 * **Hono middleware, not a check in the `fetch` export**, and that is the whole point: a throw outside
 * the app never reaches `onError`, so `workerd` would answer with a bare 500 and no body. Every failure
 * in this repository carries a registry code (`docs/ERRORS.md`) — an operator who misconfigures a
 * binding should get `INTERNAL` in an envelope with a request id they can quote, not an empty 500 that
 * looks like a crash.
 *
 * `/v1/health` is excluded for `apps/node`'s reason: an uptime monitor should be able to tell a
 * running-but-misconfigured Worker from a dead one.
 */
export const requireBindings: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  if (context.req.path === "/v1/health") {
    await next()
    return
  }

  const missing = missingBindings(context.env)
  if (missing.length > 0) {
    // The names go to the log, never to the response — which binding is absent is infrastructure
    // detail, and rule 8 keeps upstream and deployment internals out of anonymous replies.
    console.error("gateway is misconfigured", { missing })
    throw new ApiError("INTERNAL")
  }

  await next()
}
