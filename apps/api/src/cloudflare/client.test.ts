/**
 * The Cloudflare client on its own, with an injected fetcher.
 *
 * These cover what the saga tests cannot see from the outside: how many attempts a call makes, what
 * it sends, and — the one that matters most — that no upstream text ever escapes into a thrown error.
 */

import { describe, expect, it, vi } from "vitest"

import { CloudflareClient, CloudflareError, cnameTargetFor, tunnelNameFor } from "./client"

const CONFIG = {
  apiToken: "test-token",
  accountId: "acc",
  zoneId: "zone",
  domain: "nport.test",
} as const

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function ok<T>(result: T): Response {
  return respond(200, { success: true, result })
}

describe("naming", () => {
  it("namespaces every tunnel it creates", () => {
    // Reconciliation deletes by name, so this prefix is the only thing standing between a
    // self-hoster's unrelated tunnels and our sweeper.
    expect(tunnelNameFor("myapp")).toBe("nport-myapp")
  })

  it("builds the CNAME target the edge routes on", () => {
    expect(cnameTargetFor("abc-123")).toBe("abc-123.cfargotunnel.com")
  })
})

describe("createTunnel", () => {
  it("asks for a remotely managed tunnel and returns its token", async () => {
    const fetcher = vi.fn(async () => ok({ id: "t1", token: "tok" }))
    const client = new CloudflareClient(CONFIG, fetcher as unknown as typeof fetch)

    expect(await client.createTunnel("nport-app")).toEqual({ id: "t1", token: "tok" })

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel")
    // `config_src: "cloudflare"` is what makes a token sufficient — no cert.pem, no local config.
    expect(JSON.parse(String(init.body))).toEqual({ name: "nport-app", config_src: "cloudflare" })
    expect(init.headers).toMatchObject({ authorization: "Bearer test-token" })
  })

  it("treats a tunnel with no token as a failure, not a success", async () => {
    // A tunnel we cannot connect to is worse than no tunnel: it would strand the caller with an
    // orphan that no compensation was triggered to clean up.
    const client = new CloudflareClient(CONFIG, (async () =>
      ok({ id: "t1" })) as unknown as typeof fetch)
    await expect(client.createTunnel("nport-app")).rejects.toBeInstanceOf(CloudflareError)
  })
})

