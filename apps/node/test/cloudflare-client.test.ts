/**
 * The retry ladder in `src/cloudflare/client.ts`, driven through its `fetcher` seam.
 *
 * Every other suite reaches Cloudflare through `test/fake-cloudflare.ts`, which answers happily and so
 * never exercises what happens when the upstream pushes back. These drive the ladder itself: how many
 * subrequests a failure actually costs, and whether the one number Cloudflare supplies is used.
 *
 * The budget is the reason to care. `apps/node/CLAUDE.md` rule 13: fifty subrequests on the free plan,
 * and provisioning spends three or four of them before any retry multiplies them.
 */

import { describe, expect, it } from "vitest"

import { CloudflareClient } from "../src/cloudflare/client"

const CONFIG = {
  apiToken: "test-token",
  accountId: "acct",
  zoneId: "zone",
  domain: "nport.link",
} as const

/** A fetcher that answers with `status` every time and counts how often it was called. */
function counting(status: number, headers: Record<string, string> = {}) {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] }), {
      status,
      headers,
    })
  }
  return { calls, fetcher }
}

describe("the Cloudflare retry ladder", () => {
  it("stops immediately when Cloudflare asks for longer than the request can absorb", async () => {
    // The defect this pins: a 429 was retried on the fixed 150 ms/600 ms ladder no matter what the
    // upstream said, so a `Retry-After: 30` cost three subrequests instead of one and hammered a
    // service that had just asked us to stop. The account being rate-limited is the one the whole
    // deployment runs on (ADR-0031), so this is not only wasteful.
    const { calls, fetcher } = counting(429, { "retry-after": "30" })
    const client = new CloudflareClient(CONFIG, fetcher)

    await expect(client.listTunnels(1, 10)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it("still spends its full ladder when Cloudflare names no delay", async () => {
    // The other half: without a `Retry-After` the ladder is all the information there is, and giving
    // up after one attempt would turn a transient blip into a failed provision.
    const { calls, fetcher } = counting(500)
    const client = new CloudflareClient(CONFIG, fetcher)

    await expect(client.listTunnels(1, 10)).rejects.toThrow()
    expect(calls).toHaveLength(3)
  })

  it("honours a short delay rather than giving up on it", async () => {
    // One second is inside what a request can absorb, so the attempts are still worth spending.
    const { calls, fetcher } = counting(429, { "retry-after": "1" })
    const client = new CloudflareClient(CONFIG, fetcher)

    await expect(client.listTunnels(1, 10)).rejects.toThrow()
    expect(calls).toHaveLength(3)
  })

  // `Number("")` is `0` and an HTTP-date is not a number at all. Either one read as "retry now" would
  // be worse than the ladder it replaced, so every unreadable form falls back to it.
  //
  // One case per value rather than a loop: the ladder sleeps for real, and six of them in a single
  // test exceeds vitest's default timeout — a failure that would have looked like a hang in the client.
  it.each(["", "   ", "not-a-number", "Wed, 21 Oct 2026 07:28:00 GMT", "-5", "1.5"])(
    "ignores an unreadable Retry-After (%j) rather than treating it as zero",
    async (value) => {
      const { calls, fetcher } = counting(429, { "retry-after": value })
      const client = new CloudflareClient(CONFIG, fetcher)

      await expect(client.listTunnels(1, 10)).rejects.toThrow()
      expect(calls).toHaveLength(3)
    },
  )

  it("does not retry a status that means the request itself is wrong", async () => {
    // 403 is a scope or token problem. Retrying it burns the budget to be told the same thing.
    const { calls, fetcher } = counting(403)
    const client = new CloudflareClient(CONFIG, fetcher)

    await expect(client.listTunnels(1, 10)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})
