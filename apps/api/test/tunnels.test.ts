/**
 * The lease lifecycle, as a client sees it.
 *
 * Through `SELF.fetch`, so middleware, routing, validation, the Durable Objects, and the error
 * handler all participate — in real `workerd`, with real Durable Object storage and real alarms
 * (`docs/TESTING.md`). Cloudflare itself is the only fake, and it is a stateful one, because "nothing
 * was left behind" is a claim about state.
 */

import {
  listDurableObjectIds,
  reset,
  runInDurableObject,
  SELF,
  env as testEnv,
} from "cloudflare:test"
import { hasLeadingZeroBits, solveChallenge } from "@nport/worker-kit"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Env } from "../src/types"
import { FakeCloudflare } from "./fake-cloudflare"

const env = testEnv as unknown as Env

const UA = "nport/3.0.0 (darwin; arm64)"

let cloudflare: FakeCloudflare
let originalDifficulty: number

beforeEach(() => {
  cloudflare = new FakeCloudflare()
  cloudflare.install()
  // The deployed floor is 20 bits — about 100 ms for a user, but slow and variable enough on a loaded
  // CI runner to make every test in this file flaky. 4 bits exercises the identical code path.
  originalDifficulty = env.POW_DIFFICULTY_BITS
  env.POW_DIFFICULTY_BITS = 4
})

afterEach(async () => {
  cloudflare.restore()
  env.POW_DIFFICULTY_BITS = originalDifficulty
  // Durable Object state does not reset itself between tests — see the note in `vitest.config.ts`.
  // Without this, a lease created here inflates the global count in the next test.
  await reset()
})

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://api.nport.link${path}`, {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** A solved challenge. Difficulty is lowered per-test so the work does not dominate the run. */
async function solvedChallenge(): Promise<{ challenge: string; nonce: string }> {
  const response = await SELF.fetch("https://api.nport.link/v1/challenge", {
    headers: { "user-agent": UA },
  })
  const body = (await response.json()) as { challenge: string; difficulty: number }
  return { challenge: body.challenge, nonce: await solveChallenge(body.challenge, body.difficulty) }
}

interface CreatedTunnel {
  subdomain: string
  url: string
  tunnelId: string
  tunnelToken: string
  ownerToken: string
  expiresAt: number
}

async function createTunnel(subdomain?: string) {
  const proof = await solvedChallenge()
  const response = await post("/v1/tunnels", {
    ...(subdomain === undefined ? {} : { subdomain }),
    ...proof,
    client: "cli",
  })
  return response
}

