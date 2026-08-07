/**
 * The v2 compatibility shim.
 *
 * Two things are being tested, and they pull in opposite directions: that an installed 2.x client still
 * works byte-for-byte, and that the two v2 behaviours which were *bugs* are not reproduced. The second
 * set matters more — a shim that faithfully reproduced v2's subdomain takeover would be worse than no
 * shim at all.
 *
 * The request shapes here are taken from v2's own source (`git show main:src/api.ts`), not from memory.
 */

import { reset, SELF, env as testEnv } from "cloudflare:test"
import { solveChallenge } from "@nport/worker-kit"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Env } from "../src/types"
import { FakeCloudflare } from "./fake-cloudflare"
import { asGateway } from "./gateway"

const env = testEnv as unknown as Env

let cloudflare: FakeCloudflare

beforeEach(() => {
  cloudflare = new FakeCloudflare()
  cloudflare.install()
})

afterEach(async () => {
  cloudflare.restore()
  await reset()
})

/**
 * A 2.x client's headers.
 *
 * Deliberately *not* an `nport/3.x` User-Agent: the whole point is that these callers cannot pass the
 * minimum-version gate, and the shim must work anyway.
 */
function headers(ip = "203.0.113.1"): Record<string, string> {
  // **No `user-agent`, deliberately** — a 2.x client sends none, and this Worker no longer gates on it
  // anyway (`apps/gateway` does). The source identity is forwarded rather than derived from an address
  // (ADR-0049), so the address becomes the identity string directly.
  return asGateway({ "content-type": "application/json", "x-nport-source-hash": `source-${ip}` })
}

interface LegacyCreated {
  success: boolean
  tunnelId?: string
  tunnelToken?: string
  url?: string
  error?: string
}

async function legacyCreate(subdomain?: string, ip?: string) {
  return SELF.fetch("https://api.nport.link/", {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify(subdomain === undefined ? {} : { subdomain }),
  })
}

async function legacyDelete(subdomain: string, tunnelId: string, ip?: string) {
  return SELF.fetch("https://api.nport.link/", {
    method: "DELETE",
    headers: headers(ip),
    body: JSON.stringify({ subdomain, tunnelId }),
  })
}

/**
 * The shim has no proof of work, so its cost per request is bounded by nothing but its own input
 * handling — which makes an unbounded field here worth more to an attacker than anywhere else in the
 * API. Two things were unbounded: what reached the normalizer, and what came back in the refusal.
 */
