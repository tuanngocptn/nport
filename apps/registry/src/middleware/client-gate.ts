import { ApiError, compareVersions, parseVersion } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"

import type { Env, Variables } from "../types"

/**
 * Requires client identification and enforces a minimum version.
 *
 * **Not authentication** — there are no accounts (ADR-0007), and anyone can send any header. It exists
 * because NPort owns the connector protocol: when Cloudflare's edge changes, installed clients break
 * in ways only a new binary can fix, and this is the only channel for saying so.
 *
 * The two functions that decide the answer are shared with `apps/api` (ADR-0047) — the middleware is
 * not, because it reads a binding. Pre-release ordering is the subtle part and one implementation of
 * it is the point: two would mean one service admitting a client the other refuses.
 *
 * **This gate applies to a *node* registering, too**, which is worth stating because a node is not a
 * `cli` or a `desktop`. `apps/api` self-registers by calling `POST /v1/nodes`, so it identifies itself
 * with the same `nport/<version>` User-Agent shape. That is deliberate: a node running a build too old
 * to be trusted with the current contract is exactly as unwelcome as an old CLI.
 */
export const clientGate: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  // Health is for uptime monitors, which send no NPort headers and must not be gated behind a client
  // version — a monitor that starts failing on a version bump reports the wrong outage.
  if (context.req.path === "/v1/health") {
    await next()
    return
  }

  const version = parseVersion(context.req.header("user-agent") ?? "")
  if (version === undefined) {
    // A missing or unparseable User-Agent is INVALID_REQUEST, not CLIENT_TOO_OLD: we do not know that
    // it is old, only that it did not identify itself.
    throw new ApiError("INVALID_REQUEST", { reason: "unrecognised client" })
  }

  const minimum = String(context.env.MIN_CLIENT_VERSION)
  if (compareVersions(version, minimum) < 0) {
    throw new ApiError("CLIENT_TOO_OLD", { minimumVersion: minimum })
  }

  await next()
}
