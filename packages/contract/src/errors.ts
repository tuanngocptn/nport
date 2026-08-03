/**
 * The error registry — **the authority**.
 *
 * `docs/ERRORS.md` is generated from this file. So is the website's `/errors/[code]` page and
 * the Rust mirror in `crates/contract`. Never hand-edit those; edit here and run `pnpm codegen`.
 *
 * Why a registry at all, rather than errors thrown where they happen: four consumers need to
 * agree on the same set — the Hono error handler (to pick a status), the Rust CLI (to pick a
 * translated message and a hint), the website, and the GitHub issue templates. v2 had none of
 * this. It returned HTTP 500 for everything and the CLI matched substrings like
 * `'currently in use'` and `'[1013]'`, which is ADR-0018's central mistake.
 *
 * **Clients branch on `code`. Messages are free to change and are translated per locale.**
 */

/** Where an error originates, which decides whether it has an HTTP status at all. */
export type ErrorOrigin = "server" | "client"

export interface ErrorDefinition {
  /**
   * `server` errors cross the network and carry an HTTP status. `client` errors are raised
   * locally by `crates/cli` and `crates/core` and never do — they share the registry so that
   * every failure a user can see has a stable code, a translation key, and a docs anchor.
   */
  readonly origin: ErrorOrigin
  /** HTTP status. Always present for `server`, always `null` for `client`. */
  readonly status: number | null
  /**
   * Whether retrying the *same* request can succeed.
   *
   * Not a hint — the CLI uses it to decide whether to retry at all, so a wrong value here
   * either hammers a permanent failure or gives up on a transient one.
   */
  readonly retryable: boolean
  /** Default English message. Translated in `crates/cli`; never assembled from fragments. */
  readonly message: string
  /** One line on what went wrong, for the generated docs. */
  readonly cause: string
  /** What the user should actually do about it. */
  readonly action: string
  /** Keys this code may set in `error.details`. Documented so clients can rely on them. */
  readonly details?: readonly string[]
}

/**
 * Every error NPort can return or raise.
 *
 * Adding one is cheap; adding one whose only difference from an existing code is wording is a
 * mistake. A code is a contract clients branch on — a message is not.
 */