describe("resource bounds on the weakest path", () => {
  it("refuses an oversized subdomain without spending its length", async () => {
    // 645 KiB of `.nport.link` repeated took 12.5 s of CPU in the normalizer, from one request.
    const response = await legacyCreate(`a${".nport.link".repeat(60_000)}`)

    expect(response.status).toBe(400)
    expect(await response.text()).toSatisfy((body: string) => body.length < 4096)
    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("does not echo a large input back in the refusal", async () => {
    // The rejection interpolated the raw value, so a megabyte in was a megabyte out — a reflection
    // amplifier on an endpoint anyone can reach.
    const response = await legacyCreate("x".repeat(50_000))

    expect(response.status).toBe(400)
    const body = (await response.json()) as { success: false; error: string }
    expect(body.success).toBe(false)
    // Still v2's shape and still the substring its CLI matches, just not the whole request.
    expect(body.error).toContain("SUBDOMAIN_PROTECTED:")
    expect(body.error.length).toBeLessThan(512)
  })
})

describe("v2 wire compatibility", () => {
  it("answers POST / with v2's exact success body", async () => {
    const response = await legacyCreate("oldclient")
    expect(response.status).toBe(200)

    const body = (await response.json()) as LegacyCreated
    // The four fields v2's CLI reads, and nothing it would choke on.
    expect(body.success).toBe(true)
    expect(body.tunnelId).toBeTypeOf("string")
    expect(body.tunnelToken).toBeTypeOf("string")
    expect(body.url).toBe(`https://oldclient.${env.CF_DOMAIN}`)
  })

  it("works without any client identification", async () => {
    // A 2.x client sends no `nport/<version>` User-Agent, so the client gate would reject it with 426.
    // If the shim were behind that gate it would be useless to the only callers it exists for.
    const response = await legacyCreate("noheaders")
    expect(response.status).toBe(200)
  })

  it("requires no proof of work", async () => {
    // Stated plainly because it is the weakness that argues for sunsetting: a 2.x client cannot solve a
    // challenge, so this path skips the control §7 calls load-bearing.
    const response = await legacyCreate("nopow")
    expect(response.status).toBe(200)
  })

  it("answers DELETE / with v2's exact body", async () => {
    const created = (await (await legacyCreate("goodbye")).json()) as LegacyCreated

    const response = await legacyDelete("goodbye", String(created.tunnelId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
  })

  it("still redirects GET /, for people who type the host into a browser", async () => {
    const response = await SELF.fetch("https://api.nport.link/", { redirect: "manual" })
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe("https://nport.link")
  })

  it("answers an unsupported method with 405 plain text, as v2 did", async () => {
    const response = await SELF.fetch("https://api.nport.link/", {
      method: "PUT",
      headers: asGateway(),
    })
    expect(response.status).toBe(405)
    expect(await response.text()).toBe("Method Not Allowed")
  })

  it("generates a name when none is given", async () => {
    const body = (await (await legacyCreate()).json()) as LegacyCreated
    // v2 generated `tun-<Date.now()>` — guessable to the second. The URL is all a 2.x client displays,
    // so there is no reason to reproduce a bad generator (defect R2).
    expect(body.url).toMatch(/^https:\/\/nport-[a-z2-7]{13}\./)
  })
})

describe("v2 error strings the 2.x CLI matches on", () => {
  it("uses SUBDOMAIN_IN_USE for a taken name, so the old CLI prints its own advice", async () => {
    expect((await legacyCreate("contested")).status).toBe(200)

    const response = await legacyCreate("contested", "203.0.113.2")
    const body = (await response.json()) as LegacyCreated
    expect(body.success).toBe(false)
    // The 2.x CLI matches `SUBDOMAIN_IN_USE:` and `currently in use` to choose its formatted, translated
    // message. Without one of those substrings the user sees a raw error instead.
    expect(body.error).toContain("SUBDOMAIN_IN_USE:")
    expect(body.error).toContain("currently in use")
  })

  it("uses SUBDOMAIN_PROTECTED for a reserved name", async () => {
    const response = await legacyCreate("api")
    expect(response.status).toBe(403)
    const body = (await response.json()) as LegacyCreated
    expect(body.error).toContain("SUBDOMAIN_PROTECTED:")
    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("returns a non-2xx for failures, because that is how the old client reads the error", async () => {
    // v2's CLI uses axios, which throws only on a non-2xx — and its handler reads
    // `error.response.data.error`. A 200 with `success: false` reaches a different branch and produces a
    // worse message, so the status has to stay outside the 2xx range.
    expect((await legacyCreate("statuscheck")).status).toBe(200)
    const refused = await legacyCreate("statuscheck", "203.0.113.3")
    expect(refused.status).toBeGreaterThanOrEqual(400)
  })

  it("never surfaces upstream Cloudflare text", async () => {
    cloudflare.fail("create-tunnel", { status: 500, codes: [1013] })

    const response = await legacyCreate("upstreamfail")
    const body = (await response.json()) as LegacyCreated
    expect(body.success).toBe(false)
    // v2 echoed Cloudflare's message straight through, leaking account and zone internals (defect R11).
    expect(body.error).not.toContain("injected")
    expect(body.error).not.toContain("1013")
  })
})

describe("the two v2 behaviours that are deliberately not reproduced", () => {
  it("refuses to take over a live subdomain instead of deleting the incumbent", async () => {
    // v2's create deleted the incumbent's tunnel and DNS record whenever the tunnel merely *looked*
    // inactive, so a user whose connection flapped could lose their name to a stranger (defect R7).
    const incumbent = (await (await legacyCreate("mine")).json()) as LegacyCreated

    const attacker = await legacyCreate("mine", "198.51.100.50")
    expect(attacker.status).toBe(409)

    // The incumbent's tunnel and record are untouched.
    expect(cloudflare.tunnels.size).toBe(1)
    expect(cloudflare.dns.get(`mine.${env.CF_DOMAIN}`)?.content).toBe(
      `${incumbent.tunnelId}.cfargotunnel.com`,
    )
  })

  it("refuses a delete from a different source", async () => {
    // v2 accepted any `{subdomain, tunnelId}` from anyone, so any caller could remove any tunnel —
    // including the `api` record itself.
    const created = (await (await legacyCreate("protected")).json()) as LegacyCreated

    const response = await legacyDelete("protected", String(created.tunnelId), "198.51.100.51")
    expect(response.status).toBe(403)
    expect(cloudflare.tunnels.size).toBe(1)

    // The original source still can.
    expect((await legacyDelete("protected", String(created.tunnelId))).status).toBe(200)
  })

  it("ignores the tunnelId in the body entirely", async () => {
    // The field v2 trusted. Passing someone else's ID must change nothing: the lease is the authority on
    // which tunnel belongs to a name.
    expect((await legacyCreate("ignoreid")).status).toBe(200)
    const other = (await (await legacyCreate("bystander")).json()) as LegacyCreated

    const response = await legacyDelete("ignoreid", String(other.tunnelId))
    expect(response.status).toBe(200)

    // `ignoreid` is gone and the bystander survives — the opposite of what a trusted `tunnelId` would do.
    expect([...cloudflare.tunnels.values()].map((tunnel) => tunnel.name)).toEqual([
      "nport-bystander",
    ])
    expect(other.tunnelId).toBeTypeOf("string")
  })

  it("cannot delete a lease created through /v1", async () => {
    // The guard that stops the weaker authorization reaching a modern tunnel. A v1 lease is held by an
    // ownerToken, and no source-hash match may substitute for it.
    const ua = asGateway({
      "user-agent": "nport/3.0.0 (darwin; arm64)",
      "content-type": "application/json",
    })
    const challenge = (await (
      await SELF.fetch("https://api.nport.link/v1/challenge", { headers: ua })
    ).json()) as { challenge: string; difficulty: number }
    const modern = await SELF.fetch("https://api.nport.link/v1/tunnels", {
      method: "POST",
      headers: ua,
      body: JSON.stringify({
        subdomain: "modern",
        challenge: challenge.challenge,
        nonce: await solveChallenge(challenge.challenge, challenge.difficulty),
        client: "cli",
      }),
    })
    expect(modern.status).toBe(201)

    // Same machine, so the source hash matches — and it still must not be enough.
    const response = await legacyDelete("modern", "whatever")
    expect(response.status).toBe(403)
    expect(cloudflare.tunnels.size).toBe(1)
  })
})

describe("the shim is inside the abuse controls", () => {
  it("counts against the same per-source concurrency cap", async () => {
    // Otherwise the legacy endpoint is a way to bypass the caps entirely, which — with no proof of work
    // either — would make it strictly the cheapest path for an abuser.
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    const ip = "203.0.113.60"

    for (let index = 0; index < limit; index += 1) {
      expect((await legacyCreate(`legacyhold${index}`, ip)).status, `create ${index}`).toBe(200)
    }

    const refused = await legacyCreate("onetoomany", ip)
    expect(refused.status).toBe(429)
    expect(cloudflare.tunnels.size).toBe(limit)
  })

  /**
   * **`is rate limited` is gone, and nothing replaces it yet.**
   *
   * It asserted that `POST /` — which sits outside `/v1/*` and so needed the limiter registered on it
   * explicitly — was not an unlimited hole. The limiter is the gateway's now (ADR-0049), and the
   * gateway routes only `/v1/*`, so the whole shim is unreachable in a deployed system:
   * `apps/gateway/test/legacy-gap.test.ts` is the tripwire that says so.
   *
   * That makes this assertion untestable rather than merely relocated. **When `/` is routed again**,
   * the limiter must be on it before the first v2 client arrives, and this test comes back at the
   * gateway — an unauthenticated, proof-of-work-free create path with no rate limit in front of it is
   * the cheapest tunnel in the system by a wide margin.
   */

  it("does not require a valid subdomain to already exist for delete to be idempotent", async () => {
    // A 2.x client's second Ctrl+C fires a second DELETE. v2 reported an error for it (defect R19).
    const created = (await (await legacyCreate("twice")).json()) as LegacyCreated
    expect((await legacyDelete("twice", String(created.tunnelId))).status).toBe(200)
    expect((await legacyDelete("twice", String(created.tunnelId))).status).toBe(200)
  })
})