describe("POST /v1/tunnels", () => {
  it("provisions a tunnel and returns both credentials exactly once", async () => {
    const response = await createTunnel("myapp")
    expect(response.status).toBe(201)

    const body = (await response.json()) as CreatedTunnel
    expect(body.subdomain).toBe("myapp")
    expect(body.url).toBe(`https://myapp.${env.CF_DOMAIN}`)
    expect(body.tunnelToken.length).toBeGreaterThan(0)
    // 32 bytes, base64url — 43 characters with no padding.
    expect(body.ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    // Both sides actually exist at Cloudflare, and the DNS record points at the tunnel.
    expect([...cloudflare.tunnels.values()].map((t) => t.name)).toEqual(["nport-myapp"])
    const record = cloudflare.dns.get(`myapp.${env.CF_DOMAIN}`)
    expect(record).toMatchObject({ type: "CNAME", content: `${body.tunnelId}.cfargotunnel.com` })
  })

  it("provisions the same way when Cloudflare returns the token inline", async () => {
    // Which of the two shapes the live API answers with is unknown — the schema documents a create
    // response with no token and a dedicated token endpoint, while v2 read the token straight off a
    // create in production for years (`CloudflareClient.createTunnel`). Whichever it turns out to be,
    // the other branch is the one that will be dead code, so a passing suite must not depend on the
    // default. Every other test here covers the documented shape; this one covers v2's.
    cloudflare.tokenOnCreate = true

    const response = await createTunnel("inline")
    expect(response.status).toBe(201)
    expect(((await response.json()) as CreatedTunnel).tunnelToken.length).toBeGreaterThan(0)
    expect(cloudflare.calls).not.toContain("tunnel-token")
  })

  it("leaves nothing behind when the token cannot be fetched", async () => {
    // The failure this branch adds: the tunnel exists and its credential does not, which is the one
    // outcome worse than a failed create. `#provision`'s `create-tunnel` compensation has to cover it,
    // and it can only do so by name — which is why the name is derived rather than random.
    cloudflare.fail("tunnel-token", { status: 500 })

    const response = await createTunnel("notoken")
    expect(response.status).toBe(502)
    expect(cloudflare.tunnels.size).toBe(0)

    // And the name is free afterwards, which is what `PROVISION_FAILED` promises the caller.
    cloudflare.recover()
    expect((await createTunnel("notoken")).status).toBe(201)
  })

  it("stays inside the free plan's subrequest budget", async () => {
    // **A hard ceiling, not a guideline.** The free plan allows 50 subrequests per invocation and a
    // Durable Object call counts, so a saga that grows a step silently moves the whole request closer
    // to failing outright. `apps/api/CLAUDE.md` rule 13 and `docs/ARCHITECTURE.md` §6 both put a
    // number on provisioning; nothing asserted it until now, which is how a stated budget drifts.
    const created = await createTunnel("budget")
    expect(created.status).toBe(201)

    const provisioning = [...cloudflare.calls]
    expect(provisioning, `Cloudflare calls for one provision: ${provisioning.join(", ")}`).toEqual([
      "create-tunnel",
      "tunnel-token",
      "create-dns",
    ])

    const body = (await created.json()) as CreatedTunnel
    const before = cloudflare.calls.length
    const released = await SELF.fetch(`https://api.nport.link/v1/tunnels/budget`, {
      method: "DELETE",
      headers: { "user-agent": UA, "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: body.ownerToken }),
    })
    expect(released.status).toBe(204)

    // Teardown proves the record is ours before deleting it (invariant 8), so it costs a lookup the
    // provision does not: find-dns, delete-dns, clear-connections, delete-tunnel.
    const teardown = cloudflare.calls.slice(before)
    expect(teardown, `Cloudflare calls for one teardown: ${teardown.join(", ")}`).toEqual([
      "find-dns",
      "delete-dns",
      "clear-connections",
      "delete-tunnel",
    ])

    // The number the docs quote, and the reason it is quoted: both halves have to fit inside 50 with
    // the Durable Object hops and the platform's own overhead alongside them.
    expect(provisioning.length + teardown.length).toBeLessThanOrEqual(10)
  })

  it("never lets a credential be cached", async () => {
    // This body is the only time either token is issued. A cache on the path would be a credential
    // store nobody chose to build.
    const response = await createTunnel("cacheme")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("normalizes the requested name, so MyApp and MyApp.<this node's domain> are one claim", async () => {
    // **This node's own domain**, not a hardcoded `.nport.link`. Every node has its own (ADR-0031), and
    // this test used to assert `.nport.link` was stripped on a node whose `CF_DOMAIN` is `nport.test` —
    // encoding the assumption that there is only one zone in the world.
    const response = await createTunnel(`MyApp.${env.CF_DOMAIN}`)
    expect(response.status).toBe(201)
    expect(((await response.json()) as CreatedTunnel).subdomain).toBe("myapp")
  })

  it("does not treat another zone's hostname as a claim", async () => {
    // Deliberate, and the other half of the change above: a hostname on a domain this node does not
    // serve is not a request it can honour. Silently claiming `elsewhere` on *our* domain would hand
    // back a URL on a domain the user did not ask for, which is worse than refusing.
    const response = await createTunnel("elsewhere.someone-elses-zone.test")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INVALID_SUBDOMAIN")
  })

  it("generates an unguessable name when none is asked for", async () => {
    const body = (await (await createTunnel()).json()) as CreatedTunnel
    // `nport-` plus 13 base32 characters: 64 bits of entropy, against v2's 10,000-name space.
    expect(body.subdomain).toMatch(/^nport-[a-z2-7]{13}$/)
  })

  it("refuses a second claim on a live name, and says when it frees up", async () => {
    const first = (await (await createTunnel("taken")).json()) as CreatedTunnel

    const second = await createTunnel("taken")
    expect(second.status).toBe(409)
    const body = (await second.json()) as {
      error: { code: string; details?: { expiresAt: number } }
    }
    expect(body.error.code).toBe("SUBDOMAIN_IN_USE")
    // Without this a CLI can only say "try another name", which is the wrong advice for a name that
    // frees up in a minute.
    expect(body.error.details?.expiresAt).toBe(first.expiresAt)

    // And nothing was provisioned for the loser.
    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("serializes concurrent claims on one name instead of racing them", async () => {
    // The v2 defect this closes (R4): both callers created a tunnel, and the losing DNS write was
    // swallowed, leaving an orphan. One Durable Object per name makes that impossible.
    const proofs = await Promise.all([solvedChallenge(), solvedChallenge()])
    const responses = await Promise.all(
      proofs.map((proof) => post("/v1/tunnels", { subdomain: "racy", ...proof, client: "cli" })),
    )

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    // Exactly one tunnel, not two — this is the assertion that would have failed against v2.
    expect(cloudflare.tunnels.size).toBe(1)
    expect(cloudflare.dns.size).toBe(1)
  })

  it("rejects a reserved name with 403, not with a generic validation error", async () => {
    // v2 reserved exactly `['api']`, leaving `www`, `admin`, and `_dmarc` claimable — so an anonymous
    // caller could take the name that receives our mail or answers our ACME challenges (defect R10).
    // Asserted per name rather than as a set of acceptable statuses: "one of 400 or 403" would pass
    // even if every one of these came back as a plain validation error.
    for (const name of ["api", "www", "login", "admin", "paypal"]) {
      const response = await createTunnel(name)
      expect(response.status, name).toBe(403)
      expect(((await response.json()) as { error: { code: string } }).error.code, name).toBe(
        "SUBDOMAIN_RESERVED",
      )
    }

    // `_dmarc` is different in kind: an underscore can never pass the pattern, so it is a malformed
    // name rather than a reserved one, and the reason it gives has to say so.
    const dmarc = await createTunnel("_dmarc")
    expect(dmarc.status).toBe(400)
    const body = (await dmarc.json()) as { error: { code: string; details?: { reason: string } } }
    expect(body.error.code).toBe("INVALID_SUBDOMAIN")
    expect(body.error.details?.reason).toBe("invalid-characters")

    // Nothing was provisioned for any of them.
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
  })

  it("reports why a name was rejected", async () => {
    const response = await createTunnel("ab")
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { code: string; details?: { reason: string } }
    }
    expect(body.error.code).toBe("INVALID_SUBDOMAIN")
    // "Invalid" alone is useless to someone who typed two characters.
    expect(body.error.details?.reason).toBe("too-short")
  })

  it("validates the name before spending the challenge, so a typo is not expensive", async () => {
    const proof = await solvedChallenge()
    const rejected = await post("/v1/tunnels", { subdomain: "ab", ...proof, client: "cli" })
    expect(rejected.status).toBe(400)

    // The same proof still works, because the first attempt never redeemed it.
    const accepted = await post("/v1/tunnels", { subdomain: "goodname", ...proof, client: "cli" })
    expect(accepted.status).toBe(201)
  })

  it("refuses a replayed challenge", async () => {
    // Without the ledger, one solved challenge creates unlimited tunnels inside its two-minute
    // window, and proof-of-work stops being a per-tunnel cost at all.
    const proof = await solvedChallenge()
    expect(
      (await post("/v1/tunnels", { subdomain: "firstuse", ...proof, client: "cli" })).status,
    ).toBe(201)

    const replay = await post("/v1/tunnels", { subdomain: "seconduse", ...proof, client: "cli" })
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("POW_INVALID")
  })

  it("refuses an unsolved challenge", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/challenge", {
      headers: { "user-agent": UA },
    })
    const { challenge, difficulty } = (await response.json()) as {
      challenge: string
      difficulty: number
    }

    // A nonce that is *verified* not to satisfy the difficulty, rather than a hardcoded "0". At the
    // 4-bit difficulty these tests run at, "0" satisfies the challenge one time in sixteen — so the
    // hardcoded version was a 6%-flaky test asserting that proof of work is enforced, which is the
    // worst possible thing to be flaky about. It passed for several runs before failing.
    let nonce = 0
    while (await hasLeadingZeroBits(`${challenge}.${nonce}`, difficulty)) {
      nonce += 1
    }

    const created = await post("/v1/tunnels", {
      subdomain: "nowork",
      challenge,
      nonce: String(nonce),
      client: "cli",
    })
    expect(created.status).toBe(400)
    expect(((await created.json()) as { error: { code: string } }).error.code).toBe("POW_INVALID")
  })

  it("refuses a forged challenge as invalid rather than as expired", async () => {
    // A forged `exp` in the past must not be reported as `CHALLENGE_EXPIRED`, which is retryable —
    // that is why `verifyChallenge` checks the signature first.
    const forged = `${btoa(JSON.stringify({ exp: 1, bits: 4, salt: "x" }))}.abcd`
    const created = await post("/v1/tunnels", { challenge: forged, nonce: "0", client: "cli" })
    expect(created.status).toBe(400)
    expect(((await created.json()) as { error: { code: string } }).error.code).toBe("POW_INVALID")
  })

  it("treats an empty challenge as POW_REQUIRED", async () => {
    const created = await post("/v1/tunnels", { challenge: "", nonce: "", client: "cli" })
    expect(created.status).toBe(428)
    expect(((await created.json()) as { error: { code: string } }).error.code).toBe("POW_REQUIRED")
  })

  it("refuses an oversized nonce before hashing it", async () => {
    // The challenge and the nonce are both hashed before anything about them is trusted, so an
    // unbounded one costs the sender bandwidth and the server proportional CPU ahead of any check
    // that could reject it. `subdomain` was bounded for exactly this reason and these were not.
    const proof = await solvedChallenge()
    const response = await post("/v1/tunnels", {
      subdomain: "bignonce",
      challenge: proof.challenge,
      nonce: "0".repeat(100_000),
      client: "cli",
    })

    expect(response.status).toBe(400)
    expect(cloudflare.calls).toEqual([])
  })

  it("refuses an oversized challenge before verifying it", async () => {
    const response = await post("/v1/tunnels", {
      subdomain: "bigchallenge",
      challenge: `${"A".repeat(100_000)}.${"B".repeat(100_000)}`,
      nonce: "0",
      client: "cli",
    })

    expect(response.status).toBe(400)
    expect(cloudflare.calls).toEqual([])
  })

  it("answers a malformed body with our envelope, not the validator's", async () => {
    const created = await post("/v1/tunnels", { client: "browser" })
    expect(created.status).toBe(400)
    const body = (await created.json()) as { error: { code: string; docsUrl: string } }
    expect(body.error.code).toBe("INVALID_REQUEST")
    expect(body.error.docsUrl).toBe("https://nport.link/errors/invalid-request")
  })

  it("refuses to exceed the global cap, with Retry-After", async () => {
    const original = env.MAX_ACTIVE_TUNNELS
    try {
      env.MAX_ACTIVE_TUNNELS = 1
      expect((await createTunnel("first")).status).toBe(201)

      const response = await createTunnel("second")
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "CAPACITY_EXHAUSTED",
      )
      // docs/API.md tells clients to honour it, so every 503 must carry one.
      expect(response.headers.get("retry-after")).toBe("30")
    } finally {
      env.MAX_ACTIVE_TUNNELS = original
    }
  })

  it("leaves nothing behind when DNS creation fails", async () => {
    // v2's central provisioning defect (R3): the tunnel was created, the DNS write failed, and the
    // tunnel stayed forever with nothing pointing at it.
    cloudflare.fail("create-dns", { status: 500 })

    const response = await createTunnel("dnsfails")
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UPSTREAM_CLOUDFLARE_ERROR",
    )

    // The promise `PROVISION_FAILED` makes — "Nothing was left behind" — as an assertion.
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)

    // And the name is free again, once Cloudflare is healthy.
    cloudflare.recover()
    expect((await createTunnel("dnsfails")).status).toBe(201)
  })

  it("leaves nothing behind when the tunnel cannot be created", async () => {
    cloudflare.fail("create-tunnel", { status: 500 })

    const response = await createTunnel("tunnelfails")
    expect(response.status).toBe(502)
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
  })

  it("retries a transient Cloudflare failure rather than failing the caller", async () => {
    cloudflare.fail("create-tunnel", { status: 429, times: 1 })

    expect((await createTunnel("flaky")).status).toBe(201)
    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("refuses a name whose DNS record NPort cannot prove it owns", async () => {
    // Invariant 8. v2 would have deleted this record — its takeover path was a deliberate feature.
    cloudflare.seedDns(`squatted.${env.CF_DOMAIN}`, "A", "203.0.113.7")

    const response = await createTunnel("squatted")
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("DNS_CONFLICT")

    // The foreign record survives untouched, and our tunnel was rolled back.
    expect(cloudflare.dns.get(`squatted.${env.CF_DOMAIN}`)).toMatchObject({ type: "A" })
    expect(cloudflare.tunnels.size).toBe(0)
  })
})

describe("POST /v1/tunnels/:subdomain/heartbeat", () => {
  it("renews a lease and reports the authoritative expiry", async () => {
    const created = (await (await createTunnel("beating")).json()) as CreatedTunnel

    const response = await post("/v1/tunnels/beating/heartbeat", { ownerToken: created.ownerToken })
    expect(response.status).toBe(200)
    expect((await response.json()) as { expiresAt: number }).toEqual({
      expiresAt: created.expiresAt,
    })
  })

  it("does not extend the lease", async () => {
    // The four-hour ceiling is server-authoritative. v2's was a client-side `setTimeout` (R6).
    const created = (await (await createTunnel("noextend")).json()) as CreatedTunnel
    const after = (await (
      await post("/v1/tunnels/noextend/heartbeat", { ownerToken: created.ownerToken })
    ).json()) as { expiresAt: number }
    expect(after.expiresAt).toBe(created.expiresAt)
  })

  it("rejects a heartbeat from anyone but the creator", async () => {
    await createTunnel("mine")

    const response = await post("/v1/tunnels/mine/heartbeat", {
      ownerToken: "A".repeat(43),
    })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_OWNER_TOKEN",
    )
  })

  it("reports an unknown subdomain as not found", async () => {
    const response = await post("/v1/tunnels/nosuchname/heartbeat", { ownerToken: "A".repeat(43) })
    expect(response.status).toBe(404)
  })

  it("works for a generated name", async () => {
    // The regression this guards: `nport-` is a reserved prefix, so validating a path parameter with
    // the claim validator would make every generated tunnel unable to heartbeat or delete itself.
    const created = (await (await createTunnel()).json()) as CreatedTunnel
    const response = await post(`/v1/tunnels/${created.subdomain}/heartbeat`, {
      ownerToken: created.ownerToken,
    })
    expect(response.status).toBe(200)
  })
})

