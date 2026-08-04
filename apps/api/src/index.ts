/**
 * The NPort control plane.
 *
 * `docs/API.md` for the contract, `apps/api/CLAUDE.md` for the rules. Two that shape this file:
 * **no CORS headers, ever** — their absence is an abuse control, since it stops any web page
 * driving the API — and **no module-level mutable state**, because an isolate is shared across
 * callers and module scope is not per-request.
 *
 * **Phase 2a.** The stateless half plus the lease lifecycle. Still to land: per-source rate limits
 * and caps, dynamic proof-of-work difficulty, the reconciliation cron, and the legacy v2 shim.
 */

import { Hono } from "hono"

import { ApiError, envelope } from "./errors"
import { clientGate } from "./middleware/client-gate"
import { requestId } from "./middleware/request-id"
import { requireBindings } from "./middleware/require-bindings"
import { challengeRoute } from "./routes/challenge"
import { healthRoute } from "./routes/health"
import { metaRoute } from "./routes/meta"
import { tunnelsRoute } from "./routes/tunnels"
import type { Env, Variables } from "./types"

export { Registry } from "./do/registry"
export { SubdomainLease } from "./do/subdomain-lease"

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use("*", requestId)

// Bindings are checked before anything reads one, so a misconfiguration is a single clear log
// line rather than an opaque failure inside whichever primitive needed the value first. Health is
// excluded deliberately: an uptime monitor should still distinguish a running-but-misconfigured
// Worker from a dead one.
app.use("/v1/challenge", requireBindings)
app.use("/v1/meta", requireBindings)
app.use("/v1/tunnels", requireBindings)
app.use("/v1/tunnels/*", requireBindings)

// The gate runs on `/v1/*` only: `GET /` is a redirect for humans who typed the API host into a
// browser, and `/v1/health` is for monitoring, which sends no NPort client headers.
app.use("/v1/*", clientGate)

app.route("/v1/challenge", challengeRoute)
app.route("/v1/meta", metaRoute)
app.route("/v1/health", healthRoute)
app.route("/v1/tunnels", tunnelsRoute)

/** Matches v2. Some users hit the API root by hand. */
app.get("/", (context) => context.redirect("https://nport.link", 301))

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

  if (error instanceof ApiError) {
    const body = envelope(error, id)
    const headers: Record<string, string> = {}
    // Every 429 and 503 carries Retry-After, because docs/API.md tells clients to honour it and
    // a retryable error without one invites a tighter loop than the server wants.
    const retryAfter = error.details?.retryAfter
    if ((error.status === 429 || error.status === 503) && typeof retryAfter === "number") {
      headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfter)))
    }
    return context.json(body, error.status as 400, headers)
  }

  console.error("unhandled", { requestId: id, error: String(error) })
  return context.json(envelope(new ApiError("INTERNAL"), id), 500)
})

export default {
  fetch: app.fetch,

  /**
   * Reconciliation only — orphaned tunnels and DNS records with no lease. Expiry is driven by each
   * lease's own DO alarm, so throughput scales with tunnel count instead of with cron frequency
   * (v2 capped at ~10 per 30-minute run, defect R8).
   *
   * Lands with the Registry DO in the next slice.
   */
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Deliberately empty rather than absent: `wrangler.jsonc` declares the cron trigger, and a
    // missing handler is a deploy-time error rather than a no-op.
  },
}
