import { ApiError } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"
import { sourceHash } from "../domain/ip-hash"
import type { Env, Variables } from "../types"

/**
 * Per-source request-rate limiting, the outermost of the layered controls.
 *
 * `docs/ARCHITECTURE.md` §7 lists four layers below the edge, and this is the cheapest: one platform
 * call, no storage, evaluated before anything reads a Durable Object. It bounds request *rate*; the
 * per-source caps in `SourceQuota` bound how many tunnels a source may hold and create, and
 * proof-of-work bounds what a create costs. None of the three substitutes for the others.
 *
 * **Keyed on `HMAC(ip, secret)` + ASN, never a raw IP** (rule 11). Cloudflare's rate limiter only ever
 * sees the hash, so the platform's own counters hold no address either.
 *
 * The source hash is computed once here and stashed on the request context, because the create path
 * needs the same value to address the caller's `SourceQuota` object. Hashing it twice would be two
 * HMACs and — worse — two chances for the inputs to diverge and give one caller two identities.
 */
export const rateLimit: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  // Health is for uptime monitors, which poll on a fixed schedule and must not be able to rate-limit
  // themselves out of existence. It reads no storage and takes no bindings, so it costs nothing to
  // leave open. Same exemption, and the same reasoning, as the client gate.
  if (context.req.path === "/v1/health") {
    await next()
    return
  }

  const ip = context.req.header("cf-connecting-ip") ?? "unknown"
  const hash = await sourceHash(
    context.env.IP_HASH_SECRET,
    ip,
    // `cf` is typed `unknown` on the global `Request` Hono exposes, so `IncomingRequestCfProperties`
    // is not visible here. `asn` is a number when present.
    context.req.raw.cf?.asn as number | undefined,
  )
  context.set("sourceHash", hash)

  const { success } = await context.env.RATE_LIMITER.limit({ key: hash })
  if (!success) {
    // The binding's window is a platform constant (10 s or 60 s — the config schema permits nothing
    // else), so the honest `Retry-After` is the window itself. `docs/API.md` tells clients to honour
    // it rather than running a tighter loop.
    throw new ApiError("RATE_LIMITED", { retryAfter: 60 })
  }

  await next()
}
