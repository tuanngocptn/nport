/**
 * Request and response schemas — **the authority for every field in the API**.
 *
 * `docs/API.md` deliberately documents no field types: it covers lifecycle, semantics, and
 * intent, and points here for the shapes. v2's `docs/API.md` restated every field in prose and
 * drifted immediately, documenting `subdomain` and `tunnelId` as required for DELETE when both
 * were optional in the code.
 *
 * `apps/api` validates with these exact objects via `@hono/zod-validator`, and `pnpm codegen`
 * turns them into `schema/nport-api.openapi.json` and then `crates/contract`. One definition,
 * so runtime validation and generated types cannot disagree (ADR-0009).
 */

import { z } from "zod"

import { ERROR_CODES } from "./errors"
import { MAX_INPUT_LENGTH, MAX_LENGTH, MIN_LENGTH } from "./subdomain"

/**
 * A requested subdomain, as the user typed it.
 *
 * **Not validated here beyond a length sanity check.** Normalization has to run first — `MyApp`
 * and `myapp.nport.link` are legal input for the same claim — and a zod `regex` would reject
 * both. `apps/api` calls `checkSubdomain` after parsing and raises `INVALID_SUBDOMAIN` with a
 * `reason`, which is a far better error than "string does not match pattern".
 *
 * The bound here exists only to stop a megabyte of text reaching the normalizer. `.nport.link`
 * is 11 characters, and someone may paste it twice.
 */
export const requestedSubdomainSchema = z
  .string()
  .min(1)
  .max(MAX_INPUT_LENGTH)
  .describe("Desired subdomain. Normalized server-side; omit to have one generated.")

/**
 * Bounds on the credential-shaped inputs, for the same reason `requestedSubdomainSchema` has one.
 *
 * Every one of these is hashed before anything about it is trusted — the challenge is HMAC-verified,
 * the nonce is fed to SHA-256 with it, and an `ownerToken` is SHA-256'd and compared. So an unbounded
 * one is a request that costs the sender bandwidth and the server proportional CPU, ahead of any check
 * that could reject it. The values themselves are small and fixed by their own construction:
 *
 * - a challenge is `base64url(payload).base64url(hmac)`, about 120 characters;
 * - a nonce is a decimal integer, at most 10 digits for the 32-bit maximum difficulty;
 * - an `ownerToken` is 32 bytes of base64url, exactly 43 characters.
 *
 * The numbers below are two to five times each of those: room for the shapes to change, none for a
 * megabyte. They are a resource bound, not a format check — the format is enforced by verifying.
 */
export const MAX_CHALLENGE_LENGTH = 512
export const MAX_NONCE_LENGTH = 64
export const MAX_OWNER_TOKEN_LENGTH = 128

/** A 256-bit bearer proof, as the client presents it. Compared by hash, never stored in the clear. */
export const ownerTokenSchema = z
  .string()
  .min(1)
  .max(MAX_OWNER_TOKEN_LENGTH)
  .describe("The `ownerToken` returned when the tunnel was created.")

/** A normalized, validated subdomain, as it appears in responses. */
export const subdomainSchema = z
  .string()
  .min(MIN_LENGTH)
  .max(MAX_LENGTH)
  .describe("The normalized subdomain that was claimed.")

/** Milliseconds since the Unix epoch. */
export const timestampSchema = z
  .number()
  .int()
  .positive()
  .describe("Milliseconds since the Unix epoch, UTC.")

/**
 * Client identity, required on every request.
 *
 * Not authentication — there are no accounts (ADR-0007). It exists so the minimum-version gate
 * can work, which matters more here than in most APIs: NPort owns the connector protocol now, so
 * when Cloudflare's edge changes, old clients break in ways only a new binary can fix, and this
 * is the only channel for telling them so.
 */
export const clientKindSchema = z.enum(["cli", "desktop"]).describe("Which client is calling.")

// ── GET /v1/challenge ──────────────────────────────────────────────────────────────

export const challengeResponseSchema = z
  .object({
    challenge: z
      .string()
      .describe("Opaque, HMAC-signed, self-validating. Nothing is stored server-side."),
    difficulty: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Required leading zero bits. Raised under load."),
    expiresAt: timestampSchema.describe("After this, solving it is pointless."),
  })
  .describe("A stateless proof-of-work challenge.")

// ── POST /v1/tunnels ───────────────────────────────────────────────────────────────