describe("retry", () => {
  it("retries a 500 and succeeds", async () => {
    let attempts = 0
    const client = new CloudflareClient(CONFIG, (async () => {
      attempts += 1
      return attempts < 3
        ? respond(500, { success: false, result: null })
        : ok({ id: "t", token: "k" })
    }) as unknown as typeof fetch)

    expect(await client.createTunnel("nport-app")).toEqual({ id: "t", token: "k" })
    expect(attempts).toBe(3)
  })

  it("stops at three attempts", async () => {
    // Every attempt is a subrequest. Provisioning makes four calls against a budget of 50, so an
    // unbounded retry would turn a Cloudflare outage into a Worker that dies of subrequest limits.
    let attempts = 0
    const client = new CloudflareClient(CONFIG, (async () => {
      attempts += 1
      return respond(503, { success: false, result: null, errors: [{ code: 1, message: "down" }] })
    }) as unknown as typeof fetch)

    await expect(client.createTunnel("nport-app")).rejects.toThrow()
    expect(attempts).toBe(3)
  })

  it("does not retry a 400, because the request itself is wrong", async () => {
    let attempts = 0
    const client = new CloudflareClient(CONFIG, (async () => {
      attempts += 1
      return respond(400, {
        success: false,
        result: null,
        errors: [{ code: 81053, message: "dup" }],
      })
    }) as unknown as typeof fetch)

    await expect(client.createDnsRecord("a.nport.test", "x.cfargotunnel.com")).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  it("retries a transport failure", async () => {
    let attempts = 0
    const client = new CloudflareClient(CONFIG, (async () => {
      attempts += 1
      if (attempts === 1) {
        throw new TypeError("network")
      }
      return ok(null)
    }) as unknown as typeof fetch)

    await client.deleteDnsRecord("rec-1")
    expect(attempts).toBe(2)
  })
})

describe("errors", () => {
  it("carries the status and Cloudflare's codes, and nothing else", async () => {
    const client = new CloudflareClient(CONFIG, (async () =>
      respond(400, {
        success: false,
        result: null,
        errors: [{ code: 81053, message: "record already exists for zone 9f8e — account acc" }],
      })) as unknown as typeof fetch)

    const error = await client
      .createDnsRecord("a.nport.test", "x.cfargotunnel.com")
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CloudflareError)
    const failure = error as CloudflareError
    expect(failure.status).toBe(400)
    expect(failure.has(81053)).toBe(true)
    expect(failure.retryable).toBe(false)
    // The load-bearing assertion. v2 echoed this text to anonymous callers, leaking zone and account
    // internals (defect R11) — so no reachable field may carry it. `message` is enumerated
    // separately because `Error.message` is not an own enumerable property and a spread would miss it.
    const reachable = JSON.stringify({ ...failure, message: failure.message, stack: undefined })
    expect(reachable).not.toContain("9f8e")
    expect(reachable).not.toContain("already exists")
  })

  it("survives a non-JSON response", async () => {
    // A Cloudflare proxy error page, which is HTML. `JSON.parse` throwing here must not surface as
    // an unhandled `SyntaxError`.
    const client = new CloudflareClient(
      CONFIG,
      (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    )
    await expect(client.findDnsRecord("a.nport.test")).rejects.toBeInstanceOf(CloudflareError)
  })
})

describe("lookups", () => {
  it("encodes the name rather than interpolating it", async () => {
    // v2 interpolated the raw user value into this URL, so a subdomain containing `&` became a
    // Cloudflare API call nobody intended (defect R2).
    const fetcher = vi.fn(async () => ok([]))
    const client = new CloudflareClient(CONFIG, fetcher as unknown as typeof fetch)

    await client.findDnsRecord("a&b.nport.test")

    const [url] = fetcher.mock.calls[0] as unknown as [string]
    expect(url).toContain("name=a%26b.nport.test")
  })

  it("ignores a near-match name the API returned anyway", async () => {
    const client = new CloudflareClient(CONFIG, (async () =>
      ok([
        { id: "r", name: "other.nport.test", type: "CNAME", content: "x" },
      ])) as unknown as typeof fetch)

    expect(await client.findDnsRecord("wanted.nport.test")).toBeNull()
  })

  it("tolerates a null result where a list was expected", async () => {
    const client = new CloudflareClient(CONFIG, (async () => ok(null)) as unknown as typeof fetch)
    expect(await client.findTunnelsByName("nport-x")).toEqual([])
  })

  it("clears connections before deleting a tunnel, and continues if that fails", async () => {
    // A SIGKILLed connector leaves connections registered, and Cloudflare then refuses the delete —
    // so clearing first is the common path, not the exception.
    const seen: string[] = []
    const client = new CloudflareClient(CONFIG, (async (url: string) => {
      seen.push(new URL(url).pathname)
      return url.endsWith("/connections")
        ? respond(500, { success: false, result: null })
        : ok(null)
    }) as unknown as typeof fetch)

    await client.deleteTunnel("t9")

    expect(seen[0]).toBe("/client/v4/accounts/acc/cfd_tunnel/t9/connections")
    expect(seen.at(-1)).toBe("/client/v4/accounts/acc/cfd_tunnel/t9")
  })

  it("treats an already-deleted tunnel as deleted", async () => {
    // Alarms are at-least-once, so a teardown that succeeded and lost its response is redelivered.
    // Without this, the retry throws on 404, the lease stays in RELEASING, and the watchdog
    // reschedules every 30s forever — holding a subdomain nobody can reclaim. Found by leaving a
    // dev stack running: the log filled with `teardown failed { status: 404 }` at 30s intervals.
    const client = new CloudflareClient(CONFIG, (async (url: string) =>
      url.endsWith("/connections")
        ? ok(null)
        : respond(404, {
            success: false,
            errors: [{ code: 1000, message: "tunnel not found" }],
            result: null,
          })) as unknown as typeof fetch)

    await expect(client.deleteTunnel("gone")).resolves.toBeUndefined()
  })

  it("still reports a delete that failed for any other reason", async () => {
    // The 404 tolerance above must not become "teardown never fails". A 403 is a real problem and
    // the lease must stay in RELEASING rather than freeing a name whose tunnel is still alive.
    const client = new CloudflareClient(CONFIG, (async (url: string) =>
      url.endsWith("/connections")
        ? ok(null)
        : respond(403, {
            success: false,
            errors: [{ code: 10000, message: "no" }],
            result: null,
          })) as unknown as typeof fetch)

    await expect(client.deleteTunnel("t9")).rejects.toBeInstanceOf(CloudflareError)
  })
})

describe("fqdn", () => {
  it("joins the subdomain to the configured zone", () => {
    // Self-hosters run their own zone, so nothing may hardcode nport.link.
    expect(new CloudflareClient(CONFIG).fqdn("myapp")).toBe("myapp.nport.test")
  })
})
