/**
 * The v2 compatibility shim.
 *
 * Every 2.x client in the wild dispatches on HTTP method against `/` with no path routing: `POST /`
 * creates, `DELETE /` deletes, `GET /` redirects. This preserves exactly that, translating to the same
 * Durable Objects `/v1` uses, so an installed `npm i -g nport@2` keeps working until the sunset date in
 * `docs/RELEASE.md`.
 *
 * ## This path is weaker than `/v1`, and that is the argument for sunsetting it
 *
 * Of the layered abuse controls in `docs/ARCHITECTURE.md` §7, the legacy path gets the request-rate
 * limiter, the per-source caps, and the global cap — but **not proof of work**, because a v2 client has
 * no idea how to solve one. Proof of work is the control §7 calls load-bearing: the only one that raises
 * attacker cost without an account. So this endpoint is the cheapest way to create a tunnel that exists,
 * and it stays open only because breaking installed clients on day one is worse.
 *
 * Ownership is weaker too: a v2 client never received an `ownerToken`, so its delete is authorized by
 * source hash against a lease flagged `legacy` (see `SubdomainLease.releaseAsLegacy`).
 *
 * ## Two v2 behaviours are deliberately not preserved
 *
 * Both were the bugs, per `docs/API.md`:
 *
 * - v2's create **took over** a subdomain whose tunnel merely looked `down`, `degraded`, or `inactive`,
 *   deleting the incumbent's tunnel and DNS record. A user whose connection flapped could lose their name
 *   to a stranger (defect R7). Here a live lease is a refusal.
 * - v2's delete accepted any `{subdomain, tunnelId}` from anyone, including for the `api` record itself.
 *
 * ## Why v2's error strings are reproduced verbatim
 *
 * The 2.x CLI matches substrings — `SUBDOMAIN_IN_USE:`, `currently in use`, `SUBDOMAIN_PROTECTED:` — to
 * choose which of its formatted, translated messages to print. That substring matching is ADR-0018's
 * central mistake, and it is *already shipped*: the only way an old client shows a useful message is if
 * the body it receives still contains the string it looks for. So these literals are a compatibility
 * encoder at the boundary, not a return to message-matching. Nothing inside NPort branches on them.
 */

import { checkSubdomain, checkSubdomainShape } from "@nport/contract"
import { Hono } from "hono"

import type { ClaimResult } from "../do/subdomain-lease"
import { generateSubdomain } from "../domain/generated-name"
import { hashOwnerToken, mintOwnerToken } from "../domain/owner-token"
import type { Env, Variables } from "../types"

type App = { Bindings: Env; Variables: Variables }

/** Recorded on every lease the shim creates, so logs and metrics can tell the two paths apart. */
const LEGACY_CLIENT_VERSION = "nport/2.x (legacy shim)"

/** Attempts at a generated name. Same reasoning as `/v1`; a collision needs two of 2^64 to coincide. */
const GENERATE_ATTEMPTS = 3

interface LegacyBody {
  readonly subdomain?: unknown
  readonly tunnelId?: unknown
}

/** v2's failure shape. The 2.x CLI reads `error` out of the response body and matches on it. */
function legacyError(message: string, status: number) {
  return { body: { success: false as const, error: message }, status }
}

/**
 * Whether a request is one the shim owns, and therefore must be answered in v2's shape.
 *
 * Needed by the app's error handler, not just by the handlers here. A failure raised in *middleware* —
 * the rate limiter, the binding check — never reaches this file, so without this the caller would get the
 * `/v1` envelope: `{error: {code, message, …}}` where a 2.x client expects `{success, error}`. It reads
 * `data.error` and would print `[object Object]`, which is how a rate-limited old client would report
 * "too many requests".
 */
export function isLegacyRequest(path: string, method: string): boolean {
  return path === "/" && (method === "POST" || method === "DELETE")
}

/** The v2-shaped body for a failure raised outside this file. */
export function legacyEnvelope(message: string): { success: false; error: string } {
  return { success: false, error: message }
}

