import { ROUTES } from "@nport/contract"
import { describe, expect, it } from "vitest"

import { app } from "../src/index"

/**
 * This Worker serves every route the contract says it does, and nothing from the registry's space.
 *
 * **Nothing checked this before.** `packages/contract` is the authority (invariant 7), and the only
 * things verifying it were the generated OpenAPI documents — which describe the contract to itself. A
 * route could be renamed in the table and left alone in the app, and the entire suite stayed green;
 * that is exactly what happened when the registry's challenge moved to `/v1/nodes/challenge`.
 *
 * Read from Hono's own registration table rather than by issuing requests, because a request cannot
 * distinguish "this route is not mounted" from "this route is mounted and rejected my empty body" —
 * both come back as `400 INVALID_REQUEST`, the first from `app.notFound` and the second from the
 * handler. The router's table has no such ambiguity.
 */

/** `/v1/tunnels/{subdomain}` in the contract is `/v1/tunnels/:subdomain` in Hono. */
function toHonoPath(path: string): string {
  return path.replaceAll(/\{(\w+)\}/g, ":$1")
}

/** What Hono says it routes, as `METHOD path`. */
function registered(): Set<string> {
  return new Set(app.routes.map((route) => `${route.method} ${route.path}`))
}

describe("the control plane and its contract", () => {
  it("serves every route in ROUTES", () => {
    const mounted = registered()
    const missing = ROUTES.map((route) => `${route.method} ${toHonoPath(route.path)}`).filter(
      (signature) => !mounted.has(signature),
    )
    expect(missing, `${missing.length} contract route(s) not mounted`).toEqual([])
  })

  it("claims no route in the registry's path space", () => {
    // The gateway dispatches on the path prefix (ADR-0049), so a node route under `/v1/nodes` would be
    // shadowed by the registry on a master deployment and unreachable on a node-only one.
    const trespassing = app.routes
      .map((route) => route.path)
      .filter((path) => path.startsWith("/v1/nodes"))
    expect(trespassing).toEqual([])
  })

  it("is actually reading a route table", () => {
    // A `routes` array that went empty would make both assertions above vacuous.
    expect(app.routes.length).toBeGreaterThan(ROUTES.length)
  })
})