export const createTunnelRequestSchema = z
  .object({
    subdomain: requestedSubdomainSchema.optional(),
    // Bounded for the same reason `requestedSubdomainSchema` is, and it was missed here: both are
    // hashed before anything about them is trusted, so an unbounded one is a request that costs the
    // sender bandwidth and the server CPU. A challenge is ~120 characters and a nonce is a decimal
    // integer; these leave room for both to grow without leaving room for a megabyte.
    challenge: z
      .string()
      .max(MAX_CHALLENGE_LENGTH)
      .describe("The `challenge` value from `GET /v1/challenge`."),
    nonce: z
      .string()
      .max(MAX_NONCE_LENGTH)
      .describe("A solution satisfying the challenge's difficulty."),
    client: clientKindSchema,
  })
  .describe("Claim a subdomain and provision a tunnel.")

export const createTunnelResponseSchema = z
  .object({
    subdomain: subdomainSchema,
    url: z
      .string()
      .url()
      .describe("The public HTTPS URL. Ready within a few seconds, not instantly."),
    tunnelId: z.string().uuid().describe("Cloudflare's tunnel UUID."),
    /**
     * Returned once and never retrievable. Note the deliberate absence of any endpoint that
     * hands it back: an API that can re-issue a credential to an anonymous caller has no
     * ownership model at all.
     */
    tunnelToken: z
      .string()
      .describe("Connector credential. Returned ONCE. Never logged, never in argv."),
    ownerToken: z
      .string()
      .describe("256-bit bearer proof for this lease. Returned ONCE; only its SHA-256 is stored."),
    expiresAt: timestampSchema.describe("Server-authoritative. The client only displays it."),
  })
  .describe("A provisioned tunnel. Both tokens are shown exactly once.")

// ── POST /v1/tunnels/:subdomain/heartbeat ──────────────────────────────────────────

export const heartbeatRequestSchema = z
  .object({
    ownerToken: ownerTokenSchema.describe("Proves this caller created the lease."),
  })
  .describe("Renew a lease.")

export const heartbeatResponseSchema = z
  .object({
    expiresAt: timestampSchema.describe(
      "Authoritative. Clients correct their countdown from this rather than counting locally.",
    ),
  })
  .describe("The lease's current expiry.")

// ── DELETE /v1/tunnels/:subdomain ──────────────────────────────────────────────────

export const deleteTunnelRequestSchema = z
  .object({
    ownerToken: ownerTokenSchema,
  })
  .describe("Release a lease and tear the tunnel down. Idempotent.")

// ── GET /v1/tunnels/:subdomain ─────────────────────────────────────────────────────

export const tunnelStatusResponseSchema = z
  .object({
    subdomain: subdomainSchema,
    /** No secrets, no tunnel ID, no owner hash — this endpoint is unauthenticated. */
    active: z.boolean(),
    expiresAt: timestampSchema.optional(),
  })
  .describe("Public status. Deliberately carries nothing an attacker could use.")

// ── GET /v1/meta ───────────────────────────────────────────────────────────────────

export const metaResponseSchema = z
  .object({
    minClientVersion: z.string().describe("Below this, requests get 426 CLIENT_TOO_OLD."),
    tunnelDurationMs: z.number().int().positive(),
    heartbeatIntervalMs: z.number().int().positive(),
    powDifficulty: z.number().int().min(1).max(32),
    maxConcurrentPerSource: z.number().int().positive(),
    maxCreatesPerHourPerSource: z.number().int().positive(),
  })
  .describe(
    "Limits, discovered rather than hardcoded, so they can be tuned without a client release.",
  )

// ── Errors ─────────────────────────────────────────────────────────────────────────

export const errorCodeSchema = z
  .enum(ERROR_CODES as [string, ...string[]])
  .describe("Stable code. Branch on this, never on `message`.")

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      message: z.string().describe("Human-readable. May change freely; do not match on it."),
      details: z.record(z.string(), z.unknown()).optional().describe("Code-specific."),
      requestId: z.string().describe("Quote this in a bug report."),
      docsUrl: z.string().url(),
    }),
  })
  .describe("The single error envelope for every failure. ADR-0018.")

export type ChallengeResponse = z.infer<typeof challengeResponseSchema>
export type CreateTunnelRequest = z.infer<typeof createTunnelRequestSchema>
export type CreateTunnelResponse = z.infer<typeof createTunnelResponseSchema>
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>
export type DeleteTunnelRequest = z.infer<typeof deleteTunnelRequestSchema>
export type TunnelStatusResponse = z.infer<typeof tunnelStatusResponseSchema>
export type MetaResponse = z.infer<typeof metaResponseSchema>
export type ErrorResponse = z.infer<typeof errorResponseSchema>
