import { REGISTRY_ROUTES } from "@nport/contract"
import { describe, expect, it } from "vitest"

import { createApp } from "../src/index"

/**
 * This Worker serves every route the contract says it does, and nothing outside its path space.
 *
 * The sibling of `apps/node/test/conformance.test.ts`, and the one that has already earned its keep:
 * the registry's challenge moved to `/v1/nodes/challenge` in `packages/contract` and stayed at
 * `/v1/challenge` here, with all 45 of this app's tests still green — because every one of them calls
 * `app.request("/v1/challenge")` and so tests the implementation against itself.
 *
 * Read from Hono's registration table, not by issuing requests: `400 INVALID_REQUEST` comes back both
 * from `app.notFound` and from a mounted handler rejecting an empty body, so a request cannot tell a
 * missing route from a present one.
 */

const app = createApp()

function registered(): Set<string> {
  return new Set(app.routes.map((route) => `${route.method} ${route.path}`))
}

describe("the registry and its contract", () => {
  it("serves every route in REGISTRY_ROUTES", () => {
    const mounted = registered()
    const missing = REGISTRY_ROUTES.map((route) => `${route.method} ${route.path}`).filter(
      (signature) => !mounted.has(signature),
    )
    expect(missing, `${missing.length} contract route(s) not mounted`).toEqual([])
  })

  it("keeps every route it serves under /v1/nodes", () => {
    // Load-bearing, not tidy: the gateway dispatches on the path prefix (ADR-0049), so a registry
    // route outside this space is one no request can reach. `/v1/health` and `/` are the exceptions —
    // the gateway answers those itself and never forwards them.
    const stray = app.routes
      // Handlers only. `app.use` registers as method `ALL`, so the middleware wildcards (`/v1/*`,
      // `*`) show up here too and are not routes anyone requests.
      .filter((route) => route.method !== "ALL")
      .map((route) => route.path)
      .filter((path) => path.startsWith("/v1/") && !path.startsWith("/v1/nodes"))
      .filter((path) => path !== "/v1/health")
    expect(stray, "registry routes outside /v1/nodes are unroutable behind the gateway").toEqual([])
  })

  it("is actually reading a route table", () => {
    expect(app.routes.length).toBeGreaterThan(REGISTRY_ROUTES.length)
  })
})