/**
 * v2 returned HTTP 500 for every failure, including "that name is taken".
 *
 * The bodies below are byte-compatible with what the 2.x CLI parses, but the status is the accurate one
 * from the error registry. That is the single deliberate deviation, and it is safe: the CLI inspects only
 * `response.data.error`, and it never retries — so nothing in an installed client can observe the
 * difference, while anything else looking at the traffic gets a status that is not a lie.
 */
export const legacyRoute = new Hono<App>()

  .post("/", async (context) => {
    const env = context.env
    const body = await readBody(context.req.raw)
    if (body === undefined) {
      const { body: payload, status } = legacyError("Invalid request body", 400)
      return context.json(payload, status as 400)
    }

    const requested = typeof body.subdomain === "string" ? body.subdomain : undefined
    let chosen: string | undefined
    if (requested !== undefined && requested.length > 0) {
      const check = checkSubdomain(requested)
      if (!check.ok) {
        // `SUBDOMAIN_PROTECTED:` is what v2 emitted for a reserved name, and what its CLI matches to
        // suggest alternatives. Reused for every rejection here because v2 had no other vocabulary for
        // "you cannot have this name" — it performed no validation at all (defect R2).
        const { body: payload, status } = legacyError(
          `SUBDOMAIN_PROTECTED: Subdomain "${requested}" is reserved and cannot be used.`,
          check.reason === "reserved" || check.reason === "reserved-prefix" ? 403 : 400,
        )
        return context.json(payload, status as 400)
      }
      chosen = check.subdomain
    }

    const ipHash = context.get("sourceHash")
    const quota = env.SOURCE_QUOTA.get(env.SOURCE_QUOTA.idFromName(ipHash))
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))

    // Same per-source caps as `/v1`. They are the only hard limit this path has, since it cannot ask for
    // proof of work.
    const pending = chosen ?? `nport-pending-${crypto.randomUUID()}`
    const reserved = await quota.reserve(pending, {
      maxConcurrent: Number(env.MAX_CONCURRENT_PER_SOURCE),
      maxPerHour: Number(env.MAX_CREATES_PER_HOUR_PER_SOURCE),
    })
    if (!reserved.ok) {
      const { body: payload, status } = legacyError(
        "Too many tunnels from this network. Please close one, or wait, and try again.",
        429,
      )
      return context.json(payload, status as 400)
    }

    if (!(await registry.hasCapacity(Number(env.MAX_ACTIVE_TUNNELS)))) {
      await release(quota, pending)
      const { body: payload, status } = legacyError(
        "NPort is at capacity. Please try again shortly.",
        503,
      )
      return context.json(payload, status as 400)
    }

    // Minted and discarded: a v2 client has nowhere to put an `ownerToken`, and the lease requires a hash.
    // Nothing can ever present the matching token, which is why `releaseAsLegacy` exists at all.
    const ownerTokenHash = await hashOwnerToken(mintOwnerToken())

    const attempts = requested === undefined ? GENERATE_ATTEMPTS : 1
    let result: ClaimResult = { ok: false, code: "PROVISION_FAILED" }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = chosen ?? generateSubdomain()
      result = await env.SUBDOMAIN_LEASE.get(env.SUBDOMAIN_LEASE.idFromName(candidate)).claim({
        subdomain: candidate,
        ownerTokenHash,
        ipHash,
        clientVersion: LEGACY_CLIENT_VERSION,
        legacy: true,
      })
      if (result.ok || result.code !== "SUBDOMAIN_IN_USE") {
        break
      }
    }

    if (!result.ok) {
      await release(quota, pending)
      const { body: payload, status } = legacyError(
        legacyMessageFor(result.code, chosen ?? requested ?? "your tunnel"),
        result.code === "SUBDOMAIN_IN_USE" || result.code === "DNS_CONFLICT" ? 409 : 502,
      )
      return context.json(payload, status as 400)
    }

    if (chosen === undefined) {
      await release(quota, pending)
    }

    // Exactly v2's success body. `expiresAt` and `ownerToken` are deliberately absent: a 2.x client would
    // ignore both, and sending a credential nothing can use would be worse than useless.
    return context.json(
      {
        success: true,
        tunnelId: result.tunnelId,
        tunnelToken: result.tunnelToken,
        url: `https://${result.subdomain}.${env.CF_DOMAIN}`,
      },
      200,
      { "cache-control": "no-store" },
    )
  })

  .delete("/", async (context) => {
    const body = await readBody(context.req.raw)
    const raw = typeof body?.subdomain === "string" ? body.subdomain : undefined
    if (raw === undefined || raw.length === 0) {
      // v2 built `tun-<Date.now()>` when the subdomain was missing and then tried to delete *that*,
      // which could only ever be wrong. Refusing is the honest answer.
      const { body: payload, status } = legacyError("A subdomain is required", 400)
      return context.json(payload, status as 400)
    }

    const check = checkSubdomainShape(raw)
    if (!check.ok) {
      const { body: payload, status } = legacyError("Invalid subdomain", 400)
      return context.json(payload, status as 400)
    }

    // `tunnelId` from the body is deliberately ignored. v2 trusted it, which is how any caller could
    // delete any tunnel by naming it. The lease is the authority on which tunnel belongs to this name.
    const result = await context.env.SUBDOMAIN_LEASE.get(
      context.env.SUBDOMAIN_LEASE.idFromName(check.subdomain),
    ).releaseAsLegacy(context.get("sourceHash"))

    if (!result.ok) {
      const { body: payload, status } = legacyError(
        result.code === "INVALID_OWNER_TOKEN"
          ? "This tunnel cannot be deleted from here. It will expire on its own."
          : "The tunnel could not be removed. Please try again.",
        result.code === "INVALID_OWNER_TOKEN" ? 403 : 502,
      )
      return context.json(payload, status as 400)
    }

    return context.json({ success: true })
  })