describe("DELETE /v1/tunnels/:subdomain", () => {
  async function del(subdomain: string, ownerToken: string) {
    return SELF.fetch(`https://api.nport.link/v1/tunnels/${subdomain}`, {
      method: "DELETE",
      headers: { "user-agent": UA, "content-type": "application/json" },
      body: JSON.stringify({ ownerToken }),
    })
  }

  it("tears down both sides and frees the name", async () => {
    const created = (await (await createTunnel("goodbye")).json()) as CreatedTunnel

    expect((await del("goodbye", created.ownerToken)).status).toBe(204)
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)

    // Reclaimable immediately, because teardown completed rather than being assumed.
    expect((await createTunnel("goodbye")).status).toBe(201)
  })

  it("is idempotent", async () => {
    const created = (await (await createTunnel("twice")).json()) as CreatedTunnel

    expect((await del("twice", created.ownerToken)).status).toBe(204)
    // v2 reported an error for the second Ctrl+C's DELETE (R19).
    expect((await del("twice", created.ownerToken)).status).toBe(204)
  })

  it("refuses a delete from anyone but the creator", async () => {
    const created = (await (await createTunnel("protected")).json()) as CreatedTunnel

    const response = await del("protected", "B".repeat(43))
    expect(response.status).toBe(403)
    // v2 accepted `{subdomain, tunnelId}` from anyone, so any caller could remove any tunnel —
    // including the `api` record itself.
    expect(cloudflare.tunnels.size).toBe(1)
    expect(cloudflare.dns.size).toBe(1)

    // The real owner still can.
    expect((await del("protected", created.ownerToken)).status).toBe(204)
  })

  it("will not delete a DNS record that no longer points at its tunnel", async () => {
    const created = (await (await createTunnel("repointed")).json()) as CreatedTunnel
    // Somebody repointed the record out from under us. Deleting it now would be deleting a record we
    // cannot prove we own (invariant 8).
    cloudflare.dns.set(`repointed.${env.CF_DOMAIN}`, {
      id: "rec-foreign",
      name: `repointed.${env.CF_DOMAIN}`,
      type: "CNAME",
      content: "someone-elses-tunnel.cfargotunnel.com",
    })

    const response = await del("repointed", created.ownerToken)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("DNS_CONFLICT")

    // The record survives; the tunnel, which we can prove is ours by its `nport-` name, does not.
    expect(cloudflare.dns.get(`repointed.${env.CF_DOMAIN}`)?.id).toBe("rec-foreign")
    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("rejects a malformed subdomain before it can become a Durable Object", async () => {
    const before = (await listDurableObjectIds(env.SUBDOMAIN_LEASE)).length
    const response = await del("bad_name", "C".repeat(43))
    expect(response.status).toBe(400)
    expect((await listDurableObjectIds(env.SUBDOMAIN_LEASE)).length).toBe(before)
  })
})

describe("GET /v1/tunnels/:subdomain", () => {
  it("reports an active lease without leaking anything", async () => {
    const created = (await (await createTunnel("public")).json()) as CreatedTunnel

    const response = await SELF.fetch("https://api.nport.link/v1/tunnels/public", {
      headers: { "user-agent": UA },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toEqual({ subdomain: "public", active: true, expiresAt: created.expiresAt })
    // Deliberately absent: anything an attacker could use.
    const text = JSON.stringify(body)
    expect(text).not.toContain(created.tunnelId)
    expect(text).not.toContain(created.tunnelToken)
    expect(text).not.toContain(created.ownerToken)
  })

  it("reports a free name as not found", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/tunnels/unclaimed", {
      headers: { "user-agent": UA },
    })
    expect(response.status).toBe(404)
  })

  it("reports an expired-but-unreaped lease as inactive", async () => {
    const created = (await (await createTunnel("stale")).json()) as CreatedTunnel
    expect(created.subdomain).toBe("stale")

    // Push the expiry into the past without running the alarm, which is exactly the window between
    // a lease expiring and its alarm firing.
    const stub = env.SUBDOMAIN_LEASE.get(env.SUBDOMAIN_LEASE.idFromName("stale"))
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE lease SET expires_at = ?", Date.now() - 1000)
    })

    const response = await SELF.fetch("https://api.nport.link/v1/tunnels/stale", {
      headers: { "user-agent": UA },
    })
    const body = (await response.json()) as { active: boolean }
    // Reporting `active: true` here would make this endpoint disagree with whether the URL works.
    expect(body.active).toBe(false)
  })
})

