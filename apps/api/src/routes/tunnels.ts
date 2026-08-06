/**
 * `/v1/tunnels` — the lease lifecycle.
 *
 * This file is deliberately thin. It validates, prices the request, and translates between HTTP and
 * the Durable Objects; every decision that has to be atomic lives in `src/do/subdomain-lease.ts`
 * (`apps/api/CLAUDE.md` rule 4). The one thing it owns outright is the `ownerToken`: minted here,
 * hashed here, and only the hash travels onward — so the plaintext exists in exactly one response
 * and nowhere else in the system.
 */

import { zValidator } from "@hono/zod-validator"
import {
  checkSubdomain,
  checkSubdomainShape,
  createTunnelRequestSchema,
  deleteTunnelRequestSchema,
  heartbeatRequestSchema,
} from "@nport/contract"
import { ApiError, CHALLENGE_TTL_MS, verifyChallenge } from "@nport/worker-kit"
import { Hono } from "hono"
import type { Registry } from "../do/registry"
import type { SourceQuota } from "../do/source-quota"
import type { ClaimResult, SubdomainLease } from "../do/subdomain-lease"
import { generateSubdomain } from "../domain/generated-name"
import { hashOwnerToken, mintOwnerToken } from "../domain/owner-token"
import { zoneSuffix } from "../env"
import type { Env, Variables } from "../types"

/**
 * Attempts at a generated name before giving up.
 *
 * A collision needs two of 2^64 names to coincide, so this will not be reached — but "will not be
 * reached" is not the same as "cannot be", and the alternative is answering `SUBDOMAIN_IN_USE` for a
 * name the caller never chose, which they have no way to act on.
 */
const GENERATE_ATTEMPTS = 3

/** Seconds to suggest when the global cap is hit. Short, because capacity frees up as leases expire. */
const CAPACITY_RETRY_AFTER = 30

/**
 * A placeholder holding a concurrency slot while a generated name is being claimed.
 *
 * A generated name is not known until the claim succeeds, but the slot has to be taken *before* the
 * claim or the cap would not bound anything. The placeholder is moved onto the real name on success and
 * released on failure.
 *
 * **Unique per request, and that is load-bearing.** A single shared placeholder made the per-source cap
 * evadable: `reserve` treats a name it already holds as not needing a new slot — which is right for a
 * client retrying the same explicit subdomain — so every simultaneous generated-name create saw the one
 * placeholder already held and passed the check. Five concurrent requests produced five tunnels against
 * a cap of three. With a unique name each, every request takes its own slot.
 *
 * `nport-` is a reserved prefix, so this can never collide with a subdomain a user could claim.
 */
function pendingName(): string {
  return `nport-pending-${crypto.randomUUID()}`
}

/**
 * How long a redeemed challenge stays in the ledger.
 *
 * Comfortably longer than the challenge's own TTL: a ledger row that expired first would open a
 * window in which the challenge is still valid and no longer recorded as spent, which is exactly the
 * replay the ledger exists to stop.
 */
const CHALLENGE_LEDGER_MS = CHALLENGE_TTL_MS * 3

type App = { Bindings: Env; Variables: Variables }

interface SchemaIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/**
 * Turns zod issues into `INVALID_REQUEST`.
 *
 * Without this, `@hono/zod-validator` answers with its own body shape — the one response in the API
 * that would not match `docs/ERRORS.md`. The issues travel in `details` because they describe the
 * caller's own request and so leak nothing.
 */
function invalidRequest(issues: readonly SchemaIssue[]): ApiError {
  const reason = issues.map((issue) => {
    const path = issue.path
      // A symbol key cannot arise from JSON input, but `String(symbol)` throws, and an error handler
      // that can itself throw is worse than a vague message.
      .map((segment) => (typeof segment === "symbol" ? "?" : String(segment)))
      .join(".")
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message
  })
  return new ApiError("INVALID_REQUEST", { reason })
}

