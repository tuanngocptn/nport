import { SELF } from "cloudflare:test"
import { REGISTRY_ROUTES, ROUTES, SHARED_ROUTES } from "@nport/contract"
import { describe, expect, it } from "vitest"

/**
 * The gateway can route every path the contract defines, for both services.
 *
 * The third of these (`apps/node`, `apps/registry`, here), and the one that checks a different thing.
 * The other two ask "does this Worker *implement* its table"; this asks "can a request for that table
 * reach it at all". A perfectly implemented route behind a gateway that does not forward it is
 * unreachable, which is how the v2 shim now sits — see `legacy-gap.test.ts`.
 *
 * **`GET /v1/health` is now `SHARED_ROUTES`**, and it is checked differently from the other two tables:
 * this Worker must answer it *itself* rather than route it anywhere. It was the one public endpoint no
 * route table defined — documented in `docs/API.md` since before the gateway existed, and therefore
 * covered by none of the three conformance tests. Closing that is what the third table is for.
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

describe("the routes the front door owns", () => {
  it("answers every shared route itself, without troubling a service", async () => {
    // **The distinction the third table exists to express.** A health check that crossed a service
    // binding would report on the binding too, and an uptime monitor is asking whether the front door
    // is open. So a shared route reaching `node` or `registry` is a routing bug, not a pass.
    for (const route of SHARED_ROUTES) {
      const response = await SELF.fetch(`https://api.nport.link${concrete(route.path)}`, {
        headers: UA,
      })
      expect(response.status, route.path).toBe(route.successStatus)

      const body = (await response.json()) as { service?: string }
      expect(body.service, `${route.path} was forwarded to a service`).toBeUndefined()
    }
  })

  it("answers them with the shape the contract promises", async () => {
    for (const route of SHARED_ROUTES) {
      const response = await SELF.fetch(`https://api.nport.link${concrete(route.path)}`, {
        headers: UA,
      })
      const parsed = route.response?.safeParse(await response.json())
      expect(parsed?.success, `${route.path}: ${JSON.stringify(parsed?.error?.issues)}`).toBe(true)
    }
  })

  it("answers them without a client version, for uptime monitors", async () => {
    // Rule 6: exempt from the gate and the limiter. A monitor sends no NPort headers, and it has to be
    // able to tell a running-but-misconfigured deployment from a dead one.
    for (const route of SHARED_ROUTES) {
      const response = await SELF.fetch(`https://api.nport.link${concrete(route.path)}`)
      expect(response.status, route.path).toBe(route.successStatus)
    }
  })
})

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
