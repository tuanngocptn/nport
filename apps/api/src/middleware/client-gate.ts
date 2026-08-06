import { ApiError, compareVersions, parseVersion } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"
import type { Env, Variables } from "../types"

/**
 * Requires client identification and enforces a minimum version.
 *
 * **Not authentication** — there are no accounts (ADR-0007), and anyone can send any header. It
 * exists because NPort now owns the connector protocol: when Cloudflare's edge changes, installed
 * clients break in ways only a new binary can fix, and this is the only channel for saying so
 * (`docs/API.md` § Client requirements).
 */
export const clientGate: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  // Health is for uptime monitors, which send no NPort headers and must not be gated behind a
  // client version — a monitor that starts failing on a version bump reports the wrong outage.
  if (context.req.path === "/v1/health") {
    await next()
    return
  }

  const agent = context.req.header("user-agent") ?? ""
  const version = parseVersion(agent)
  if (version === undefined) {
    // A missing or unparseable User-Agent is INVALID_REQUEST, not CLIENT_TOO_OLD: we do not know
    // that it is old, only that it did not identify itself.
    throw new ApiError("INVALID_REQUEST", { reason: "unrecognised client" })
  }

  const minimum = String(context.env.MIN_CLIENT_VERSION)
  if (compareVersions(version, minimum) < 0) {
    throw new ApiError("CLIENT_TOO_OLD", { minimumVersion: minimum })
  }

  await next()
}