/**
 * v2's response for any other method on `/`: plain text, not JSON.
 *
 * Registered after the specific handlers, so `GET` still reaches its redirect. Preserved because an old
 * client or a monitor may distinguish 405 from the 400 our not-found handler would otherwise return.
 */
export const legacyMethodNotAllowed = new Hono<App>().all("/", (context) =>
  context.text("Method Not Allowed", 405),
)

/** v2's vocabulary for a failed create, chosen so the 2.x CLI prints something useful. */
function legacyMessageFor(code: string, subdomain: string): string {
  switch (code) {
    case "SUBDOMAIN_IN_USE":
    case "DNS_CONFLICT":
      // `currently in use` is one of the substrings the 2.x CLI matches, and it produces that client's
      // best message: a formatted list of alternative names to try.
      return `SUBDOMAIN_IN_USE: Subdomain "${subdomain}" is currently in use by an active tunnel.`
    case "CAPACITY_EXHAUSTED":
      return "NPort is at capacity. Please try again shortly."
    default:
      // Never the upstream text. v2 echoed Cloudflare's error strings to anonymous callers, leaking
      // account and zone internals (defect R11); the shim exists to be compatible, not to reproduce that.
      return "The tunnel could not be created. Please try again."
  }
}

async function readBody(request: Request): Promise<LegacyBody | undefined> {
  try {
    const parsed: unknown = await request.json()
    return typeof parsed === "object" && parsed !== null ? (parsed as LegacyBody) : {}
  } catch {
    // v2 answered a malformed body with its generic 500 envelope. A 400 is more accurate and the CLI
    // reads the body either way.
    return undefined
  }
}

/** Frees a reservation without letting bookkeeping turn a real answer into a 500. */
async function release(
  quota: { releaseReservation(name: string): Promise<void> },
  name: string,
): Promise<void> {
  try {
    await quota.releaseReservation(name)
  } catch (error) {
    console.error("legacy shim could not release a reserved quota slot", { error: String(error) })
  }
}
