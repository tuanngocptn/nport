import { ApiError } from "@nport/worker-kit"

import type { Env } from "./types"

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

/** True when this deployment carries the directory — a master rather than a plain node. */
export function servesRegistry(env: Env): boolean {
  return env.REGISTRY !== undefined
}

export function assertConfigured(env: Env): void {
  const missing = missingBindings(env)
  if (missing.length > 0) {
    console.error("gateway is misconfigured", { missing })
    throw new ApiError("INTERNAL")
  }
}
