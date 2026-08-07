/**
 * The NPort node directory.
 *
 * `docs/API.md` § The registry API for the contract, `apps/registry/CLAUDE.md` for the rules. What
 * shapes this file is what the registry deliberately *is not*: it holds no Cloudflare credentials,
 * provisions nothing, and never touches a tunnel (ADR-0031). There is no saga here, no lease, and no
 * compensation — the whole Worker is a list, a probe, and two ways to read or change the list.
 *
 * **No CORS headers, ever**, for the same reason `apps/api` has none: their absence stops any web page
 * driving the API, which is an abuse control rather than an oversight.
 *
 * **The list is advisory.** A client caches it, so a registry that is down costs nothing — that is the
 * property which lets a single directory not be a single point of failure, and it is the one to
 * protect if any of this is ever revised.
 */

import { ApiError, envelope, retryAfterSeconds } from "@nport/worker-kit"
import { Hono } from "hono"

import { clientGate } from "./middleware/client-gate"
import { rateLimit } from "./middleware/rate-limit"
import { requestId } from "./middleware/request-id"
import { requireBindings } from "./middleware/require-bindings"
import { runScheduled } from "./probe"
import { challengeRoute } from "./routes/challenge"
import { healthRoute } from "./routes/health"
import { createNodesRoute } from "./routes/nodes"
import type { Env, Variables } from "./types"

export { Directory } from "./do/directory"

/**
 * The whole Worker, with its one outbound dependency injected.
 *
 * A factory rather than a module-level `app` so tests drive **this** app rather than a hand-assembled
 * copy of its middleware stack. That distinction has bitten this repo before: `docs/ROADMAP.md`'s
 * defect 25 was a test that passed with the call site reverted, because it exercised a helper and
 * never checked that anything used it. A test app wired by hand is the same trap — it would keep
 * passing after someone removed `clientGate` from the real one.
 */
export function createApp(fetcher: typeof fetch = fetch) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>()

  app.use("*", requestId)

  // Bindings are checked before anything reads one, so a misconfiguration is a single clear log line
  // rather than an opaque failure inside whichever primitive needed the value first. `/v1/health` is
  // excluded deliberately: an uptime monitor should still distinguish a running-but-misconfigured
  // Worker from a dead one.
  app.use("/v1/nodes", requireBindings)
  app.use("/v1/nodes/*", requireBindings)

  // Registered on `/v1/*` rather than per route, so adding a route cannot silently leave it ungated.
  // A per-route list is a standing invitation to forget one, and the failure would be invisible.
  // Both middlewares skip `/v1/health` themselves.
  app.use("/v1/*", clientGate)
  app.use("/v1/*", rateLimit)

  // **`/v1/nodes/challenge` before `/v1/nodes`**, and every registry route under that one prefix
  // (ADR-0049). The gateway dispatches on the path prefix, so a route outside it is unreachable — and
  // the challenge in particular cannot sit at `/v1/challenge` any more: the node serves one there
  // signed with a different `POW_SECRET`, deliberately, so that a node's challenge is not redeemable
  // here. Two secrets cannot share one path once both services answer on one hostname.
  app.route("/v1/nodes/challenge", challengeRoute)
  app.route("/v1/nodes", createNodesRoute(fetcher))
  app.route("/v1/health", healthRoute)

  /** Matches `apps/api`: some people hit an API host by hand. */
  app.get("/", (context) => context.redirect("https://nport.link", 301))

  app.notFound((context) =>
    context.json(envelope(new ApiError("INVALID_REQUEST"), context.get("requestId")), 400),
  )

  /**
   * The single place a failure becomes a response.
   *
   * An unrecognised throw becomes `INTERNAL` and the detail goes to logs only. Simpler than
   * `apps/api`'s, which also has to pick between two envelope shapes for the v2 shim — the registry has
   * no legacy clients, because it has never had a release.
   */
  app.onError((error, context) => {
    const id = context.get("requestId")

    if (error instanceof ApiError) {
      const headers: Record<string, string> = {}
      // Every 429 and 503 that can say when it frees up says so, because `docs/API.md` tells clients to
      // honour the header and a retryable refusal without one invites a tighter loop than we want.
      const seconds = retryAfterSeconds(error.details, Date.now())
      if ((error.status === 429 || error.status === 503) && seconds !== undefined) {
        headers["retry-after"] = String(seconds)
      }
      return context.json(envelope(error, id), error.status as 400, headers)
    }

    console.error("unhandled", { requestId: id, error: String(error) })
    return context.json(envelope(new ApiError("INTERNAL"), id), 500)
  })

  return app
}

const app = createApp()

export default {
  fetch: app.fetch,

  /**
   * Probe every listed node and delist the long-dead. `src/probe.ts` holds the policy.
   *
   * This is the only thing keeping the directory honest: a node's entry is a claim that goes stale
   * without telling anyone.
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env)
  },
}
