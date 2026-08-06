import { ApiError } from "@nport/worker-kit"
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

/**
 * Extracts the version from `nport/<version> (<os>; <arch>)`.
 *
 * Anchored to the start so a hostile UA cannot smuggle a high version in a comment. Pre-release
 * suffixes are kept, because `3.0.0-beta.1` must be distinguishable from `3.0.0`.
 */
export function parseVersion(userAgent: string): string | undefined {
  const match = /^nport\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(userAgent)
  return match?.[1]
}

/**
 * Semver-ish comparison: -1, 0, or 1.
 *
 * Only what the gate needs — numeric triples plus the rule that any pre-release sorts *below* the
 * release it precedes. That last part matters at a release boundary: without it `3.0.0-beta.1`
 * would satisfy a `3.0.0` floor, letting every beta client through after the floor moves.
 */
export function compareVersions(left: string, right: string): number {
  const split = (version: string) => {
    const [core = "", pre] = version.split("-", 2)
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0)
    return { parts, pre }
  }

  const a = split(left)
  const b = split(right)

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }

  if (a.pre === undefined && b.pre === undefined) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre === b.pre ? 0 : a.pre < b.pre ? -1 : 1
}
