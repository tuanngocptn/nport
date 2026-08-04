/**
 * The abuse controls, which are the whole of R9 and the only thing standing in for accounts.
 *
 * `docs/ARCHITECTURE.md` §7 layers four of them, and each bounds something the others do not: request
 * *rate* (the platform limiter), tunnels *held* and *created* per source (`SourceQuota`), what a create
 * *costs* (proof of work), and the global ceiling (`Registry`). These tests exist mostly to pin the
 * boundaries between them — a control that silently stops applying is indistinguishable from one that
 * was never written.
 */

import { reset, SELF, env as testEnv } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { solveChallenge } from "../src/domain/pow"
import type { Env } from "../src/types"
import { FakeCloudflare } from "./fake-cloudflare"

const env = testEnv as unknown as Env

const UA = "nport/3.0.0 (darwin; arm64)"

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
 * A distinct source per test, so one test's quota does not bound the next.
 *
 * The Worker keys everything on `HMAC(ip, secret)`, so a different `cf-connecting-ip` is a different
 * `SourceQuota` object — which is also the property being relied on in production.
 */
function headers(ip: string): Record<string, string> {
  return { "user-agent": UA, "content-type": "application/json", "cf-connecting-ip": ip }
}

async function challenge(ip: string) {
  const response = await SELF.fetch("https://api.nport.link/v1/challenge", { headers: headers(ip) })
  return (await response.json()) as { challenge: string; difficulty: number }
}

