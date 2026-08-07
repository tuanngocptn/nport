import {
  ApiError,
  envelope,
  FORWARDED_REQUEST_ID,
  FORWARDED_SOURCE_HASH,
  retryAfterSeconds,
} from "@nport/worker-kit"
import { Hono } from "hono"

import { requireBindings } from "./env"
import { clientGate } from "./middleware/client-gate"
import { rateLimit } from "./middleware/rate-limit"
import { requestId } from "./middleware/request-id"
import type { Env, ServiceBinding, Variables } from "./types"

/**
 * The public front door (ADR-0049).
 *
 * **The only Worker in a deployment with a route.** `apps/node` and `apps/registry` declare none and
 * set `workers_dev: false`, so they are reachable through their service bindings and nowhere else.
 * That is what lets this file own every cross-cutting concern once instead of each service owning a
 * copy — the arrangement `packages/worker-kit` (ADR-0047) started and could not finish, because
 * middleware reads bindings and worker-kit's boundary forbids that.
 *
 * ## Dispatch is by path prefix, and that is a contract
 *
 * ```
 *   /v1/nodes*   →  REGISTRY   (absent on a node-only deployment)
 *   /v1/*        →  NODE
 *   /v1/health   →  answered here
 *   /            →  301 to the site
 * ```
 *
 * `packages/contract` keeps the two route tables disjoint and each app's `apps/gateway/test/conformance.test.ts` proves
 * its Worker stays inside its own space, so this table is short because the contract made it short.
 * A registry route outside `/v1/nodes` would be one no request could reach.
 *
 * ## What this deployment does not serve
 *
 * **The v2 compatibility shim is not routed.** `apps/node` still carries `POST /` and `DELETE /` from
 * `apps/node/src/routes/legacy.ts`, with its tests still passing, but nothing forwards `/` here — so behind a
 * gateway those routes are unreachable. That is a deliberate, temporary gap: v3 first, backward
 * compatibility later. It is written down in three places rather than left to be discovered, because
 * tested-but-unreachable code is precisely the failure this repository has spent seven defects
 * removing — `docs/ROADMAP.md` § Backend first, `apps/node`'s own module docs, and the skipped test in
 * `test/legacy-gap.test.ts` that turns back on the day `/` is routed.
 */
const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use("*", requestId)

// Before anything reads a binding, so a misconfiguration is one clear line rather than a failure
// inside whichever primitive reached for the value first. Inside the app, so it gets an envelope.
app.use("*", requireBindings)

// `/v1/*` rather than per route, so a route added downstream cannot be left ungated. Both middlewares
// skip `/v1/health` themselves — an uptime monitor sends no NPort headers and must not be rate-limited
// out of existence.
app.use("/v1/*", clientGate)
app.use("/v1/*", rateLimit)

/**
 * Answered here, not forwarded.
 *
 * A health check that traversed a service binding would report on the binding as much as on the
 * gateway, and an uptime monitor wants to know whether the front door is open. Each internal service
 * keeps its own `/v1/health` for the same reason, reachable through its binding.
 */
app.get("/v1/health", (context) => context.json({ status: "ok" }))

/** Matches what `api.nport.link` did before the split: people hit an API host by hand. */
app.get("/", (context) => context.redirect("https://nport.link", 301))

app.all("/v1/nodes", (context) => forward(context.env.REGISTRY, context, "registry"))
app.all("/v1/nodes/*", (context) => forward(context.env.REGISTRY, context, "registry"))
app.all("/v1/*", (context) => forward(context.env.NODE, context, "node"))

app.notFound((context) =>
  context.json(envelope(new ApiError("INVALID_REQUEST"), context.get("requestId")), 400),
)

app.onError((error, context) => {
  const failure = error instanceof ApiError ? error : new ApiError("INTERNAL")
  if (!(error instanceof ApiError)) {
    console.error("gateway failed", { error: String(error), path: context.req.path })
  }
  const body = envelope(failure, context.get("requestId"))
  const headers: Record<string, string> = {}
  // Only the rate limiter raises a retryable failure here — the gateway holds no capacity of its own.
  // `as 400` matches `apps/node`: Hono narrows the status to its own literal union, and `ApiError`
  // already constrains `status` to codes the registry defines.
  const seconds = retryAfterSeconds(failure.details, Date.now())
  if ((failure.status === 429 || failure.status === 503) && seconds !== undefined) {
    headers["retry-after"] = String(seconds)
  }
  return context.json(body, failure.status as 400, headers)
})

/**
 * Hands a request to an internal service.
 *
 * The request is rebuilt rather than passed through, for one reason worth stating: **the forwarded
 * headers must be set by us and not inherited from the caller.** A client that sent its own
 * `x-nport-source-hash` would otherwise choose its own identity and walk past every per-source cap in
 * `SourceQuota`. `Request`'s constructor copies headers, so they are overwritten explicitly after.
 */
async function forward(
  service: ServiceBinding | undefined,
  context: { req: { raw: Request }; env: Env; get: (key: "requestId" | "sourceHash") => string },
  name: string,
): Promise<Response> {
  if (service === undefined) {
    // A node-only deployment reached for the registry. Not a 404 by accident — the path genuinely does
    // not exist here, and saying so is more useful than a generic failure.
    console.warn("no binding for this path", { service: name })
    throw new ApiError("INVALID_REQUEST")
  }

  const forwarded = new Request(context.req.raw)
  forwarded.headers.set(FORWARDED_REQUEST_ID, context.get("requestId"))
  // Absent on `/v1/health`, which the rate limiter skips — and which never reaches this function.
  const hash = context.get("sourceHash")
  if (hash) forwarded.headers.set(FORWARDED_SOURCE_HASH, hash)

  return service.fetch(forwarded)
}

export { app }

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