export const tunnelsRoute = new Hono<App>()

  /**
   * `POST /v1/tunnels` — claim a subdomain and provision a tunnel.
   *
   * The only expensive endpoint, and the only non-idempotent one. Checks run cheapest-first so an
   * abusive caller pays before we do: the proof of work is verified with one HMAC before any Durable
   * Object is touched, and the subdomain is validated with pure logic before the challenge is spent,
   * so a typo does not cost a caller the work they already did.
   */
  .post(
    "/",
    zValidator("json", createTunnelRequestSchema, (result) => {
      if (!result.success) {
        throw invalidRequest(result.error.issues)
      }
    }),
    async (context) => {
      const request = context.req.valid("json")
      const env = context.env

      if (request.challenge.length === 0 || request.nonce.length === 0) {
        throw new ApiError("POW_REQUIRED")
      }

      const proof = await verifyChallenge(
        env.POW_SECRET,
        request.challenge,
        request.nonce,
        Date.now(),
      )
      if (!proof.ok) {
        // `CHALLENGE_EXPIRED` is retryable and `POW_INVALID` is not, so this mapping decides whether
        // a client backs off or gives up. `verifyChallenge` checks the signature before the expiry
        // for exactly this reason: a forged challenge must never be reported as merely stale.
        throw new ApiError(proof.reason === "expired" ? "CHALLENGE_EXPIRED" : "POW_INVALID")
      }

      const requested = request.subdomain
      let chosen: string | undefined
      if (requested !== undefined) {
        const check = checkSubdomain(requested, zoneSuffix(env))
        if (!check.ok) {
          if (check.reason === "reserved" || check.reason === "reserved-prefix") {
            throw new ApiError("SUBDOMAIN_RESERVED")
          }
          throw new ApiError("INVALID_SUBDOMAIN", { reason: check.reason })
        }
        chosen = check.subdomain
      }

      // The source's identity, computed once by the rate-limit middleware. Reusing it rather than
      // re-hashing keeps the limiter, the quota, and the lease's stored `ip_hash` on one identity.
      const ipHash = context.get("sourceHash")
      const quota = quotaStub(env, ipHash)

      // Per-source caps before the global one: they are what actually bound a single abuser, and they
      // live on a per-source object, so checking them first keeps the shared `Registry` off the path
      // for a request that is going to be refused anyway.
      const pending = chosen ?? pendingName()
      const reserved = await quota.reserve(pending, {
        maxConcurrent: Number(env.MAX_CONCURRENT_PER_SOURCE),
        maxPerHour: Number(env.MAX_CREATES_PER_HOUR_PER_SOURCE),
      })
      if (!reserved.ok) {
        throw new ApiError(reserved.code, reserved.details)
      }

      // Global cap and the challenge ledger, atomically and in one round trip. Capacity is checked
      // first inside, so a 503 never burns the caller's solved challenge. The MAC is the challenge's
      // signature half: unique per issuance, and shorter than the whole.
      const mac = request.challenge.split(".")[1] ?? request.challenge
      const admitted = await registryStub(env).admitCreate(
        mac,
        Date.now() + CHALLENGE_LEDGER_MS,
        Number(env.MAX_ACTIVE_TUNNELS),
      )
      if (!admitted.ok) {
        await releaseQuietly(quota, pending)
        if (admitted.reason === "capacity") {
          throw new ApiError("CAPACITY_EXHAUSTED", { retryAfter: CAPACITY_RETRY_AFTER })
        }
        throw new ApiError("POW_INVALID", { reason: "challenge already used" })
      }

      // Minted and hashed here: the Durable Object stores only the hash, so nothing that persists
      // ever holds the token itself (`docs/ARCHITECTURE.md` §7).
      const ownerToken = mintOwnerToken()
      const ownerTokenHash = await hashOwnerToken(ownerToken)
      const clientVersion = context.req.header("user-agent") ?? ""

      const attempts = requested === undefined ? GENERATE_ATTEMPTS : 1
      let result: ClaimResult = { ok: false, code: "PROVISION_FAILED" }
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const candidate = chosen ?? generateSubdomain()
        const claimed = await leaseStub(env, candidate).claim({
          subdomain: candidate,
          ownerTokenHash,
          ipHash,
          clientVersion,
        })
        result = claimed
        // Only a name collision is worth a second try, and only when we chose the name.
        if (result.ok || result.code !== "SUBDOMAIN_IN_USE") {
          break
        }
      }

      if (!result.ok) {
        // Hand the slot back immediately rather than waiting for the reservation to lapse. The hourly
        // create count is deliberately *not* refunded: this attempt reached Cloudflare and cost real
        // work, and refunding failures would let anyone with a reliable way to fail create endlessly.
        await releaseQuietly(quota, pending)
        throw new ApiError(result.code, result.details)
      }

      // The lease confirmed its own hold, under the real name, as it activated — it is the only party
      // that knows the authoritative expiry. All that is left is to hand back the placeholder that
      // stood in for a name nobody knew yet.
      if (chosen === undefined) {
        await releaseQuietly(quota, pending)
      }

      return context.json(
        {
          subdomain: result.subdomain,
          url: `https://${result.subdomain}.${env.CF_DOMAIN}`,
          tunnelId: result.tunnelId,
          tunnelToken: result.tunnelToken,
          ownerToken,
          expiresAt: result.expiresAt,
        },
        201,
        // Both credentials are in this body, and it is the only time either is issued. A cache
        // anywhere on the path would be a credential store nobody chose to build.
        { "cache-control": "no-store" },
      )
    },
  )

  /**
   * `POST /v1/tunnels/:subdomain/heartbeat` — renew the lease.
   *
   * Cheap and frequent: one Durable Object call, no Cloudflare traffic. At one per tunnel per 30 s
   * this is the dominant request cost in the system (`docs/ARCHITECTURE.md` §6), which is the reason
   * nothing expensive may ever be added to it.
   */
  .post(
    "/:subdomain/heartbeat",
    zValidator("json", heartbeatRequestSchema, (result) => {
      if (!result.success) {
        throw invalidRequest(result.error.issues)
      }
    }),
    async (context) => {
      const subdomain = pathSubdomain(context.req.param("subdomain"), zoneSuffix(context.env))
      const { ownerToken } = context.req.valid("json")

      const result = await leaseStub(context.env, subdomain).heartbeat(
        await hashOwnerToken(ownerToken),
      )
      if (!result.ok) {
        throw new ApiError(result.code, result.details)
      }
      // Authoritative: the client corrects its countdown from this rather than counting locally.
      return context.json({ expiresAt: result.expiresAt })
    },
  )

  /**
   * `DELETE /v1/tunnels/:subdomain` — release the lease and tear down.
   *
   * `204` even when there was nothing to release: a client retrying after a network blip must not be
   * told its own successful delete failed (`docs/API.md`). v2's second Ctrl+C fired a second DELETE
   * and reported an error for it (defect R19).
   */
  .delete(
    "/:subdomain",
    zValidator("json", deleteTunnelRequestSchema, (result) => {
      if (!result.success) {
        throw invalidRequest(result.error.issues)
      }
    }),
    async (context) => {
      const subdomain = pathSubdomain(context.req.param("subdomain"), zoneSuffix(context.env))
      const { ownerToken } = context.req.valid("json")

      const result = await leaseStub(context.env, subdomain).release(
        await hashOwnerToken(ownerToken),
      )
      if (!result.ok) {
        throw new ApiError(result.code, result.details)
      }
      return context.body(null, 204)
    },
  )

  /**
   * `GET /v1/tunnels/:subdomain` — public status.
   *
   * Unauthenticated, so it carries nothing an attacker could use: no tunnel ID, no owner hash, no
   * client version. Whether a name is taken is public information regardless — DNS answers it.
   */
  .get("/:subdomain", async (context) => {
    const subdomain = pathSubdomain(context.req.param("subdomain"), zoneSuffix(context.env))

    const result = await leaseStub(context.env, subdomain).status()
    if (!result.ok) {
      throw new ApiError(result.code, result.details)
    }
    return context.json({ subdomain, active: result.active, expiresAt: result.expiresAt })
  })