export const ERRORS = {
  // ── 400 · the request itself is wrong ────────────────────────────────────────────
  INVALID_REQUEST: {
    origin: "server",
    status: 400,
    retryable: false,
    message: "The request body is not valid.",
    cause: "Body is not valid JSON, or fails schema validation",
    action: "Upgrade the client; this is a bug if it happens from an official build",
  },
  INVALID_SUBDOMAIN: {
    origin: "server",
    status: 400,
    retryable: false,
    message: "That subdomain is not allowed.",
    cause: "Fails normalization or validation (`docs/ARCHITECTURE.md` §7)",
    action: "Choose a name of 3–63 characters using `a-z`, `0-9`, and `-`",
    details: ["reason"],
  },
  POW_INVALID: {
    origin: "server",
    status: 400,
    retryable: false,
    message: "The proof-of-work solution is not valid.",
    cause: "Nonce does not satisfy the challenge, or the challenge HMAC does not verify",
    action: "Re-fetch a challenge and re-solve; a client bug if repeated",
  },
  CHALLENGE_EXPIRED: {
    origin: "server",
    status: 400,
    retryable: true,
    message: "The proof-of-work challenge has expired.",
    cause: "Challenge is past its validity window",
    action: "Fetch a new challenge",
  },

  // ── 403 · not permitted ──────────────────────────────────────────────────────────
  SUBDOMAIN_RESERVED: {
    origin: "server",
    status: 403,
    retryable: false,
    message: "That subdomain is reserved.",
    cause: "Name is on the reserved list",
    action: "Choose another name",
  },
  INVALID_OWNER_TOKEN: {
    origin: "server",
    status: 403,
    retryable: false,
    message: "That owner token does not match this tunnel.",
    cause: "Missing or non-matching `ownerToken`",
    action: "Only the creator can modify a lease. Wait for expiry",
  },

  // ── 404 / 409 / 410 · state ──────────────────────────────────────────────────────
  TUNNEL_NOT_FOUND: {
    origin: "server",
    status: 404,
    retryable: false,
    message: "No tunnel exists for that subdomain.",
    cause: "No lease for that subdomain",
    action: "Nothing to do; it may already have expired",
  },
  SUBDOMAIN_IN_USE: {
    origin: "server",
    status: 409,
    retryable: false,
    message: "That subdomain is currently in use.",
    cause: "Lease is `ACTIVE` and held by someone else",
    action: "Choose another name, or wait for `details.expiresAt`",
    details: ["expiresAt"],
  },
  DNS_CONFLICT: {
    origin: "server",
    status: 409,
    retryable: false,
    message: "A conflicting DNS record exists for that subdomain.",
    cause:
      "A DNS record exists that NPort cannot prove it owns — wrong type, or content not `<tunnel_id>.cfargotunnel.com`",
    action: "Choose another name. **Operator action required**; see `docs/OPERATIONS.md`",
  },
  LEASE_EXPIRED: {
    origin: "server",
    status: 410,
    retryable: false,
    message: "That tunnel's lease has expired.",
    cause: "The lease existed but has expired",
    action: "Create a new tunnel",
  },

  // ── 426 / 428 · the client is wrong ──────────────────────────────────────────────
  CLIENT_TOO_OLD: {
    origin: "server",
    status: 426,
    retryable: false,
    message: "This version of NPort is no longer supported.",
    cause: "Below `MIN_CLIENT_VERSION`",
    action: "Upgrade. `details.minimumVersion` says the floor",
    details: ["minimumVersion"],
  },
  POW_REQUIRED: {
    origin: "server",
    status: 428,
    retryable: false,
    message: "This request requires a proof-of-work challenge.",
    cause: "Create attempted with no challenge",
    action: "Client bug — fetch `/v1/challenge` first",
  },

  // ── 429 · too much ───────────────────────────────────────────────────────────────
  RATE_LIMITED: {
    origin: "server",
    status: 429,
    retryable: true,
    message: "Too many requests. Please slow down.",
    cause: "Per-source request limit exceeded",
    action: "Honour `Retry-After`",
    details: ["retryAfter"],
  },
  CONCURRENCY_LIMIT: {
    origin: "server",
    status: 429,
    retryable: true,
    message: "You already have the maximum number of open tunnels.",
    cause: "Too many simultaneous leases from this source",
    action: "Close an existing tunnel",
    details: ["limit"],
  },
  CREATE_QUOTA_EXCEEDED: {
    origin: "server",
    status: 429,
    retryable: true,
    message: "You have created too many tunnels this hour.",
    cause: "Hourly create cap for this source",
    action: "Wait; `details.resetAt`",
    details: ["resetAt"],
  },

  // ── 5xx · our problem ────────────────────────────────────────────────────────────
  PROVISION_FAILED: {
    origin: "server",
    status: 500,
    retryable: true,
    message: "The tunnel could not be created. Nothing was left behind.",
    cause: "The saga could not complete and was compensated. No orphan remains",
    action: "Retry. Quote `requestId`",
  },
  INTERNAL: {
    origin: "server",
    status: 500,
    retryable: true,
    message: "Something went wrong on our side.",
    cause: "Unhandled. Never leaks detail",
    action: "Report with `requestId`",
  },
  UPSTREAM_CLOUDFLARE_ERROR: {
    origin: "server",
    status: 502,
    retryable: true,
    message: "An upstream provider request failed.",
    cause: "The Cloudflare API failed or timed out. **Raw upstream text is never included**",
    action: "Retry with backoff. Quote `requestId` if persistent",
  },
  CAPACITY_EXHAUSTED: {
    origin: "server",
    status: 503,
    retryable: true,
    message: "NPort is at capacity. Please try again shortly.",
    cause: "Global active-tunnel cap reached",
    action: "Retry later",
  },

  // ── Client-side · never cross the network ────────────────────────────────────────
  LOCAL_PORT_CLOSED: {
    origin: "client",
    status: null,
    retryable: false,
    message: "Nothing is listening on that port.",
    cause: "Nothing is listening on the requested port",
    action: "Start the local server first. Checked **before** provisioning, so no tunnel is wasted",
    details: ["port"],
  },
  LOCAL_PORT_INVALID: {
    origin: "client",
    status: null,
    retryable: false,
    message: "That is not a valid port number.",
    cause: "Port is not in `1..=65535`",
    action: "Fix the argument",
  },
  CONFIG_UNREADABLE: {
    origin: "client",
    status: null,
    retryable: false,
    message: "Your configuration file could not be read.",
    cause: "`~/.nport/config.toml` exists but cannot be parsed",
    action: "Fix or delete it; the path is in `details`",
    details: ["path"],
  },
  CONFIG_UNWRITABLE: {
    origin: "client",
    status: null,
    retryable: false,
    message: "Your configuration file could not be written.",
    cause: "Cannot write the config directory",
    action: "Check permissions on `~/.nport`",
    details: ["path"],
  },
  EDGE_DISCOVERY_FAILED: {
    origin: "client",
    status: null,
    retryable: true,
    message: "Could not find a Cloudflare edge address.",
    cause: "No edge address resolved",
    action: "Check DNS and outbound UDP/TCP on 7844",
  },
  EDGE_CONNECT_FAILED: {
    origin: "client",
    status: null,
    retryable: true,
    message: "Could not connect to the Cloudflare edge.",
    cause: "All edge addresses refused or timed out",
    action: "Often a firewall blocking UDP 7844. Suggest `--transport http2`",
  },
  EDGE_REGISTRATION_REFUSED: {
    origin: "client",
    status: null,
    retryable: true,
    message: "The Cloudflare edge refused this connection.",
    cause: "The edge rejected `registerConnection`",
    action: "If `EDUPCONN`, retried automatically. Otherwise likely an expired token",
    details: ["cause"],
  },
  EDGE_PROTOCOL_ERROR: {
    origin: "client",
    status: null,
    retryable: false,
    message: "NPort could not understand the Cloudflare edge's response.",
    cause: "A frame could not be parsed, or the version byte is not `01`",
    action:
      "**Likely a Cloudflare protocol change.** Upgrade NPort; if that does not help, report it",
  },
  TUNNEL_LOST: {
    origin: "client",
    status: null,
    retryable: false,
    message: "The tunnel connection was lost and could not be re-established.",
    cause: "All edge connections dropped and reconnection was exhausted",
    action: "Check the network; the CLI exits non-zero",
  },
  LOCAL_REQUEST_FAILED: {
    origin: "client",
    status: null,
    retryable: false,
    message: "Your local server refused or reset the request.",
    cause: "The local server refused or reset a proxied request",
    action: "The tunnel is fine; the local app is not",
  },
  SHUTDOWN_TIMEOUT: {
    origin: "client",
    status: null,
    retryable: false,
    message: "Shutdown took longer than expected.",
    cause: "Graceful shutdown exceeded its deadline",
    action: "Informational; the lease still expires server-side",
  },
} as const satisfies Record<string, ErrorDefinition>

