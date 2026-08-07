/**
 * Route definitions: method, path, what each carries, and which errors it can return.
 *
 * **Two tables, one per service.** [`ROUTES`] is a node's API and emits
 * `schema/nport-node.openapi.json`; [`REGISTRY_ROUTES`] is the registry's and emits
 * `schema/nport-registry.openapi.json` (ADR-0046). `pnpm codegen` walks both.
 *
 * Keeping them as data rather than as decorators on Hono handlers means each OpenAPI document can be
 * generated without importing its Worker, so codegen has no dependency on `workerd` or on any
 * binding — which matters more now that one of the two Workers does not exist yet.
 */

import type { z } from "zod"

import type { ErrorCode } from "./errors"
import {
  challengeResponseSchema,
  createTunnelRequestSchema,
  createTunnelResponseSchema,
  deleteTunnelRequestSchema,
  healthResponseSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  metaResponseSchema,
  nodeListResponseSchema,
  registerNodeRequestSchema,
  registerNodeResponseSchema,
  tunnelStatusResponseSchema,
} from "./schemas"

export type HttpMethod = "GET" | "POST" | "DELETE"

export interface RouteDefinition {
  readonly method: HttpMethod
  /** OpenAPI-style path with `{param}` placeholders. */
  readonly path: string
  readonly summary: string
  /** `undefined` for requests with no body. */
  readonly request?: z.ZodType
  /** `undefined` when the success response has no body — `DELETE` returns 204. */
  readonly response?: z.ZodType
  readonly successStatus: number
  /** Whether the caller must present an `ownerToken`. */
  readonly requiresOwnerToken: boolean
  /**
   * Whether replaying the identical request is safe.
   *
   * Load-bearing, not documentation: `POST /v1/tunnels` is the one endpoint where a blind retry
   * can create a second tunnel and burn a second lease against the caller's concurrency cap.
   */
  readonly idempotent: boolean
  /** Every error this route can return, so the generated docs and clients agree. */
  readonly errors: readonly ErrorCode[]
}

/** Errors any route can return, regardless of what it does. */
const UNIVERSAL_ERRORS = [
  "INVALID_REQUEST",
  "CLIENT_TOO_OLD",
  "RATE_LIMITED",
  "INTERNAL",
] as const satisfies readonly ErrorCode[]

/**
 * Routes **the deployment's front door answers itself**, present whatever role it runs.
 *
 * A third table, because `GET /v1/health` belongs to neither of the other two and putting it in either
 * would be a lie about who serves it. `apps/gateway` answers it and never forwards it — an uptime
 * monitor asking "is the front door open" must not have its answer depend on a service binding — so it
 * is not the node's route and not the registry's, even though both also mount one so their bindings can
 * be probed.
 *
 * **Why it is in the contract at all**: invariant 7 says the public API lives only here, and
 * `docs/API.md` has documented this endpoint as public since before the gateway existed. It was the one
 * public route no route table defined, which meant none of the three conformance tests covered it —
 * recorded as a gap when the gateway landed and closed here.
 *
 * Both generated documents include it, and that is not the duplication the two-document split exists to
 * avoid. Since ADR-0049 both carry the same `servers` entry, so a client of either API can call this
 * endpoint at the host its own document names. Saying so twice is accurate; omitting it from one would
 * describe a host that answers a route the document denies.
 */
export const SHARED_ROUTES = [
  {
    method: "GET",
    path: "/v1/health",
    summary: "Liveness of the deployment's front door.",
    response: healthResponseSchema,
    successStatus: 200,
    requiresOwnerToken: false,
    idempotent: true,
    // **No `errors`, and no client gate either.** This route is exempt from the version gate and the
    // rate limiter (`apps/gateway/CLAUDE.md` rule 6): an uptime monitor sends no NPort headers and has
    // to be able to tell a running-but-misconfigured deployment from a dead one.
    errors: [],
  },
] as const satisfies readonly RouteDefinition[]

