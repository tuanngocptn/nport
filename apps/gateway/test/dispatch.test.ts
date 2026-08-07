import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

/**
 * What the gateway forwards, and to whom.
 *
 * The stubs in `vitest.config.ts` echo back the request they received, so every assertion here reads
 * what actually crossed the binding rather than inferring it from a status code.
 */

const UA = { "user-agent": "nport/3.0.0 (linux; x86_64)" }

interface Echo {
  service: string
  method: string
  path: string
  requestId: string | null
  sourceHash: string | null
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://api.nport.link${path}`, {
    ...init,
    headers: { ...UA, ...(init.headers ?? {}) },
  })
}

describe("dispatch", () => {
  it("sends the node's paths to the node", async () => {
    for (const path of ["/v1/meta", "/v1/challenge", "/v1/tunnels", "/v1/tunnels/abc/heartbeat"]) {
      const echo = (await (await call(path)).json()) as Echo
      expect(echo.service, path).toBe("node")
      expect(echo.path, path).toBe(path)
    }
  })

  it("sends the registry's paths to the registry", async () => {
    // Both, because `/v1/nodes` and `/v1/nodes/challenge` match different Hono patterns and a router
    // that handled only the exact path would send the challenge to the node — where a challenge signed
    // with the wrong secret is exactly the confusion ADR-0049 moved this path to prevent.
    for (const path of ["/v1/nodes", "/v1/nodes/challenge"]) {
      const echo = (await (await call(path)).json()) as Echo
      expect(echo.service, path).toBe("registry")
      expect(echo.path, path).toBe(path)
    }
  })

  it("preserves the method", async () => {
    const echo = (await (await call("/v1/nodes", { method: "POST", body: "{}" })).json()) as Echo
    expect(echo.method).toBe("POST")
    expect(echo.service).toBe("registry")
  })

  it("answers health itself rather than forwarding it", async () => {
    // A health check that crossed a binding would report on the binding too, and an uptime monitor is
    // asking whether the front door is open.
    const response = await call("/v1/health")
    expect(await response.json()).toEqual({ status: "ok" })
  })

  it("redirects the root to the site", async () => {
    const response = await call("/", { redirect: "manual" })
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe("https://nport.link")
  })

  it("refuses an unknown path without troubling a service", async () => {
    const response = await call("/v2/anything")
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    )
  })
})

describe("the forwarded headers", () => {
  it("adds a request id the service can log", async () => {
    const echo = (await (await call("/v1/meta")).json()) as Echo
    expect(echo.requestId).toBeTruthy()
  })

  it("adds a source hash, and never a raw address", async () => {
    const echo = (await (
      await call("/v1/meta", { headers: { "cf-connecting-ip": "203.0.113.9" } })
    ).json()) as Echo
    expect(echo.sourceHash).toBeTruthy()
    expect(echo.sourceHash).not.toContain("203.0.113")
  })

  it("overwrites a source hash the caller tried to choose", async () => {
    // **The one that matters.** Internal services trust `x-nport-source-hash` because they are not
    // publicly reachable. If the gateway passed a caller's own value through, anyone could adopt any
    // identity and walk past every per-source cap in `SourceQuota` at once — the abuse controls in
    // `docs/ARCHITECTURE.md` §7 defeated by setting a header.
    const forged = "f".repeat(64)
    const echo = (await (
      await call("/v1/meta", { headers: { "x-nport-source-hash": forged } })
    ).json()) as Echo
    expect(echo.sourceHash).not.toBe(forged)
    expect(echo.sourceHash).toBeTruthy()
  })

  it("gives two different callers two different hashes", async () => {
    const one = (await (
      await call("/v1/meta", { headers: { "cf-connecting-ip": "203.0.113.1" } })
    ).json()) as Echo
    const two = (await (
      await call("/v1/meta", { headers: { "cf-connecting-ip": "198.51.100.1" } })
    ).json()) as Echo
    expect(one.sourceHash).not.toBe(two.sourceHash)
  })
})

describe("the client gate, applied once for every service", () => {
  it("refuses a caller that does not identify itself", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/meta")
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    )
  })

  it("refuses a client below the floor", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/meta", {
      headers: { "user-agent": "nport/2.9.0 (linux; x86_64)" },
    })
    expect(response.status).toBe(426)
  })

  it("lets health through ungated, for uptime monitors", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/health")
    expect(response.status).toBe(200)
  })
})