/** Every code in the registry. Derived, so it can never fall out of step with `ERRORS`. */
export type ErrorCode = keyof typeof ERRORS

/** Codes that cross the network and therefore have an HTTP status. */
export type ServerErrorCode = {
  [K in ErrorCode]: (typeof ERRORS)[K]["origin"] extends "server" ? K : never
}[ErrorCode]

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[]

/** Whether a string is a known code. The narrowing is what lets a client branch safely. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERRORS, value)
}

/**
 * The documentation URL for a code.
 *
 * Single definition on purpose: the CLI prints it, the API puts it in every envelope, and the
 * website routes on it. Three hand-written lowercase-and-hyphenate implementations is three
 * chances to produce a 404 in an error message, which is the worst possible moment for one.
 */
export function docsUrl(code: ErrorCode, origin = "https://nport.link"): string {
  return `${origin}/errors/${errorSlug(code)}`
}

/** `SUBDOMAIN_IN_USE` → `subdomain-in-use`. */
export function errorSlug(code: ErrorCode): string {
  return code.toLowerCase().replaceAll("_", "-")
}

/** The HTTP status for a server code. */
export function httpStatus(code: ServerErrorCode): number {
  const status = ERRORS[code].status
  if (status === null) {
    // Unreachable via the type, but `crates/contract` and the Worker both call this with values
    // that crossed a serialization boundary, where the type guarantee no longer holds.
    throw new Error(`${code} is a client-side error and has no HTTP status`)
  }
  return status
}
