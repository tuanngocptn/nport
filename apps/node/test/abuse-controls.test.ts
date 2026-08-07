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
import { solveChallenge } from "@nport/worker-kit"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
 * **Sends the identity rather than an address** (ADR-0049). The hashing moved to `apps/gateway`, so
 * this Worker receives `x-nport-source-hash` and keys `SourceQuota` on it directly. That makes these
 * tests *more* honest than they were: they used to send `cf-connecting-ip` and rely on the middleware
 * to hash it, which meant every per-source test also silently tested the HMAC. Now they test the thing
 * they are named for, and `apps/gateway/test/dispatch.test.ts` tests the hashing.
 */
function headers(ip: string): Record<string, string> {
  return {
    "user-agent": UA,
    "content-type": "application/json",
    "x-nport-source-hash": sourceFor(ip),
  }
}

/** The identity the gateway would have derived. Any stable string works — the node only keys on it. */
function sourceFor(ip: string): string {
  return `source-${ip}`
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

  /**
   * **The two IPv6 tests moved to `apps/gateway`** (ADR-0049).
   *
   * They asserted that a client rotating the bits it owns inside its own /64 stays one source, and
   * that two different /64s stay two. Both are now properties of the hash the gateway computes — this
   * Worker is handed a finished `x-nport-source-hash` and could not tell an IPv6 client from an IPv4
   * one. Keeping them here would have meant `sourceFor()` inventing an identity per address and the
   * assertions passing for a reason unrelated to the folding they are named for.
   *
   * `apps/gateway/test/dispatch.test.ts` § "IPv6, end to end" now holds the end-to-end pair, and
   * `packages/worker-kit/src/ip-hash.test.ts` the fourteen unit cases underneath them.
   */

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

    // **And it reaches the HTTP layer**, which is the field standard tooling and our own retry ladder
    // look at. This used to be absent: the response carried the exact instant it frees up in the body
    // and no header at all, while `src/index.ts` claimed every 429 carried one.
    const header = refused.headers.get("retry-after")
    expect(header).not.toBeNull()
    const seconds = Number(header)
    expect(seconds).toBeGreaterThanOrEqual(1)
    // An hour is the window, so the header can never sensibly exceed it.
    expect(seconds).toBeLessThanOrEqual(3600)

    // And nothing was provisioned.
    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("gives a concurrency refusal no Retry-After, because waiting does not help", async () => {
    // The deliberate asymmetry. A source at its concurrency cap frees a slot by *closing* a tunnel,
    // not by waiting — so a `Retry-After` there would invite exactly the loop it should discourage.
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    const ip = "203.0.113.70"
    for (let index = 0; index < limit; index += 1) {
      expect((await create(ip, `noretry${index}`)).status).toBe(201)
    }

    const refused = await create(ip, "onemore")
    expect(refused.status).toBe(429)
    expect(await codeOf(refused)).toBe("CONCURRENCY_LIMIT")
    expect(refused.headers.get("retry-after")).toBeNull()
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
 * Named by the forwarded source hash, which is the only handle this Worker ever has on a caller — it
 * never sees an address at all now, which is a stronger version of the property this comment used to
 * describe.
 */
async function quotaFor(ip: string) {
  return env.SOURCE_QUOTA.get(env.SOURCE_QUOTA.idFromName(sourceFor(ip)))
}

async function usage(ip: string): Promise<{ holds: number; createsThisHour: number }> {
  return (await quotaFor(ip)).usage()
}

/**
 * **The request-rate limiter moved to `apps/gateway`** (ADR-0049), and the two tests that drove it.
 *
 * They asserted that a flood of `/v1/meta` engages the limiter with `RATE_LIMITED` and `Retry-After:
 * 60`, and that one noisy source does not limit a quiet one. The `RATE_LIMITER` binding is not
 * declared on this Worker any more, so both would have passed by never engaging — a flood that is
 * never refused looks exactly like a flood that is allowed, and the second test in particular would
 * have gone on asserting a 200 for a source that was never at risk.
 *
 * `apps/gateway/test/dispatch.test.ts` § "the request-rate limiter" holds both, still end to end and
 * still against `workerd`'s real limiter rather than a stub.
 *
 * **Three layers still apply here**, and the rest of this file tests them: what a source may *hold*
 * and *create* (`SourceQuota`), what a create *costs* (proof of work), and the global ceiling
 * (`Registry`). `docs/ARCHITECTURE.md` §7 has the layering, with the limiter now at the gateway.
 */

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

describe("the concurrency cap against a source re-requesting its own name", () => {
  it("cannot be evaded by asking again for a name it already holds", async () => {
    // `reserve` exempts a name the source already holds from the cap, so that a client retrying a
    // create for a subdomain it is already provisioning does not spend a second slot. That exemption
    // must not extend to a name whose lease is already *live* — and the failure path that hands a
    // reservation back must not hand back a confirmed hold.
    const limit = Number(env.MAX_CONCURRENT_PER_SOURCE)
    const ip = "203.0.113.90"

    for (let index = 0; index < limit; index += 1) {
      expect((await create(ip, `own${index}`)).status, `create ${index}`).toBe(201)
    }

    // Asking again for a name it already holds is refused by the lease, which is correct.
    expect((await create(ip, "own0")).status).toBe(409)

    // The refusal must leave the source exactly where it was: at its cap, holding three live leases.
    const extra = await create(ip, "extra")
    expect(extra.status).toBe(429)
    expect(await codeOf(extra)).toBe("CONCURRENCY_LIMIT")
    expect(cloudflare.tunnels.size).toBe(limit)
  })
})
