import { zValidator } from "@hono/zod-validator"
import {
  isValidNodeId,
  MAX_NODE_DOMAIN_LENGTH,
  type Node,
  registerNodeRequestSchema,
} from "@nport/contract"
import { ApiError, verifyChallenge } from "@nport/worker-kit"
import { Hono } from "hono"
import type { Env, Variables } from "../types"
import { domainProofSatisfied, probeNode, verifyNodeUrl } from "../upstream"

/**
 * `GET /v1/nodes` and `POST /v1/nodes` — the whole directory.
 *
 * `docs/API.md` § The registry API for the lifecycle. Two properties shape this file:
 *
 * **The list is advisory.** A client caches it and a registry that is down does not stop a tunnel
 * being created, which is what lets a single directory not be a single point of failure (ADR-0031).
 * So nothing here is on a tunnel's critical path, and `GET` is deliberately boring.
 *
 * **Registration is gated but not authenticated.** There is no account and no shared secret —
 * invariant 1 applies here too. What stands in for identity is proof of work, a DNS TXT record
 * proving control of the claimed domain, and a liveness probe.
 */
export function createNodesRoute(fetcher: typeof fetch = fetch) {
  return new Hono<{ Bindings: Env; Variables: Variables }>()
    .get("/", async (context) => {
      const directory = context.env.DIRECTORY.get(context.env.DIRECTORY.idFromName("global"))
      const nodes = await directory.list()

      return context.json(
        {
          nodes,
          // Published rather than hardcoded, for ADR-0037's reason: the registry can slow every client
          // down without a release.
          refreshAfterMs: Number(context.env.NODE_LIST_REFRESH_MS),
        },
        200,
        // Short and public. The list changes only when a node registers or a probe changes a status,
        // both on the order of minutes — and a cached copy is exactly what the design wants clients to
        // be using. Deliberately not `no-store`: unlike a challenge, this response is not per-caller
        // and holds nothing secret.
        { "cache-control": "public, max-age=60" },
      )
    })
    .post("/", zValidator("json", registerNodeRequestSchema, invalid), async (context) => {
      const body = context.req.valid("json")
      const env = context.env
      const now = Date.now()

      // ── Local checks first. None of these cost a subrequest, so a malformed registration is
      // refused before it can make us resolve a name or fetch a URL.
      if (!isValidNodeId(body.id)) {
        throw new ApiError("REGISTRATION_REFUSED", { reason: "invalid-node-id" })
      }
      if (!looksLikeDomain(body.domain)) {
        throw new ApiError("REGISTRATION_REFUSED", { reason: "invalid-domain" })
      }
      const url = verifyNodeUrl(body.url, body.domain)
      if (!url.ok) {
        // `not-under-domain` is the interesting one: see `verifyNodeUrl` for why the URL must live
        // under the domain being proved, rather than anywhere the caller likes.
        throw new ApiError("REGISTRATION_REFUSED", { reason: "invalid-url", detail: url.reason })
      }

      // ── Proof of work, before anything on the network. Verifying is one HMAC and one hash; a caller
      // who has not paid gets no subrequests spent on them.
      const solved = await verifyChallenge(env.POW_SECRET, body.challenge, body.nonce, now)
      if (!solved.ok) {
        throw new ApiError(solved.reason === "expired" ? "CHALLENGE_EXPIRED" : "POW_INVALID")
      }

      const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))

      // An id may be **refreshed** by whoever proves the same domain, and claimed by nobody else.
      // Without this, publishing a TXT record for your own domain would let you take over any id in
      // the directory — the takeover shape invariant 8 guards against one layer down.
      const owner = await directory.domainFor(body.id)
      if (owner !== null && owner !== body.domain) {
        throw new ApiError("REGISTRATION_REFUSED", { reason: "id-taken" })
      }

      // The challenge is spent here, together with the capacity check, in one hop and with no `await`
      // between them — so two concurrent redemptions of one challenge cannot both succeed.
      const admitted = await directory.admitRegistration(
        challengeMac(body.challenge),
        now + CHALLENGE_LEDGER_TTL_MS,
        body.id,
        Number(env.MAX_NODES),
      )
      if (!admitted.ok) {
        if (admitted.reason === "capacity") {
          // Our limit, not the caller's fault, and retryable — which is why it is checked before the
          // ledger, so a 503 does not burn a solved challenge.
          throw new ApiError("CAPACITY_EXHAUSTED", { retryAfter: 3600 })
        }
        throw new ApiError("POW_INVALID")
      }

      // ── Now the network. Two subrequests, in this order: the proof is cheaper than the probe and
      // refusing on it saves a fetch to a host we have not yet established anyone controls.
      if (!(await domainProofSatisfied(body.domain, body.id, fetcher))) {
        throw new ApiError("REGISTRATION_REFUSED", { reason: "proof-missing" })
      }

      const observed = await probeNode(body.url, fetcher)
      if (observed === null) {
        // Nothing worth listing. Not an error on our side: the operator's node did not answer its own
        // `/v1/meta`, and saying so is more useful than listing something that cannot serve.
        throw new ApiError("REGISTRATION_REFUSED", { reason: "unreachable" })
      }

      const entry: Node = {
        id: body.id,
        url: body.url,
        domain: body.domain,
        ...(body.region === undefined ? {} : { region: body.region }),
        version: body.version,
        // Registration only succeeds after a successful probe, so a newly listed node is never
        // anything but `up`.
        status: "up",
        ...observed,
        lastProbedAt: now,
      }
      await directory.upsert(entry)

      // 201 for a refresh as well as a first registration. The alternative — 200 for an update — would
      // make a caller branch on which it was, and a node self-registering on boot neither knows nor
      // cares whether the directory remembered it.
      return context.json({ node: entry }, 201)
    })
}

