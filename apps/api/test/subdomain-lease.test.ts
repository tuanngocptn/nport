/**
 * The lease Durable Object at close range.
 *
 * `test/tunnels.test.ts` covers what a client sees. This file covers what a client cannot reach: the
 * alarm, the watchdog, and what survives an isolate dying mid-saga. Those are the paths
 * `docs/ARCHITECTURE.md` §5 makes promises about, and they are unreachable through HTTP by definition
 * — the whole point is that nobody is there to make the request.
 *
 * Real alarms in real `workerd`, driven with `runDurableObjectAlarm`. A mocked Durable Object would
 * prove nothing here (`docs/TESTING.md`).
 */

import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  env as testEnv,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { SubdomainLease } from "../src/do/subdomain-lease"
import { hashOwnerToken, mintOwnerToken } from "../src/domain/owner-token"
import type { Env } from "../src/types"
import { FakeCloudflare } from "./fake-cloudflare"

const env = testEnv as unknown as Env

/** Comfortably past `WATCHDOG_MS`, which is 30 s and not exported. */
const WATCHDOG_OVERSHOOT_MS = 60_000

let cloudflare: FakeCloudflare

beforeEach(() => {
  cloudflare = new FakeCloudflare()
  cloudflare.install()
})

afterEach(async () => {
  cloudflare.restore()
  // Durable Object state does not reset itself between tests — see the note in `vitest.config.ts`.
  await reset()
})

function lease(subdomain: string): DurableObjectStub<SubdomainLease> {
  return env.SUBDOMAIN_LEASE.get(env.SUBDOMAIN_LEASE.idFromName(subdomain))
}

async function claim(subdomain: string) {
  const ownerToken = mintOwnerToken()
  const result = await lease(subdomain).claim({
    subdomain,
    ownerTokenHash: await hashOwnerToken(ownerToken),
    ipHash: "test-source",
    clientVersion: "nport/3.0.0 (test; test)",
  })
  return { ownerToken, result }
}

/** Rewrites stored columns, standing in for time passing. */
async function patchRow(subdomain: string, columns: Record<string, string | number | null>) {
  const assignments = Object.keys(columns)
    .map((column) => `${column} = ?`)
    .join(", ")
  await runInDurableObject(lease(subdomain), (_instance, state) => {
    state.storage.sql.exec(`UPDATE lease SET ${assignments}`, ...Object.values(columns))
  })
}

async function readRow(subdomain: string): Promise<Record<string, unknown> | undefined> {
  return runInDurableObject(
    lease(subdomain),
    (_instance, state) => state.storage.sql.exec("SELECT * FROM lease").toArray()[0],
  )
}

