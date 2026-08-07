import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

import { loadWranglerConfig } from "../../scripts/lib/wrangler-config.mjs"

/**
 * The limiter's own configured ceiling, read rather than repeated.
 *
 * `ratelimits` is not a `var`, so nothing in the isolate can see it, and the one test that asserts the
 * limiter *engages* has to send more than this many requests to prove anything. Hand-copying the number
 * is how that test silently stops testing when someone raises the limit — it would simply never trip
 * and never say so. This is the same arrangement `apps/node`'s abuse-control tests use for their caps.
 */
const limiter = loadWranglerConfig("apps/gateway/wrangler.jsonc").ratelimits?.find(
  (entry) => entry.name === "RATE_LIMITER",
)

if (typeof limiter?.simple?.limit !== "number") {
  throw new Error(
    "apps/gateway/wrangler.jsonc has no RATE_LIMITER limit — the rate tests are blind",
  )
}

/**
 * Real `workerd`, with the two internal services replaced by stubs.
 *
 * The gateway owns no storage — no Durable Object, no alarm — so `workerd` here buys something
 * different from what it buys `apps/node`: the `RateLimit` binding, `cf-ray`, and `Request` semantics
 * are the platform's own rather than a mock's. The rate limiter in particular has no npm equivalent,
 * and it is the one binding this Worker exists to apply.
 *
 * **`serviceBindings` answer with a plain handler**, so a test can see exactly what the gateway
 * forwarded — the headers it set, and the ones it must have overwritten. Binding to the real
 * `apps/node` would be an integration test of three Workers and would tell us less about this one:
 * the question here is *what does the gateway send*, not *what does the node do with it*.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only, and deliberately not the value either other app's tests use. Real values come
          // from Terraform and `wrangler secret bulk` (ADR-0040).
          IP_HASH_SECRET: "test-gateway-ip-hash-secret",
          // Pinned so a developer's `.dev.vars` cannot change what these tests mean — the pool reads
          // that file alongside `wrangler.jsonc`, which is how `apps/node` once had 36 tests fail for
          // a reason that had nothing to do with the code.
          MIN_CLIENT_VERSION: "3.0.0",
          // Not a binding the Worker reads — a fact about the binding it does read, handed to the
          // tests so they can size their loops from the real ceiling instead of a copy of it.
          RATE_LIMIT: limiter.simple.limit,
        },
        serviceBindings: {
          // Echo back what arrived, so an assertion can read the forwarded request rather than infer
          // it. Each names itself, which is how a test proves dispatch went to the *right* service —
          // a router that sent everything to `NODE` would otherwise pass every routing test.
          NODE: (request: Request) => echo("node", request),
          REGISTRY: (request: Request) => echo("registry", request),
        },
      },
    }),
  ],
})

async function echo(service: string, request: Request): Promise<Response> {
  return Response.json({
    service,
    method: request.method,
    path: new URL(request.url).pathname,
    requestId: request.headers.get("x-nport-request-id"),
    sourceHash: request.headers.get("x-nport-source-hash"),
  })
}