/**
 * The route as the Worker mounts it.
 *
 * The factory above takes its `fetch` explicitly so tests can hand it `test/fake-upstream.ts` and no
 * test can reach a real resolver or a stranger's server. A module-level mutable fetcher would have
 * been fewer characters and is forbidden for a good reason — an isolate is shared across callers, so
 * module scope is not per-request (`apps/registry/CLAUDE.md`).
 */
export const nodesRoute = createNodesRoute()

/**
 * How long a spent challenge is remembered.
 *
 * Matches the challenge's own validity window: once a challenge cannot be redeemed anyway, the ledger
 * row is dead weight. `apps/api` keeps the same shape for the same reason (ADR-0027).
 */
const CHALLENGE_LEDGER_TTL_MS = 120_000

/**
 * The ledger key: a challenge's MAC, not the whole challenge.
 *
 * The MAC is the part that makes a challenge unforgeable, so it identifies one uniquely — and it is
 * fixed-length, which keeps the row small. Falls back to the whole string if the shape is unexpected,
 * which cannot happen for a challenge that just verified.
 */
function challengeMac(challenge: string): string {
  return challenge.split(".")[1] ?? challenge
}

/**
 * A cheap sanity check that a string is a domain rather than a URL, a path, or a sentence.
 *
 * Deliberately **not** a full validator. What actually protects the registry is `verifyNodeUrl` and
 * the TXT lookup: a domain that is not real resolves to nothing and the registration is refused. This
 * exists so obvious junk never reaches a DNS query, and so an operator who pastes
 * `https://nport.dev/` gets `invalid-domain` instead of a confusing `proof-missing`.
 */
function looksLikeDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_NODE_DOMAIN_LENGTH) return false
  if (domain.includes("/") || domain.includes(":") || domain.includes(" ")) return false
  if (domain.startsWith(".") || domain.endsWith(".")) return false
  // At least one dot: a single label is never a registrable domain, and `_nport-node.localhost`
  // is not a proof anyone can publish.
  return domain.includes(".") && /^[a-z0-9.-]+$/.test(domain)
}

/** A schema failure is `INVALID_REQUEST`, with the code from the registry rather than zod's prose. */
function invalid(result: { success: boolean }): Response | undefined {
  if (!result.success) {
    throw new ApiError("INVALID_REQUEST")
  }
  return undefined
}