describe("expiry", () => {
  it("reaps the lease when its alarm fires past the hard expiry", async () => {
    const { result } = await claim("expiring")
    expect(result.ok).toBe(true)
    expect(cloudflare.tunnels.size).toBe(1)

    await patchRow("expiring", { expires_at: Date.now() - 1000 })

    expect(await runDurableObjectAlarm(lease("expiring"))).toBe(true)

    // Both sides gone, and the lease with them. This is what makes expiry server-authoritative
    // rather than a client-side `setTimeout` (defect R6).
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
    expect(await readRow("expiring")).toBeUndefined()
  })

  it("reaps a lease that stopped heartbeating, even with time left on it", async () => {
    await claim("silent")
    const graceMs = Number(env.HEARTBEAT_GRACE_SECONDS) * 1000

    // Hard expiry is hours away; the heartbeat is older than the grace period. `min()` of the two is
    // what the alarm honours (`docs/ARCHITECTURE.md` §3e) — this is the SIGKILLed-connector case.
    await patchRow("silent", { last_heartbeat_at: Date.now() - graceMs - 1000 })

    expect(await runDurableObjectAlarm(lease("silent"))).toBe(true)
    expect(await readRow("silent")).toBeUndefined()
    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("re-arms rather than reaping a healthy lease", async () => {
    await claim("healthy")

    // A spurious or early alarm must not end a live tunnel. Durable Object alarms are at-least-once,
    // so this is not a hypothetical.
    expect(await runDurableObjectAlarm(lease("healthy"))).toBe(true)

    expect(await readRow("healthy")).toMatchObject({ state: "ACTIVE" })
    expect(cloudflare.tunnels.size).toBe(1)
    // And it left itself another alarm, or nothing would ever reap it.
    const pending = await runInDurableObject(lease("healthy"), (_instance, state) =>
      state.storage.getAlarm(),
    )
    expect(pending).not.toBeNull()
  })

  it("frees the name for the next caller once teardown has completed", async () => {
    await claim("recycled")
    await patchRow("recycled", { expires_at: Date.now() - 1000 })
    await runDurableObjectAlarm(lease("recycled"))

    const { result } = await claim("recycled")
    expect(result.ok).toBe(true)
  })
})

describe("the saga watchdog", () => {
  it("compensates a saga abandoned by a dead isolate", async () => {
    // The failure `docs/ARCHITECTURE.md` §5 calls "isolate dies mid-saga". Reconstructed exactly:
    // a journal entry saying a tunnel may exist, a tunnel that does, and no live saga to finish it.
    await claim("abandoned")
    const tunnelId = [...cloudflare.tunnels.keys()][0]
    expect(tunnelId).toBeDefined()

    await patchRow("abandoned", {
      state: "TUNNEL_CREATED",
      saga_step: "create-dns",
      // Older than the watchdog window, which is what tells the alarm the saga is not merely slow.
      created_at: Date.now() - 60_000,
    })
    // Tear down the instance so the in-memory `#inFlight` guard is gone — the same reason the real
    // failure needs a watchdog at all.
    await evictDurableObject(lease("abandoned"))

    expect(await runDurableObjectAlarm(lease("abandoned"))).toBe(true)

    // No orphan persists: the promise `PROVISION_FAILED` makes, kept by the alarm rather than by the
    // request that failed.
    expect(cloudflare.tunnels.size).toBe(0)
    expect(await readRow("abandoned")).toBeUndefined()
  })

  it("finds a tunnel by name when the isolate died before the ID was journaled", async () => {
    // The narrowest window in the whole design: `createTunnel` returned at Cloudflare but its ID was
    // never written. Deleting by ID is impossible, so compensation looks the tunnel up by the name
    // NPort derived — which is the reason the name is derived instead of random.
    await claim("nameless")
    await patchRow("nameless", {
      tunnel_id: null,
      state: "CLAIMING",
      saga_step: "create-tunnel",
      created_at: Date.now() - 60_000,
    })
    await evictDurableObject(lease("nameless"))

    expect(await runDurableObjectAlarm(lease("nameless"))).toBe(true)

    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.calls).toContain("find-tunnel")
  })

  it("does not compensate a saga that is only slow", async () => {
    // A saga still inside its watchdog window must be left alone. (The other half of that guard —
    // the in-memory `#inFlight` check, for a saga that is slow *past* the window — is not reachable
    // from a test, because it needs an alarm to fire while a claim is mid-await.)
    await claim("slow")
    await patchRow("slow", { state: "TUNNEL_CREATED", saga_step: "create-dns" })

    expect(await runDurableObjectAlarm(lease("slow"))).toBe(true)

    // Still mid-saga, nothing deleted, and the alarm pushed itself out.
    expect(await readRow("slow")).toMatchObject({ state: "TUNNEL_CREATED" })
    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("retries a teardown that Cloudflare refused", async () => {
    await claim("stubborn")
    cloudflare.fail("find-dns", { status: 500 })
    await patchRow("stubborn", { expires_at: Date.now() - 1000 })

    await runDurableObjectAlarm(lease("stubborn"))

    // The lease stays in RELEASING: freeing the name while a tunnel and a DNS record still point at
    // it is precisely the takeover v3 forbids (defect R7).
    expect(await readRow("stubborn")).toMatchObject({ state: "RELEASING" })
    expect(cloudflare.tunnels.size).toBe(1)

    // A later alarm, with Cloudflare healthy again, completes it.
    cloudflare = new FakeCloudflare()
    cloudflare.install()
    // Rebuild the Cloudflare-side state the previous fake was holding.
    const row = await readRow("stubborn")
    const tunnelId = String(row?.tunnel_id)
    cloudflare.tunnels.set(tunnelId, { id: tunnelId, name: "nport-stubborn" })
    cloudflare.seedDns(`stubborn.${env.CF_DOMAIN}`, "CNAME", `${tunnelId}.cfargotunnel.com`)

    expect(await runDurableObjectAlarm(lease("stubborn"))).toBe(true)
    expect(await readRow("stubborn")).toBeUndefined()
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
  })

  it("will not hand out a name whose teardown is unconfirmed", async () => {
    await claim("held")
    cloudflare.fail("find-dns", { status: 500 })
    await patchRow("held", { expires_at: Date.now() - 1000 })
    await runDurableObjectAlarm(lease("held"))

    const { result } = await claim("held")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("SUBDOMAIN_IN_USE")
    }
  })
})

describe("ownership", () => {
  it("stores only the hash of the owner token", async () => {
    const { ownerToken } = await claim("hashed")
    const row = await readRow("hashed")

    const stored = row?.owner_token_hash
    expect(stored).toBeInstanceOf(ArrayBuffer)
    // The token itself must appear nowhere in storage. There is deliberately no endpoint that can
    // return it either — an API that re-issues a credential to an anonymous caller has no ownership
    // model at all (`docs/ARCHITECTURE.md` §7).
    expect(JSON.stringify(row)).not.toContain(ownerToken)
    expect(new Uint8Array(stored as ArrayBuffer)).toEqual(await hashOwnerToken(ownerToken))
  })

  it("rejects a near-miss token", async () => {
    const { ownerToken } = await claim("nearmiss")
    // One character different. Comparison is over digests and constant-time, so a near miss is
    // exactly as wrong as any other.
    const tampered = `${ownerToken.slice(0, -1)}${ownerToken.endsWith("A") ? "B" : "A"}`

    const result = await lease("nearmiss").heartbeat(await hashOwnerToken(tampered))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("INVALID_OWNER_TOKEN")
    }
  })

  it("reports an expired lease as expired rather than as missing", async () => {
    // The distinction matters to a CLI: `LEASE_EXPIRED` means "your four hours are up", while
    // `TUNNEL_NOT_FOUND` means "you are asking about something that never existed".
    const { ownerToken } = await claim("timedout")
    await patchRow("timedout", { expires_at: Date.now() - 1000 })

    const result = await lease("timedout").heartbeat(await hashOwnerToken(ownerToken))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("LEASE_EXPIRED")
    }
  })
})