export const ROUTES = [
  {
    method: "GET",
    path: "/v1/challenge",
    summary: "Issue a proof-of-work challenge.",
    response: challengeResponseSchema,
    successStatus: 200,
    requiresOwnerToken: false,
    idempotent: true,
    errors: [...UNIVERSAL_ERRORS],
  },
  {
    method: "POST",
    path: "/v1/tunnels",
    summary: "Claim a subdomain and provision a tunnel.",
    request: createTunnelRequestSchema,
    response: createTunnelResponseSchema,
    successStatus: 201,
    requiresOwnerToken: false,
    // The only non-idempotent route in the API. A retry may create a second tunnel, so clients
    // retry it only on 429/503 after Retry-After, or after a network error where no response was
    // seen — and then only with a fresh challenge.
    idempotent: false,
    errors: [
      ...UNIVERSAL_ERRORS,
      "INVALID_SUBDOMAIN",
      "POW_REQUIRED",
      "POW_INVALID",
      "CHALLENGE_EXPIRED",
      "SUBDOMAIN_RESERVED",
      "SUBDOMAIN_IN_USE",
      "DNS_CONFLICT",
      "CONCURRENCY_LIMIT",
      "CREATE_QUOTA_EXCEEDED",
      "CAPACITY_EXHAUSTED",
      "PROVISION_FAILED",
      "UPSTREAM_CLOUDFLARE_ERROR",
    ],
  },
  {
    method: "POST",
    path: "/v1/tunnels/{subdomain}/heartbeat",
    summary: "Renew a lease.",
    request: heartbeatRequestSchema,
    response: heartbeatResponseSchema,
    successStatus: 200,
    requiresOwnerToken: true,
    idempotent: true,
    errors: [...UNIVERSAL_ERRORS, "INVALID_OWNER_TOKEN", "TUNNEL_NOT_FOUND", "LEASE_EXPIRED"],
  },
  {
    method: "DELETE",
    path: "/v1/tunnels/{subdomain}",
    summary: "Release a lease and tear the tunnel down.",
    request: deleteTunnelRequestSchema,
    // 204: deleting an already-released lease succeeds. A client retrying after a network blip
    // must not see a failure for work that is already done.
    successStatus: 204,
    requiresOwnerToken: true,
    idempotent: true,
    errors: [
      ...UNIVERSAL_ERRORS,
      "INVALID_OWNER_TOKEN",
      "DNS_CONFLICT",
      "UPSTREAM_CLOUDFLARE_ERROR",
    ],
  },
  {
    method: "GET",
    path: "/v1/tunnels/{subdomain}",
    summary: "Public status for a subdomain. No secrets.",
    response: tunnelStatusResponseSchema,
    successStatus: 200,
    requiresOwnerToken: false,
    idempotent: true,
    errors: [...UNIVERSAL_ERRORS, "INVALID_SUBDOMAIN", "TUNNEL_NOT_FOUND"],
  },
  {
    method: "GET",
    path: "/v1/meta",
    summary: "Limits, minimum client version, and tunnel duration.",
    response: metaResponseSchema,
    successStatus: 200,
    requiresOwnerToken: false,
    idempotent: true,
    errors: [...UNIVERSAL_ERRORS],
  },
] as const satisfies readonly RouteDefinition[]

/**
 * The **registry's** routes — a different service, so a different table (ADR-0046, ADR-0049).
 *
 * `apps/registry` holds no Cloudflare credentials and provisions nothing (ADR-0031). It is a separate
 * deployable, and since ADR-0049 it is reached through the **same hostname** as the node, behind the
 * gateway. Two tables and two documents therefore no longer rest on "two hosts" — they rest on the two
 * properties that survived the move: the **path spaces are disjoint**, and each document carries only
 * the components it reaches. A node-only deployment has no registry binding at all, so `/v1/nodes*`
 * does not 404 there — it does not exist.
 *
 * **Every registry route lives under `/v1/nodes`**, and that is load-bearing rather than tidy. The
 * gateway dispatches on the path prefix, so a registry route outside this space would be unroutable —
 * and `GET /v1/challenge` in particular *cannot* be shared: `apps/registry/src/types.ts` requires its
 * `POW_SECRET` to differ from the node's, precisely so a challenge issued by a node is not redeemable
 * at the registry. Two endpoints signing with two secrets cannot share one path.
 */
export const REGISTRY_ROUTES = [
  {
    method: "GET",
    path: "/v1/nodes/challenge",
    summary: "Issue a proof-of-work challenge for a node registration.",
    response: challengeResponseSchema,
    successStatus: 200,
    requiresOwnerToken: false,
    idempotent: true,
    errors: [...UNIVERSAL_ERRORS],
  },
  {
    method: "GET",
    path: "/v1/nodes",
    summary: "The node directory. Advisory — clients cache it.",
    response: nodeListResponseSchema,
    successStatus: 200,
    requiresOwnerToken: false,
    idempotent: true,
    // No NO_NODE_AVAILABLE here: an empty directory is a 200 with an empty array. That code is
    // client-side, raised once discovery has exhausted the list, and the registry never sends it.
    errors: [...UNIVERSAL_ERRORS],
  },
  {
    method: "POST",
    path: "/v1/nodes",
    summary: "Register or refresh a node, behind proof of work and a DNS TXT domain proof.",
    request: registerNodeRequestSchema,
    response: registerNodeResponseSchema,
    successStatus: 201,
    // There is no `ownerToken` for a node. Authority to change an entry is re-proved on every call by
    // the TXT record, which is better than a bearer token an operator would have to store: it cannot
    // leak from a config file, and it is revoked by deleting a DNS record.
    requiresOwnerToken: false,
    // Its *effect* is an upsert, so re-registering is safe. Marked false anyway, for the same reason
    // `POST /v1/tunnels` is: a replayed request cannot succeed, because the challenge is single-use.
    // A caller that wants to try again calls the method again, which takes a fresh challenge.
    idempotent: false,
    errors: [
      ...UNIVERSAL_ERRORS,
      "POW_REQUIRED",
      "POW_INVALID",
      "CHALLENGE_EXPIRED",
      "REGISTRATION_REFUSED",
    ],
  },
] as const satisfies readonly RouteDefinition[]

/** `GET /v1/challenge` → the definition, for tests and for codegen. */
export function findRoute(method: HttpMethod, path: string): RouteDefinition | undefined {
  return ROUTES.find((route) => route.method === method && route.path === path)
}

/** The same lookup against the registry's table. */
export function findRegistryRoute(method: HttpMethod, path: string): RouteDefinition | undefined {
  return REGISTRY_ROUTES.find((route) => route.method === method && route.path === path)
}
