import { ApiError, readForwarded } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"

import type { Env, Variables } from "../types"

/**
 * Reads what the gateway worked out, instead of working it out again (ADR-0049).
 *
 * This replaces three middlewares that used to live here — `requestId`, `clientGate` and `rateLimit`.
 * All three were cross-cutting, all three existed in near-identical form in `apps/registry`, and none
 * of them could move to `packages/worker-kit`, whose boundary forbids reading a binding. A gateway in
 * front of both services can hold them once; this Worker just receives the results.
 *
 * The two values arrive as headers because Hono's context does not survive a service binding. Their
 * names come from `worker-kit` — the one part of this with no binding in it, and the one part where a
 * misspelling would be silent rather than loud (`packages/worker-kit/src/forwarded.ts`).
 */

export const forwarded: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  /**
   * The two paths that read no binding and need no identity, exempted for the same reason
   * `requireBindings` exempts them.
   *
   * `/v1/health` is answered by the gateway and never forwarded, but this Worker keeps its own so the
   * binding itself can be probed. `GET /` is a redirect for a human who typed the API host into a
   * browser — it must keep working on a Worker that is otherwise misconfigured, which is exactly what
   * failing it closed would prevent.
   */
  if (
    context.req.path === "/v1/health" ||
    (context.req.path === "/" && context.req.method === "GET")
  ) {
    await next()
    return
  }

  const { sourceHash, requestId } = readForwarded(context.req.raw.headers)

  /**
   * **Fail closed.** No source hash means the request did not come through the gateway — which should
   * be impossible, since this Worker declares no `routes` and is reachable only through its binding.
   * If it ever happens, serving the request would mean serving it with no per-source identity at all:
   * `SourceQuota` would have nothing to key on, and every cap in `docs/ARCHITECTURE.md` §7 would be
   * bypassed at once. Refusing is the only safe answer, and a loud one.
   *
   * The alternative — synthesising a hash here — is worse than it looks. It would work, quietly, and
   * every caller reaching the Worker directly would share one identity.
   */
  if (sourceHash === undefined) {
    console.error("request reached the node without a gateway", { path: context.req.path })
    throw new ApiError("INTERNAL")
  }

  context.set("sourceHash", sourceHash)
  // The gateway prefers `cf-ray`, so this is usually Cloudflare's own id and matches their logs.
  // A locally generated fallback keeps the field non-empty if the header is ever missing on its own.
  context.set("requestId", requestId ?? crypto.randomUUID())

  await next()
}
