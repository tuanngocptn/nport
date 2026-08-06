/**
 * Binding validation, for the reason `apps/api/src/env.ts` spells out at length: an unset
 * `POW_SECRET` reaches WebCrypto and fails there with `Imported HMAC key length (0) must be a
 * non-zero value`, which surfaces as a plain 500 on `GET /v1/challenge` while `/v1/health` answers
 * fine — about the least diagnosable shape a misconfiguration can take.
 *
 * The caller still gets `INTERNAL`. Whether our secrets are configured is not a client's business,
 * and naming the missing binding to an anonymous caller is free reconnaissance. The detail goes to
 * the log, where an operator is looking.
 */

import type { Env } from "./types"

const REQUIRED_SECRETS = ["POW_SECRET", "IP_HASH_SECRET"] as const

const REQUIRED_VARS = [
  "MIN_CLIENT_VERSION",
  "POW_DIFFICULTY_BITS",
  "NODE_LIST_REFRESH_MS",
  "PROBE_FAILURES_BEFORE_DOWN",
  "PROBE_FAILURES_BEFORE_DELIST",
  "MAX_NODES",
] as const

const REQUIRED_BINDINGS = ["DIRECTORY", "RATE_LIMITER"] as const

/** Names of bindings that are missing or empty. Empty array means the Worker is configured. */
export function missingBindings(env: Partial<Env>): string[] {
  const missing: string[] = []

  for (const name of REQUIRED_SECRETS) {
    const value = env[name]
    // An empty string counts as missing: a secret rotated to empty is indistinguishable from unset
    // in practice, and it is the failure mode that produced the WebCrypto error above.
    if (typeof value !== "string" || value.length === 0) {
      missing.push(name)
    }
  }

  for (const name of REQUIRED_VARS) {
    const value = env[name]
    if (value === undefined || value === null || value === "") {
      missing.push(name)
      continue
    }
    // Numeric vars must actually parse. Workers vars arrive as strings or numbers depending on how
    // they were declared, and `Number("")` is 0 — which would silently mean "delist after zero
    // failed probes", emptying the directory on the first cron run.
    if (name !== "MIN_CLIENT_VERSION" && !Number.isFinite(Number(value))) {
      missing.push(name)
    }
  }

  for (const name of REQUIRED_BINDINGS) {
    if (env[name] === undefined || env[name] === null) {
      missing.push(name)
    }
  }

  return missing
}
