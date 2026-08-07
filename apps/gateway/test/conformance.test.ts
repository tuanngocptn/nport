import { SELF } from "cloudflare:test"
import { REGISTRY_ROUTES, ROUTES } from "@nport/contract"
import { describe, expect, it } from "vitest"

/**
 * The gateway can route every path the contract defines, for both services.
 *
 * The third of these (`apps/node`, `apps/registry`, here), and the one that checks a different thing.
 * The other two ask "does this Worker *implement* its table"; this asks "can a request for that table
 * reach it at all". A perfectly implemented route behind a gateway that does not forward it is
 * unreachable, which is how the v2 shim now sits — see `legacy-gap.test.ts`.
 *
 * **`GET /v1/health` is not in `ROUTES`** and so is not checked here — `docs/API.md` documents it as a
 * public endpoint but `packages/contract` never defined it, which invariant 7 says it should. Found by
 * TypeScript rejecting a comparison against a path the union does not contain. Recorded in
 * `docs/ROADMAP.md` rather than fixed here, since it predates this Worker.
 *
 * Probed rather than read from Hono's table, because the gateway's routes are three wildcards. What
 * matters is not that `/v1/*` is registered but that a given contract path lands on the right service,
 * and only a request can answer that.
 */

const UA = { "user-agent": "nport/3.0.0 (linux; x86_64)" }

/** A concrete path for a route template: `/v1/tunnels/{subdomain}` → `/v1/tunnels/example`. */
function concrete(path: string): string {
  return path.replaceAll(/\{(\w+)\}/g, "example")
}

async function routedTo(path: string): Promise<string> {
  const response = await SELF.fetch(`https://api.nport.link${concrete(path)}`, { headers: UA })
  const body = (await response.json()) as { service?: string; error?: { code: string } }
  return body.service ?? `unrouted (${body.error?.code ?? response.status})`
}

describe("every contract path reaches a service", () => {
  it("routes the node's table to the node", async () => {
    for (const route of ROUTES) {
      expect(await routedTo(route.path), `${route.method} ${route.path}`).toBe("node")
    }
  })

  it("routes the registry's table to the registry", async () => {
    for (const route of REGISTRY_ROUTES) {
      expect(await routedTo(route.path), `${route.method} ${route.path}`).toBe("registry")
    }
  })

  it("sends nothing from one table to the other service", async () => {
    // The failure this exists for: `/v1/nodes/challenge` matching the node's `/v1/*` rule would send a
    // registration challenge to the service that signs with the wrong secret. It would look like it
    // worked, right up until the registry rejected every solution.
    for (const route of REGISTRY_ROUTES) {
      expect(await routedTo(route.path), route.path).not.toBe("node")
    }
    for (const route of ROUTES) {
      expect(await routedTo(route.path), route.path).not.toBe("registry")
    }
  })
})