async function create(ip: string, subdomain?: string) {
  const proof = await challenge(ip)
  return SELF.fetch("https://api.nport.link/v1/tunnels", {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({
      ...(subdomain === undefined ? {} : { subdomain }),
      challenge: proof.challenge,
      nonce: await solveChallenge(proof.challenge, proof.difficulty),
      client: "cli",
    }),
  })
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

describe("per-source concurrent lease cap", () => {
  it("refuses a source that already holds the maximum", async () => {
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    const ip = "203.0.113.10"

    for (let index = 0; index < limit; index += 1) {
      expect((await create(ip, `holdit${index}`)).status, `create ${index}`).toBe(201)
    }

    const refused = await create(ip, "onetoomany")
    expect(refused.status).toBe(429)
    expect(await codeOf(refused)).toBe("CONCURRENCY_LIMIT")
    // Nothing was provisioned for the refused request.
    expect(cloudflare.tunnels.size).toBe(limit)
  })

  it("does not count another source's tunnels against you", async () => {
    // The cap has to be per source or it is a global cap with a misleading error code.
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    for (let index = 0; index < limit; index += 1) {
      expect((await create("203.0.113.20", `mine${index}`)).status).toBe(201)
    }
    expect((await create("203.0.113.21", "theirs")).status).toBe(201)
  })

  it("frees a slot when a tunnel is deleted", async () => {
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    const ip = "203.0.113.30"

    const first = (await (await create(ip, "recycle0")).json()) as { ownerToken: string }
    for (let index = 1; index < limit; index += 1) {
      expect((await create(ip, `recycle${index}`)).status).toBe(201)
    }
    expect((await create(ip, "blocked")).status).toBe(429)

    const deleted = await SELF.fetch("https://api.nport.link/v1/tunnels/recycle0", {
      method: "DELETE",
      headers: headers(ip),
      body: JSON.stringify({ ownerToken: first.ownerToken }),
    })
    expect(deleted.status).toBe(204)

    // The slot must come back immediately. Letting it lapse with the reservation would make a user
    // who closed a tunnel wait, and letting it lapse with the *lease* would make them wait hours.
    expect((await create(ip, "reused")).status).toBe(201)
  })

  it("does not consume a slot for a create that was refused", async () => {
    const ip = "203.0.113.40"
    expect((await create(ip, "taken")).status).toBe(201)

    // A different source takes the same name — the second caller loses the race for the *name*, which
    // must not also cost them one of their own concurrency slots.
    const loser = "203.0.113.41"
    expect((await create(loser, "taken")).status).toBe(409)

    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    for (let index = 0; index < limit; index += 1) {
      expect((await create(loser, `after${index}`)).status, `create ${index}`).toBe(201)
    }
  })
})

describe("per-source hourly create quota", () => {
  it("refuses a source that has created too many this hour, and says when it resets", async () => {
    const ip = "203.0.113.50"
    const perHour = Number(env.MAX_CREATES_PER_HOUR_PER_SOURCE)

    // The window is filled through the quota object rather than through the API, because reaching 20
    // creates over HTTP costs ~60 requests and the *request-rate* limiter engages first. That is the
    // layering working — see "the layers compose" below — but it makes the outer control, not this
    // one, the thing under test.
    const quota = await quotaFor(ip)
    for (let index = 0; index < perHour; index += 1) {
      await quota.reserve(`seed${index}`, { maxConcurrent: 10_000, maxPerHour: 10_000 })
      await quota.release(`seed${index}`)
    }

    const refused = await create(ip, "overquota")
    expect(refused.status).toBe(429)
    const body = (await refused.json()) as {
      error: { code: string; details?: { resetAt: number } }
    }
    expect(body.error.code).toBe("CREATE_QUOTA_EXCEEDED")
    // `details.resetAt` is what `docs/ERRORS.md` promises for this code, and the only thing a client
    // can act on. A sliding window means it is the oldest attempt's expiry, not the top of the hour.
    expect(body.error.details?.resetAt).toBeGreaterThan(Date.now())
    // And nothing was provisioned.
    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("counts failed creates too", async () => {
    // Refunding a failed create would let anyone with a reliable way to fail — a name already taken —
    // create without limit. The concurrency slot comes back; the quota does not.
    const ip = "203.0.113.60"
    expect((await create("203.0.113.61", "occupied")).status).toBe(201)

    const before = await usage(ip)
    expect((await create(ip, "occupied")).status).toBe(409)
    const after = await usage(ip)

    expect(after.createsThisHour).toBe(before.createsThisHour + 1)
    // But no slot is held.
    expect(after.holds).toBe(0)
  })
})

describe("proof-of-work difficulty rises per source", () => {
  it("charges a first-time source the floor and a busy one more", async () => {
    const floor = Number(env.POW_DIFFICULTY_BITS)
    const ip = "203.0.113.70"

    expect((await challenge(ip)).difficulty).toBe(floor)

    // Four creates per extra bit, so the fifth challenge costs one bit more — a doubling.
    const concurrent = Number(env.MAX_CONCURRENT_PER_SOURCE)
    for (let index = 0; index < 4; index += 1) {
      const response = await create(ip, `busy${index % concurrent}`)
      expect(response.status, `create ${index}`).toBe(201)
      const body = (await response.json()) as { subdomain: string; ownerToken: string }
      await SELF.fetch(`https://api.nport.link/v1/tunnels/${body.subdomain}`, {
        method: "DELETE",
        headers: headers(ip),
        body: JSON.stringify({ ownerToken: body.ownerToken }),
      })
    }

    expect((await challenge(ip)).difficulty).toBeGreaterThan(floor)
    // And a different source is unaffected — escalation is a price on the caller, not on everyone.
    expect((await challenge("203.0.113.71")).difficulty).toBe(floor)
  })

  it("never exceeds the configured ceiling", async () => {
    // Unbounded escalation would eventually price out a legitimate heavy user permanently, and there
    // is no way for them to appeal to anyone — there are no accounts.
    const quota = env.SOURCE_QUOTA.get(env.SOURCE_QUOTA.idFromName("synthetic"))
    const ceiling = Number(env.POW_MAX_DIFFICULTY_BITS)
    for (let index = 0; index < 400; index += 1) {
      await quota.reserve(`bulk${index}`, { maxConcurrent: 10_000, maxPerHour: 10_000 })
    }
    expect(await quota.difficulty(Number(env.POW_DIFFICULTY_BITS), ceiling)).toBe(ceiling)
  })
})

describe("the request-rate limiter", () => {
  it("keys on a hash, never on the address itself", async () => {
    // Rule 11: raw IPs are never stored, and that has to include the platform's own counters. The
    // check is that two addresses are distinct sources — which is only true if something derived from
    // the address reaches the limiter — while nothing anywhere echoes the address back.
    const response = await SELF.fetch("https://api.nport.link/v1/challenge", {
      headers: headers("198.51.100.99"),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain("198.51.100.99")
  })

  it("does not gate health, so a monitor cannot rate-limit itself out of existence", async () => {
    for (let index = 0; index < 8; index += 1) {
      const response = await SELF.fetch("https://api.nport.link/v1/health")
      expect(response.status, `poll ${index}`).toBe(200)
    }
  })
})

/**
 * The quota object for an address, which no route exposes.
 *
 * The Worker names it with a keyed HMAC over the address, so a test cannot guess the name — it has to
 * derive it the same way the middleware does. That is also the assertion that the address never
 * reaches storage: the only handle anything has is this hash.
 */
async function quotaFor(ip: string) {
  const { sourceHash } = await import("../src/domain/ip-hash")
  const hash = await sourceHash(String(env.IP_HASH_SECRET), ip, undefined)
  return env.SOURCE_QUOTA.get(env.SOURCE_QUOTA.idFromName(hash))
}

async function usage(ip: string): Promise<{ holds: number; createsThisHour: number }> {
  return (await quotaFor(ip)).usage()
}

describe("the layers compose", () => {
  it("engages the request-rate limiter before anything reads storage", async () => {
    // The outermost control, and the only one that bounds a flood of *cheap* requests. Without it a
    // source could hammer `/v1/challenge` — one Durable Object read each — indefinitely.
    //
    // Deliberately asserted end-to-end rather than by unit-testing the middleware: the binding is a
    // platform primitive, so the only thing worth checking is that it is wired to the right key on the
    // right routes, which is exactly what a unit test with a stubbed limiter would not tell us.
    const ip = "198.51.100.7"
    let limited: Response | undefined
    for (let index = 0; index < 90; index += 1) {
      const response = await SELF.fetch("https://api.nport.link/v1/meta", { headers: headers(ip) })
      if (response.status === 429) {
        limited = response
        break
      }
    }

    expect(limited, "the rate limiter never engaged").toBeDefined()
    const response = limited as Response
    expect(await codeOf(response)).toBe("RATE_LIMITED")
    // Every 429 carries Retry-After, because `docs/API.md` tells clients to honour it and a retryable
    // error without one invites a tighter loop than the server wants.
    expect(response.headers.get("retry-after")).toBe("60")
  })

  it("leaves another source unaffected when one is limited", async () => {
    const noisy = "198.51.100.8"
    for (let index = 0; index < 90; index += 1) {
      const response = await SELF.fetch("https://api.nport.link/v1/meta", {
        headers: headers(noisy),
      })
      if (response.status === 429) {
        break
      }
    }
    // A shared counter would turn one abuser into an outage for everyone, which is the failure mode
    // keying on the source is there to avoid.
    const quiet = await SELF.fetch("https://api.nport.link/v1/meta", {
      headers: headers("198.51.100.9"),
    })
    expect(quiet.status).toBe(200)
  })
})

describe("the concurrency cap under concurrent creates", () => {
  it("is not evaded by asking for generated names all at once", async () => {
    // The cap is claimed to be *hard*, unlike the global one. That claim only holds if every create
    // takes its own slot at reserve time — and a generated name is not known until the claim succeeds,
    // so the slot has to be taken under a placeholder. A placeholder shared by every request would let
    // N simultaneous creates all pass the check while holding one slot between them.
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    const ip = "203.0.113.80"

    const proofs = await Promise.all(Array.from({ length: limit + 2 }, () => challenge(ip)))
    const responses = await Promise.all(
      proofs.map(async (proof) =>
        SELF.fetch("https://api.nport.link/v1/tunnels", {
          method: "POST",
          headers: headers(ip),
          body: JSON.stringify({
            challenge: proof.challenge,
            nonce: await solveChallenge(proof.challenge, proof.difficulty),
            client: "cli",
          }),
        }),
      ),
    )

    const created = responses.filter((response) => response.status === 201).length
    expect(created).toBe(limit)
    expect(cloudflare.tunnels.size).toBe(limit)
  })
})
