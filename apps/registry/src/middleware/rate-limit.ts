import { ApiError, sourceHash } from "@nport/worker-kit"
import type { MiddlewareHandler } from "hono"

import type { Env, Variables } from "../types"

/**
 * Per-source request-rate limiting, the outermost control this Worker has.
 *
 * The registry's write path is proof-of-work gated, so this is not the only thing standing between an
 * abuser and a registration — but the *read* path is not, and `GET /v1/nodes` is the endpoint every
 * client polls. One platform call, no storage, evaluated before any Durable Object is touched.
 *
 * **Keyed on `HMAC(ip, secret)` over the address prefix and ASN, never a raw IP**, and the function is
 * the one `apps/api` uses (ADR-0047). That matters more than the code saving: keying on a full IPv6
 * address rather than its /64 silently removes the limit for anyone on IPv6, because a client owns at
 * least 2^64 addresses — `docs/ROADMAP.md`'s defect 9, which a second implementation here would have
 * been free to reintroduce.
 */
export const rateLimit: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  context,
  next,
) => {
  // Health is for uptime monitors, which poll on a fixed schedule and must not be able to rate-limit
  // themselves out of existence. It reads no storage and takes no bindings.
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
    // else), so the honest `Retry-After` is the window itself.
    throw new ApiError("RATE_LIMITED", { retryAfter: 60 })
  }

  await next()
}