describe("storage", () => {
  it("keeps one row per object and never a raw IP", async () => {
    await claim("oneRow".toLowerCase())
    const rows = await runInDurableObject(lease("onerow"), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM lease").toArray(),
    )
    expect(rows.length).toBe(1)
    // Source identity is `HMAC(ip, secret)` and nothing else (rule 11).
    expect(rows[0]).toMatchObject({ ip_hash: "test-source" })
  })

  it("survives an eviction, because the journal is on disk and not in memory", async () => {
    const { ownerToken } = await claim("durable")
    await evictDurableObject(lease("durable"))

    const result = await lease("durable").heartbeat(await hashOwnerToken(ownerToken))
    expect(result.ok).toBe(true)
  })
})

describe("reclaiming an expired lease", () => {
  it("does not let two concurrent claims both win", async () => {
    // Honest note on what this does and does not prove: the second claim is refused early, on seeing
    // `RELEASING`, so it never reaches the window that motivated splitting `#clearLease` out of
    // `#teardown`. That window — the row absent across an `await` — is closed by statement order
    // rather than by anything this test can schedule. The test is still worth keeping: it pins the
    // early-refusal path, which is what makes the common case safe.
    await claim("contested")
    await patchRow("contested", { expires_at: Date.now() - 1000 })

    const outcomes = await Promise.all([claim("contested"), claim("contested")])

    expect(outcomes.filter((outcome) => outcome.result.ok).length).toBe(1)
    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("gives the reclaimed lease a fresh watchdog window", async () => {
    // This one *is* provable, and it is the reason reclaim can no longer delete the row. With the row
    // preserved, `#write` is an UPDATE — and `created_at` was excluded from the UPDATE, so the new
    // lease inherited the dead one's creation time. Its watchdog window was therefore already in the
    // past, and `#isReclaimable` would have handed the name straight to the next caller mid-saga.
    await claim("handover")
    const original = await readRow("handover")
    await patchRow("handover", { expires_at: Date.now() - 1000, created_at: Date.now() - 600_000 })

    const { result } = await claim("handover")
    expect(result.ok).toBe(true)

    const reclaimed = await readRow("handover")
    expect(Number(reclaimed?.created_at)).toBeGreaterThan(Number(original?.created_at) - 1)
    expect(Number(reclaimed?.created_at)).toBeGreaterThan(Date.now() - 60_000)

    // And the freshly claimed lease is not reclaimable by the next caller.
    const { result: intruder } = await claim("handover")
    expect(intruder.ok).toBe(false)
    if (!intruder.ok) {
      expect(intruder.code).toBe("SUBDOMAIN_IN_USE")
    }
  })

  it("hands over ownership, so the previous owner's token stops working", async () => {
    const first = await claim("changedhands")
    await patchRow("changedhands", { expires_at: Date.now() - 1000 })

    const second = await claim("changedhands")
    expect(second.result.ok).toBe(true)

    const stale = await lease("changedhands").heartbeat(await hashOwnerToken(first.ownerToken))
    expect(stale.ok).toBe(false)
    const fresh = await lease("changedhands").heartbeat(await hashOwnerToken(second.ownerToken))
    expect(fresh.ok).toBe(true)
  })
})

describe("a saga slower than its watchdog window", () => {
  it("keeps its name, and never leaves a tunnel without a lease", async () => {
    // The reachable version of the bug the `#inFlight` guard exists to stop, and the one the guard
    // was missing from. `#isReclaimable` judged a mid-saga row purely on the wall clock, and its
    // comment claimed that meant "the isolate that started it is gone" — without checking. A saga
    // slower than the watchdog window is not exotic: twelve Cloudflare calls with backoff, during an
    // incident where each one hangs, gets there easily.
    //
    // With the guard missing, the second claim tore the first saga's lease out from under it. The
    // first saga then wrote its own ACTIVE row back over the second's, and the loser's compensation
    // deleted the row entirely — leaving a live tunnel and DNS record with **no lease**, so nothing
    // would ever reap them. That is defect R3 arriving from the opposite direction.
    cloudflare.slow("create-tunnel", 400)

    const first = claim("slowsaga")
    // Let the saga get inside `createTunnel`, then age its journal entry past the watchdog window.
    // Rewriting `created_at` stands in for 30 seconds passing.
    await new Promise((resolve) => setTimeout(resolve, 120))
    await patchRow("slowsaga", { created_at: Date.now() - WATCHDOG_OVERSHOOT_MS })

    const second = await claim("slowsaga")
    const firstResult = await first

    // The in-flight saga keeps its name — it was there first, and it is still running. Asserting this
    // rather than merely "one of them won" is what separates the two guards: the row-identity check
    // alone would also avoid the orphan, but by making the *first* caller lose.
    expect(firstResult.result.ok).toBe(true)
    expect(second.result.ok).toBe(false)
    if (!second.result.ok) {
      expect(second.result.code).toBe("SUBDOMAIN_IN_USE")
    }

    // And the invariant that matters most: a tunnel that exists has a lease that will reap it.
    const row = await readRow("slowsaga")
    expect(cloudflare.tunnels.size).toBe(1)
    expect(row, "a surviving tunnel must have a lease, or nothing will ever reap it").toBeDefined()
    expect(String(row?.tunnel_id)).toBe([...cloudflare.tunnels.keys()][0])
  })
})
