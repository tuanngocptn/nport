/**
 * Binding validation.
 *
 * **Why this exists.** `POW_SECRET` is set with `wrangler secret put`, so it is absent under
 * `wrangler dev` unless a `.dev.vars` file supplies it. Without a check, an empty secret reaches
 * WebCrypto and fails there:
 *
 * ```text
 * DataError: Imported HMAC key length (0) must be a non-zero value...
 * ```
 *
 * That surfaced as a plain 500 on `GET /v1/challenge` while `/v1/health` answered fine, which is
 * about the least diagnosable shape a misconfiguration can take. The same thing would happen in
 * **production** if a secret were never set or was rotated to empty — so this is not only a
 * developer-experience fix.
 *
 * The caller still gets `INTERNAL`: whether our secrets are configured is not a client's business,
 * and telling an anonymous caller which binding is missing is free reconnaissance. The detail goes
 * to the log, which is where an operator is looking (`apps/api/CLAUDE.md` rule 8).
 */

import type { Env } from "./types"

/**
 * Bindings without which the Worker cannot serve a request correctly.
 *
 * The Cloudflare credentials are required for *every* gated route, not only the ones that provision.
 * A deployment missing them is broken, and finding that out on the first `POST /v1/tunnels` — after
 * `/v1/meta` and `/v1/challenge` answered happily — is how a misconfiguration reaches production.
 */
const REQUIRED_SECRETS = [
  "POW_SECRET",
  "IP_HASH_SECRET",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
  "CF_ZONE_ID",
  "CF_DOMAIN",
] as const
const REQUIRED_VARS = [
  "LEASE_TTL_SECONDS",
  "HEARTBEAT_GRACE_SECONDS",
  "MAX_ACTIVE_TUNNELS",
  "MIN_CLIENT_VERSION",
  "POW_DIFFICULTY_BITS",
  "POW_MAX_DIFFICULTY_BITS",
  "MAX_CONCURRENT_PER_SOURCE",
  "MAX_CREATES_PER_HOUR_PER_SOURCE",
] as const

/**
 * Bindings that are objects rather than strings: the Durable Object namespaces and the rate limiter.
 *
 * Checked by presence, not by shape. A missing one is a `wrangler.jsonc` that does not match the code
 * — the same class of misconfiguration as an unset secret, and just as opaque without this: the first
 * symptom would be `Cannot read properties of undefined` from whichever line touched it first.
 */
const REQUIRED_BINDINGS = ["SUBDOMAIN_LEASE", "REGISTRY", "SOURCE_QUOTA", "RATE_LIMITER"] as const

/** Names of bindings that are missing or empty. Empty array means the Worker is configured. */
export function missingBindings(env: Partial<Env>): string[] {
  const missing: string[] = []

  for (const name of REQUIRED_SECRETS) {
    const value = env[name]
    // An empty string counts as missing. A rotated-to-empty secret is the failure mode that
    // produced the WebCrypto error above, and it is indistinguishable from unset in practice.
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
    // they were declared, and `Number("")` is 0 — which would silently mean a zero-second lease.
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

/**
 * This node's zone suffix, for normalization.
 *
 * **`CF_DOMAIN` and not the contract's default.** Every node has its own domain (ADR-0031), and a node
 * builds tunnel URLs from `CF_DOMAIN` already — so normalizing against a hardcoded `.nport.link` meant
 * a node on any other domain **handed out a URL it then refused to accept back**. Pasting your own
 * tunnel's hostname into `-s` is the exact case the suffix strip exists for, and it worked on exactly
 * one deployment.
 *
 * One function rather than `.${env.CF_DOMAIN}` at each of the five call sites, because a missing dot
 * is a silent bug: `nport.link` without it would strip `myappnport.link` and nothing else.
 */
export function zoneSuffix(env: Pick<Env, "CF_DOMAIN">): string {
  return `.${env.CF_DOMAIN}`
}
