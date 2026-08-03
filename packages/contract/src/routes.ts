/**
 * Route definitions: method, path, what each carries, and which errors it can return.
 *
 * This table is what `pnpm codegen` walks to emit `schema/nport-api.openapi.json`. Keeping it as
 * data rather than as decorators on Hono handlers means the OpenAPI document can be generated
 * without importing the Worker, so codegen has no dependency on `workerd` or on any binding.
 */

import type { z } from "zod"

import type { ErrorCode } from "./errors"
import {
  challengeResponseSchema,
  createTunnelRequestSchema,
  createTunnelResponseSchema,
  deleteTunnelRequestSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  metaResponseSchema,
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

/** `GET /v1/challenge` → the definition, for tests and for codegen. */
export function findRoute(method: HttpMethod, path: string): RouteDefinition | undefined {
  return ROUTES.find((route) => route.method === method && route.path === path)
}
