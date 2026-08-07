/**
 * The two headers the gateway sets and the internal services read (ADR-0049).
 *
 * **The names live here because they are a contract between Workers, and a misspelling on one side is
 * silent.** A node that read `x-nport-source-hash` while the gateway wrote `x-nport-sourcehash` would
 * fail closed on every request — recoverable, if noisy. The other direction is worse: a service that
 * looked for a header nobody sets and defaulted instead of refusing would give every caller in the
 * world one shared identity and no per-source cap would apply to anyone. Two string literals in three
 * files is how that happens, so there is one file.
 *
 * Deliberately **not** in `packages/contract`. That package is the *public* API — what a client may
 * send and what it gets back (invariant 7) — and these headers are neither. A client cannot set them
 * (the gateway overwrites both) and never sees them. Putting them in the contract would publish an
 * internal detail in two OpenAPI documents and invite someone to send one.
 *
 * No Hono here, so `@nport/worker-kit` stays framework-free (ADR-0047). Each Worker wraps
 * `readForwarded` in three lines of middleware, which is also where the decision about what to do with
 * a missing header belongs: the gateway synthesises, the services refuse.
 */

/** Cloudflare's `cf-ray` where there is one, so an id a user quotes matches Cloudflare's own logs. */
export const FORWARDED_REQUEST_ID = "x-nport-request-id"

/** `HMAC(ip, IP_HASH_SECRET)` over the address prefix and ASN. Never an address. */
export const FORWARDED_SOURCE_HASH = "x-nport-source-hash"

/** What the gateway worked out about a caller, as it crosses a service binding. */
export interface Forwarded {
  /** Absent when no gateway set one, which an internal service must treat as a misconfiguration. */
  readonly sourceHash?: string
  /** Absent for the same reason, but survivable: an id is only ever logged. */
  readonly requestId?: string
}

/**
 * Reads both headers off a request, treating empty as absent.
 *
 * Empty matters: `context.req.header(name)` returns `""` for a header present with no value, and `""`
 * is a perfectly usable Durable Object name — so a caller who sent `x-nport-source-hash:` with nothing
 * after it would get a `SourceQuota` object shared with everyone else who did the same. Absent and
 * empty are the same thing here, and the difference between them is not worth a caller's discovery.
 */
export function readForwarded(headers: Headers): Forwarded {
  const sourceHash = headers.get(FORWARDED_SOURCE_HASH)
  const requestId = headers.get(FORWARDED_REQUEST_ID)
  return {
    ...(sourceHash ? { sourceHash } : {}),
    ...(requestId ? { requestId } : {}),
  }
}