/**
 * Normalizes and shape-checks a `:subdomain` path parameter.
 *
 * Shape only — see `validateSubdomainShape` in `@nport/contract`. The full validator here would make
 * every generated `nport-…` tunnel unable to report its status, heartbeat, or delete itself, because
 * `nport-` is a reserved prefix.
 */
function pathSubdomain(raw: string, zone: string): string {
  const check = checkSubdomainShape(raw, zone)
  if (!check.ok) {
    // 400 rather than 404: a name that could never have been issued is a malformed request, not a
    // missing thing. It also means a junk path never becomes a Durable Object.
    throw new ApiError("INVALID_SUBDOMAIN", { reason: check.reason })
  }
  return check.subdomain
}

/**
 * The lease object for a name.
 *
 * **The name must already be normalized.** `idFromName` on a raw value yields two objects for one
 * logical name, and the whole atomicity guarantee rests on there being one
 * (`apps/api/CLAUDE.md` § Gotchas). Every caller above goes through a checker that normalizes.
 */
function leaseStub(env: Env, subdomain: string): DurableObjectStub<SubdomainLease> {
  return env.SUBDOMAIN_LEASE.get(env.SUBDOMAIN_LEASE.idFromName(subdomain))
}

function registryStub(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("global"))
}

function quotaStub(env: Env, sourceHash: string): DurableObjectStub<SourceQuota> {
  return env.SOURCE_QUOTA.get(env.SOURCE_QUOTA.idFromName(sourceHash))
}

/**
 * Hands back the reservation this request took, without letting bookkeeping fail the request.
 *
 * `releaseReservation`, never `release`: it frees a slot only while it is still an unconfirmed
 * reservation, so it can never remove the hold of a lease that is already live. Every caller here is on
 * an error path or has already succeeded, so throwing would replace a meaningful response with an
 * opaque 500 — and an unreleased reservation lapses on its own within the minute anyway.
 */
async function releaseQuietly(quota: DurableObjectStub<SourceQuota>, name: string): Promise<void> {
  try {
    await quota.releaseReservation(name)
  } catch (error) {
    console.error("could not release a reserved quota slot", { error: String(error) })
  }
}
