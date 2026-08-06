/**
 * The NPort control plane.
 *
 * `docs/API.md` for the contract, `apps/api/CLAUDE.md` for the rules. Two that shape this file:
 * **no CORS headers, ever** — their absence is an abuse control, since it stops any web page
 * driving the API — and **no module-level mutable state**, because an isolate is shared across
 * callers and module scope is not per-request.
 *
 * **Phase 2a complete.** The lease lifecycle, the abuse controls, the reconciliation cron, and the v2
 * compatibility shim.
 */

import { ApiError, envelope, retryAfterSeconds } from "@nport/worker-kit"
import { Hono } from "hono"
import { clientGate } from "./middleware/client-gate"
import { rateLimit } from "./middleware/rate-limit"
import { requestId } from "./middleware/request-id"
import { requireBindings } from "./middleware/require-bindings"
import { runScheduled } from "./reconcile"
import { registerWithRegistry } from "./register"
import { challengeRoute } from "./routes/challenge"
import { healthRoute } from "./routes/health"
import {
  isLegacyRequest,
  legacyEnvelope,
  legacyMethodNotAllowed,
  legacyRoute,
} from "./routes/legacy"
import { metaRoute } from "./routes/meta"
import { tunnelsRoute } from "./routes/tunnels"
import type { Env, Variables } from "./types"

export { Registry } from "./do/registry"
export { SourceQuota } from "./do/source-quota"
export { SubdomainLease } from "./do/subdomain-lease"

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use("*", requestId)

// Bindings are checked before anything reads one, so a misconfiguration is a single clear log
// line rather than an opaque failure inside whichever primitive needed the value first. Health is
// excluded deliberately: an uptime monitor should still distinguish a running-but-misconfigured
// Worker from a dead one.
// `/` carries the v2 shim on POST and DELETE, so it needs the same binding check as the v1 routes.
// Registered per method rather than on the path, because `GET /` is a browser redirect that reads no
// binding and must keep working on a misconfigured Worker.
app.post("/", requireBindings)
app.delete("/", requireBindings)

app.use("/v1/challenge", requireBindings)
app.use("/v1/meta", requireBindings)
app.use("/v1/tunnels", requireBindings)
app.use("/v1/tunnels/*", requireBindings)

// The gate runs on `/v1/*` only: `GET /` is a redirect for humans who typed the API host into a
// browser, and `/v1/health` is for monitoring, which sends no NPort client headers.
app.use("/v1/*", clientGate)

// After the client gate, so a request that never identified itself is refused before it costs a
// platform call — and before every route that reads storage, since the whole point of the outermost
// layer is to be the cheapest one.
//
// Registered on `/v1/*` rather than per route, like the client gate above. A per-route list is a
// standing invitation to add a route and forget the limiter, and the failure would be silent: the new
// route would simply be unprotected, and nothing would say so. `rateLimit` skips `/v1/health` itself.
app.use("/v1/*", rateLimit)

// **The shim gets the limiter too.** Without this, `POST /` would be an unlimited-abuse hole that
// bypasses the entire control stack except the global cap — and since a v2 client cannot solve a proof of
// work, this endpoint is already the cheapest way to create a tunnel that exists. It must at least be
// rate-limited and quota-bounded (`src/routes/legacy.ts`).
app.post("/", rateLimit)
app.delete("/", rateLimit)

app.route("/v1/challenge", challengeRoute)
app.route("/v1/meta", metaRoute)
app.route("/v1/health", healthRoute)
app.route("/v1/tunnels", tunnelsRoute)

/** Matches v2. Some users hit the API root by hand. */
app.get("/", (context) => context.redirect("https://nport.link", 301))

// The v2 compatibility shim. Registered after `GET /` so the redirect wins for browsers, and
// `legacyMethodNotAllowed` last so it only catches methods nothing else claimed.
app.route("/", legacyRoute)
app.route("/", legacyMethodNotAllowed)

app.notFound((context) =>
  context.json(envelope(new ApiError("INVALID_REQUEST"), context.get("requestId")), 400),
)

/**
 * The single place a failure becomes a response.
 *
 * An unrecognised throw becomes `INTERNAL` and the detail goes to logs only. v2 echoed raw
 * upstream text to anonymous callers, leaking account and zone internals (rule 8).
 */
app.onError((error, context) => {
  const id = context.get("requestId")
  // A 2.x client cannot read the v1 envelope. Failures raised in middleware — the rate limiter, the
  // binding check — never reach `src/routes/legacy.ts`, so the shape has to be chosen here or an old
  // client would print `[object Object]` where a message belongs.
  const legacy = isLegacyRequest(context.req.path, context.req.method)

  if (error instanceof ApiError) {
    const body = legacy ? legacyEnvelope(error.message) : envelope(error, id)
    const headers: Record<string, string> = {}
    // Every 429 and 503 that *can* say when carries Retry-After, because docs/API.md tells clients to
    // honour it and a retryable error without one invites a tighter loop than the server wants.
    //
    // **Two shapes, because two refusals count time differently.** `RATE_LIMITED` and
    // `CAPACITY_EXHAUSTED` carry `retryAfter` as a duration; `CREATE_QUOTA_EXCEEDED` carries `resetAt`
    // as an absolute instant, because the hourly window has a real edge and a client showing a
    // countdown wants that edge rather than a guess. Deriving the header from whichever is present
    // keeps the promise above true — it used to read `retryAfter` alone, so an hourly-quota refusal
    // went out with the moment it frees up in the body and **no header at all**, which is the one
    // field standard tooling and our own retry ladder actually look at.
    //
    // `CONCURRENCY_LIMIT` deliberately has neither: waiting does not help, closing a tunnel does, and
    // a `Retry-After` there would invite exactly the loop it should discourage.
    const seconds = retryAfterSeconds(error.details, Date.now())
    if ((error.status === 429 || error.status === 503) && seconds !== undefined) {
      headers["retry-after"] = String(seconds)
    }
    return context.json(body, error.status as 400, headers)
  }

  console.error("unhandled", { requestId: id, error: String(error) })
  const internal = new ApiError("INTERNAL")
  return context.json(legacy ? legacyEnvelope(internal.message) : envelope(internal, id), 500)
})

export default {
  fetch: app.fetch,

  /**
   * Two jobs, in this order: reconcile, then re-announce.
   *
   * **Reconciliation** reaps orphaned tunnels with no lease. Expiry itself is driven by each lease's
   * own alarm, so throughput scales with tunnel count rather than with cron frequency (v2 capped at
   * ~10 per 30-minute run, defect R8). `src/reconcile.ts` holds the reasoning about what may be
   * deleted.
   *
   * **Self-registration** tells the directory this node exists, and is a no-op unless `REGISTRY_URL`
   * is set (ADR-0031). `src/register.ts` explains why it is a schedule rather than a boot-time task.
   *
   * Reconciliation goes first because it is the job that protects something — a leaked tunnel costs a
   * DNS record and a slot — while a missed registration costs a listing this node can live without.
   * Awaited in sequence rather than raced so the two do not contend for the subrequest budget, and so
   * the registration's ~1.2 s of solve CPU cannot delay the sweep.
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env)
    // Never allowed to fail the invocation: `registerWithRegistry` catches everything itself, and the
    // reason is right there — a cron that threw here would abandon nothing, but a future edit that
    // let it throw *before* the sweep would.
    await registerWithRegistry(env)
  },
}
