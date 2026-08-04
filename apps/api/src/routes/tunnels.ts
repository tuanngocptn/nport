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
import { Hono } from "hono"

import type { Registry } from "../do/registry"
import type { ClaimResult, SubdomainLease } from "../do/subdomain-lease"
import { generateSubdomain } from "../domain/generated-name"
import { sourceHash } from "../domain/ip-hash"
import { hashOwnerToken, mintOwnerToken } from "../domain/owner-token"
import { CHALLENGE_TTL_MS, verifyChallenge } from "../domain/pow"
import { ApiError } from "../errors"
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
        const check = checkSubdomain(requested)
        if (!check.ok) {
          if (check.reason === "reserved" || check.reason === "reserved-prefix") {
            throw new ApiError("SUBDOMAIN_RESERVED")
          }
          throw new ApiError("INVALID_SUBDOMAIN", { reason: check.reason })
        }
        chosen = check.subdomain
      }

      const registry = registryStub(env)

      if ((await registry.activeCount()) >= Number(env.MAX_ACTIVE_TUNNELS)) {
        throw new ApiError("CAPACITY_EXHAUSTED", { retryAfter: CAPACITY_RETRY_AFTER })
      }

      // Spent last among the cheap checks, and only once the request is otherwise acceptable. The MAC
      // is the challenge's signature half: unique per issuance, and shorter than the whole.
      const mac = request.challenge.split(".")[1] ?? request.challenge
      if (!(await registry.spendChallenge(mac, Date.now() + CHALLENGE_LEDGER_MS))) {
        throw new ApiError("POW_INVALID", { reason: "challenge already used" })
      }

      // Minted and hashed here: the Durable Object stores only the hash, so nothing that persists
      // ever holds the token itself (`docs/ARCHITECTURE.md` §7).
      const ownerToken = mintOwnerToken()
      const ownerTokenHash = await hashOwnerToken(ownerToken)
      const ipHash = await sourceHash(
        env.IP_HASH_SECRET,
        context.req.header("cf-connecting-ip") ?? "unknown",
        // `cf` is typed `unknown` on the global `Request` that Hono exposes, so the shape of
        // `IncomingRequestCfProperties` is not visible here. `asn` is a number when present.
        context.req.raw.cf?.asn as number | undefined,
      )
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
        throw new ApiError(result.code, result.details)
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
      const subdomain = pathSubdomain(context.req.param("subdomain"))
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
      const subdomain = pathSubdomain(context.req.param("subdomain"))
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
    const subdomain = pathSubdomain(context.req.param("subdomain"))

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
function pathSubdomain(raw: string): string {
  const check = checkSubdomainShape(raw)
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
