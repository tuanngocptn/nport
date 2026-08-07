import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { app } from "../src/index"

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

/**
 * **Sends an address by default**, so every test that does not care about identity shares one bucket
 * that no test deliberately floods.
 *
 * Without it every such request keys the rate limiter on `HMAC("unknown")`, and the limiter allows 60
 * a minute — so a file that grew past sixty incidental requests would start failing somewhere
 * unrelated to whatever was added, with a 429 nobody was looking for. The two tests below that *do*
 * flood pass their own addresses.
 */
const QUIET = "192.0.2.1"

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://api.nport.link${path}`, {
    ...init,
    headers: { "cf-connecting-ip": QUIET, ...UA, ...(init.headers ?? {}) },
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

describe("IPv6, end to end", () => {
  /**
   * Relocated from `apps/node/test/abuse-controls.test.ts`, where it could no longer mean anything: the
   * node is handed a finished hash and cannot tell an IPv6 caller from an IPv4 one.
   *
   * **The cap used to be free to bypass over IPv6.** A residential or mobile allocation is a 64-bit
   * prefix at the very smallest, so a client picks the rest of the address itself — a different one per
   * request meant a different `SourceQuota` object downstream, and therefore a fresh concurrency cap, a
   * fresh hourly quota and a fresh rate-limit bucket, at no cost and with no botnet.
   */
  async function hashFor(ip: string): Promise<string | null> {
    const echo = (await (
      await call("/v1/meta", { headers: { "cf-connecting-ip": ip } })
    ).json()) as Echo
    return echo.sourceHash
  }

  it("gives one identity to every address a client can pick inside its own /64", async () => {
    const first = await hashFor("2001:db8:1234:5678::1")
    expect(first).toBeTruthy()
    for (const rotated of [
      "2001:db8:1234:5678::2",
      "2001:db8:1234:5678:dead:beef:cafe:f00d",
      "2001:db8:1234:5678:ffff:ffff:ffff:ffff",
    ]) {
      expect(await hashFor(rotated), rotated).toBe(first)
    }
  })

  it("still separates two different prefixes", async () => {
    // The fix must not go the other way and fold unrelated networks onto one identity, which would cap
    // strangers against each other.
    expect(await hashFor("2001:db8:aaaa:1::7")).not.toBe(await hashFor("2001:db8:aaaa:2::7"))
  })
})

describe("the request-rate limiter", () => {
  /**
   * Also relocated: the `RATE_LIMITER` binding is declared only here now.
   *
   * The outermost of the layered controls, and the only one that bounds a flood of *cheap* requests.
   * Without it a source could hammer `/v1/challenge` — one Durable Object read each, on a Worker it
   * cannot otherwise reach — indefinitely.
   *
   * Deliberately end-to-end rather than a unit test of the middleware: the binding is a platform
   * primitive, so the only thing worth checking is that it is wired to the right key on the right
   * routes, which is exactly what a test with a stubbed limiter would not tell us.
   */
  it("engages before a request crosses a binding", async () => {
    let limited: Response | undefined
    for (let index = 0; index < 90; index += 1) {
      const response = await call("/v1/meta", { headers: { "cf-connecting-ip": "198.51.100.7" } })
      if (response.status === 429) {
        limited = response
        break
      }
    }

    expect(limited, "the rate limiter never engaged").toBeDefined()
    const response = limited as Response
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED")
    // Every 429 carries Retry-After, because `docs/API.md` tells clients to honour it and a retryable
    // error without one invites a tighter loop than the server wants.
    expect(response.headers.get("retry-after")).toBe("60")
  })

  it("leaves another source unaffected when one is limited", async () => {
    for (let index = 0; index < 90; index += 1) {
      const response = await call("/v1/meta", { headers: { "cf-connecting-ip": "198.51.100.8" } })
      if (response.status === 429) {
        break
      }
    }
    // A shared counter would turn one abuser into an outage for everyone, which is the failure mode
    // keying on the source is there to avoid.
    const quiet = await call("/v1/meta", { headers: { "cf-connecting-ip": "198.51.100.9" } })
    expect(quiet.status).toBe(200)
  })

  it("does not limit health, so an uptime monitor cannot poll itself out of existence", async () => {
    for (let index = 0; index < 90; index += 1) {
      await call("/v1/meta", { headers: { "cf-connecting-ip": "198.51.100.10" } })
    }
    const health = await SELF.fetch("https://api.nport.link/v1/health", {
      headers: { "cf-connecting-ip": "198.51.100.10" },
    })
    expect(health.status).toBe(200)
  })
})

describe("the request id", () => {
  it("prefers cf-ray, so it matches Cloudflare's logs", async () => {
    // Relocated from `apps/node`, which now echoes whatever this Worker forwarded. A user quoting an id
    // from an error should find that same string in Cloudflare's own logs for the request.
    const echo = (await (
      await call("/v1/meta", { headers: { "cf-ray": "abc123-HKG" } })
    ).json()) as Echo
    expect(echo.requestId).toBe("abc123-HKG")
  })

  it("mints one when the edge did not supply a ray", async () => {
    const echo = (await (await call("/v1/meta")).json()) as Echo
    expect(echo.requestId).toBeTruthy()
  })

  it("does not let a caller choose the id two services will log", async () => {
    // Not a security boundary — an id is only ever logged — but two callers who both claimed
    // `deadbeef` would make the field useless for the one thing it is for: finding one request.
    const echo = (await (
      await call("/v1/meta", { headers: { "x-nport-request-id": "chosen-by-the-caller" } })
    ).json()) as Echo
    expect(echo.requestId).not.toBe("chosen-by-the-caller")
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

describe("a misconfigured gateway", () => {
  /**
   * Driven through the exported `app` rather than `SELF`, because the whole point is an env that the
   * deployed Worker could never have — `vitest.config.ts` always supplies a complete one.
   */
  const stripped = { MIN_CLIENT_VERSION: "3.0.0" } as unknown as Parameters<typeof app.fetch>[1]

  it("answers with an envelope, not a bare 500", async () => {
    // The bug this replaced: the check ran in the `fetch` export, outside Hono, so a throw never
    // reached `onError` and `workerd` returned an empty 500. An operator who mis-binds a service
    // should get a code they can look up and a request id they can quote.
    const response = await app.fetch(
      new Request("https://api.nport.link/v1/meta", {
        headers: { "user-agent": "nport/3.0.0 (linux; x86_64)" },
      }),
      stripped,
    )

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { code: string; requestId: string } }
    expect(body.error.code).toBe("INTERNAL")
    expect(body.error.requestId).toBeTruthy()
  })

  it("names no binding in the response", async () => {
    // Rule 8: which binding is missing is deployment detail, and this endpoint is anonymous.
    const response = await app.fetch(
      new Request("https://api.nport.link/v1/meta", {
        headers: { "user-agent": "nport/3.0.0 (linux; x86_64)" },
      }),
      stripped,
    )
    const text = await response.text()
    for (const name of ["IP_HASH_SECRET", "RATE_LIMITER", "NODE"]) {
      expect(text, name).not.toContain(name)
    }
  })

  it("still answers health, so a monitor can tell misconfigured from dead", async () => {
    const response = await app.fetch(new Request("https://api.nport.link/v1/health"), stripped)
    expect(response.status).toBe(200)
  })
})