describe("GET /v1/meta capacity", () => {
  /**
   * The number federation actually selects on (ADR-0046), driven through a real create.
   *
   * `test/routes.test.ts` asserts the fields exist and read from the environment; this asserts the
   * count *counts*. A count that is always zero is not a count — and zero is the value that makes a
   * node look emptiest and get picked first by every client, so it is the wrong way to be wrong.
   */
  it("counts a live tunnel, and stops counting it after a release", async () => {
    const meta = async () => {
      const response = await SELF.fetch("https://api.nport.link/v1/meta", {
        headers: { "user-agent": UA },
      })
      return (await response.json()) as { activeTunnels: number; maxActiveTunnels: number }
    }

    const before = await meta()
    expect(before.maxActiveTunnels).toBe(Number(env.MAX_ACTIVE_TUNNELS))

    const created = (await (await createTunnel("counted")).json()) as CreatedTunnel
    expect((await meta()).activeTunnels).toBe(before.activeTunnels + 1)

    const deleted = await SELF.fetch("https://api.nport.link/v1/tunnels/counted", {
      method: "DELETE",
      headers: { "user-agent": UA, "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: created.ownerToken }),
    })
    expect(deleted.status).toBe(204)

    // Back down again. A count that only ever rose would report a node as full forever, which is a
    // node quietly removing itself from every client's selection.
    expect((await meta()).activeTunnels).toBe(before.activeTunnels)
  })
})

describe("a node accepts back the URL it handed out", () => {
  /**
   * **The bug federation introduced.** `apps/api` builds a tunnel's URL from `CF_DOMAIN`, but
   * `checkSubdomain` normalizes against the hardcoded `.nport.link` — so a node on any other domain
   * hands out a URL it then refuses. Pasting your own tunnel's hostname back into `-s` is the exact
   * case the zone-suffix strip exists for.
   */
  it("takes its own hostname as a claim for the name inside it", async () => {
    const created = (await (await createTunnel("pasted")).json()) as CreatedTunnel
    expect(created.url).toBe(`https://pasted.${env.CF_DOMAIN}`)

    await SELF.fetch(`https://api.nport.link/v1/tunnels/pasted`, {
      method: "DELETE",
      headers: { "user-agent": UA, "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: created.ownerToken }),
    })

    // The hostname this node just issued, pasted back as the requested subdomain.
    const again = await post("/v1/tunnels", {
      subdomain: `pasted.${env.CF_DOMAIN}`,
      ...(await solvedChallenge()),
      client: "cli",
    })
    const body = (await again.json()) as { subdomain?: string; error?: { code: string } }
    expect(again.status, JSON.stringify(body)).toBe(201)
    expect(body.subdomain).toBe("pasted")
  })
})
