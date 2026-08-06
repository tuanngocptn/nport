/**
 * Bindings and per-request context.
 *
 * `Env` mirrors `wrangler.jsonc`, hand-written for the same reason `apps/api`'s is: `wrangler types`
 * would be a second `@generated` artifact to drift-gate for a handful of values, and a mismatch
 * surfaces immediately as a typecheck failure against the config in review.
 *
 * **Note what is absent.** No `CF_API_TOKEN`, no `CF_ACCOUNT_ID`, no `CF_ZONE_ID`, no `CF_DOMAIN`.
 * The registry provisions nothing and touches no zone (ADR-0031), so it holds no credential that
 * could create or delete anything. That is the security property the split buys, and this interface
 * is where it is visible.
 */

/** Secrets. Set with `wrangler secret bulk` from Terraform; never in `wrangler.jsonc`. */
interface Secrets {
  /**
   * Signs proof-of-work challenges for `POST /v1/nodes`.
   *
   * **Not the same value as `apps/api`'s**, and it must not be: a challenge issued by a node would
   * otherwise be redeemable at the registry and vice versa. Sharing the algorithm is not sharing the
   * trust boundary (ADR-0047).
   */
  POW_SECRET: string
  /** Keys the source-identity HMAC. Raw IPs are never stored or logged. */
  IP_HASH_SECRET: string
}

/** Plain values from `wrangler.jsonc` § vars. */
interface Vars {
  MIN_CLIENT_VERSION: string
  POW_DIFFICULTY_BITS: number
  /** Published by `GET /v1/nodes` so a client discovers its cache lifetime rather than picking one. */
  NODE_LIST_REFRESH_MS: number
  PROBE_FAILURES_BEFORE_DOWN: number
  PROBE_FAILURES_BEFORE_DELIST: number
  MAX_NODES: number
}

export interface Env extends Secrets, Vars {
  // Parameterized so the stub exposes the class's methods; without it every call would be typed
  // `unknown` and a renamed method would fail at runtime rather than at `tsc`. The inline type-only
  // import is erased, so the cycle with `do/directory.ts` never exists at runtime.
  DIRECTORY: DurableObjectNamespace<import("./do/directory").Directory>
  /** Cloudflare's per-key request-rate limiter, declared in `wrangler.jsonc` § ratelimits. */
  RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

export interface Variables {
  /** Echoed in every error envelope so a user can quote one thing in a bug report. */
  requestId: string
  /** `HMAC(ip, IP_HASH_SECRET)` over the address prefix and ASN, set by the rate-limit middleware. */
  sourceHash: string
}
