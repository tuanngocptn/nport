/**
 * The reconciliation cron.
 *
 * Driven through the real `scheduled` handler, because the thing worth testing is the whole decision —
 * what it considers an orphan, what it refuses to touch, and in what order it deletes. Every case here
 * is one a live account can reach, and the destructive ones are the reason `docs/ARCHITECTURE.md` §3f
 * calls this a safety net rather than a mechanism.
 */

import {
  createExecutionContext,
  createScheduledController,
  reset,
  env as testEnv,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cnameTargetFor } from "../src/cloudflare/client"
import worker from "../src/index"
import type { Env } from "../src/types"
import { FakeCloudflare } from "./fake-cloudflare"
import { asGateway } from "./gateway"

const env = testEnv as unknown as Env

/** Comfortably past the sweep's minimum orphan age, which is ten minutes. */
const OLD = 3_600_000

let cloudflare: FakeCloudflare

beforeEach(() => {
  cloudflare = new FakeCloudflare()
  cloudflare.install()
})

afterEach(async () => {
  cloudflare.restore()
  await reset()
})

async function sweep(): Promise<void> {
  const controller = createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" })
  const context = createExecutionContext()
  await worker.scheduled(controller, env as never, context)
  await waitOnExecutionContext(context)
}

/** An orphan: a tunnel and its matching CNAME, with no lease anywhere. */
function seedOrphan(subdomain: string, ageMs = OLD) {
  const tunnel = cloudflare.seedTunnel(`nport-${subdomain}`, ageMs)
  cloudflare.seedDns(`${subdomain}.${env.CF_DOMAIN}`, "CNAME", cnameTargetFor(tunnel.id))
  return tunnel
}

describe("orphan removal", () => {
  it("removes a tunnel with no lease, and its record with it", async () => {
    seedOrphan("abandoned")

    await sweep()

    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
  })

  it("deletes the record before the tunnel", async () => {
    // The ordering is the whole reason this is safe. The tunnel's ID is the *only* proof that the record
    // is ours, so deleting the tunnel first would destroy the evidence and leave a dangling CNAME
    // nothing could ever prove ownership of — and that name would then be permanently unclaimable,
    // because every later create would hit 81053 and refuse with DNS_CONFLICT.
    seedOrphan("ordered")

    await sweep()

    const deleteDns = cloudflare.calls.indexOf("delete-dns")
    const deleteTunnel = cloudflare.calls.indexOf("delete-tunnel")
    expect(deleteDns).toBeGreaterThanOrEqual(0)
    expect(deleteTunnel).toBeGreaterThanOrEqual(0)
    expect(deleteDns).toBeLessThan(deleteTunnel)
  })

  it("leaves a tunnel that still has a live lease", async () => {
    // The case that matters most: reconciliation must never touch a working tunnel. Created through the
    // API, so the lease and the index are both real.
    const { solveChallenge } = await import("@nport/worker-kit")
    const { SELF } = await import("cloudflare:test")
    const headers = {
      ...asGateway(),
      "user-agent": "nport/3.0.0 (darwin; arm64)",
      "content-type": "application/json",
    }
    const challenge = (await (
      await SELF.fetch("https://api.nport.link/v1/challenge", { headers })
    ).json()) as { challenge: string; difficulty: number }
    const created = await SELF.fetch("https://api.nport.link/v1/tunnels", {
      method: "POST",
      headers,
      body: JSON.stringify({
        subdomain: "alive",
        challenge: challenge.challenge,
        nonce: await solveChallenge(challenge.challenge, challenge.difficulty),
        client: "cli",
      }),
    })
    expect(created.status).toBe(201)

    await sweep()

    expect(cloudflare.tunnels.size).toBe(1)
    expect(cloudflare.dns.size).toBe(1)
  })

  it("leaves a tunnel too young to judge", async () => {
    // A saga journals its lease before creating the tunnel, but the isolate can die between the two and
    // the watchdog needs its own window. Sweeping a fresh tunnel would race provisioning.
    seedOrphan("justborn", 1000)

    await sweep()

    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("leaves a tunnel with no creation date rather than guessing", async () => {
    const tunnel = cloudflare.seedTunnel("nport-undated", 0)
    // Cloudflare always sends one, but an absent field must not be read as "old enough".
    cloudflare.tunnels.set(tunnel.id, {
      id: tunnel.id,
      name: tunnel.name,
      created_at: undefined as never,
    })

    await sweep()

    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("ignores tunnels NPort did not create", async () => {
    // A self-hoster's account may hold anything. The `nport-` prefix is the only thing that says a
    // tunnel is ours to delete.
    cloudflare.seedTunnel("someone-elses-tunnel", OLD)
    cloudflare.seedTunnel("nport", OLD)

    await sweep()

    expect(cloudflare.tunnels.size).toBe(2)
  })

  it("never touches a reserved name", async () => {
    // `docs/ARCHITECTURE.md` §7: the deny list is shared with the sweeper precisely so cleanup cannot
    // delete the record that answers our ACME challenges or receives our mail.
    seedOrphan("api")
    seedOrphan("_dmarc")

    await sweep()

    expect(cloudflare.tunnels.size).toBe(2)
    expect(cloudflare.dns.size).toBe(2)
  })
})

describe("ownership proof", () => {
  it("refuses to delete a record pointing somewhere else, and keeps the tunnel too", async () => {
    // Invariant 8. Keeping the tunnel is the subtle half: deleting it would destroy the proof that the
    // record was ever ours, so a later run could never resolve this and the name would be stuck.
    const tunnel = cloudflare.seedTunnel("nport-repointed", OLD)
    cloudflare.seedDns(
      `repointed.${env.CF_DOMAIN}`,
      "CNAME",
      "someone-elses-tunnel.cfargotunnel.com",
    )

    await sweep()

    expect(cloudflare.tunnels.has(tunnel.id)).toBe(true)
    expect(cloudflare.dns.get(`repointed.${env.CF_DOMAIN}`)?.content).toBe(
      "someone-elses-tunnel.cfargotunnel.com",
    )
  })

  it("refuses to delete a record that is not a CNAME", async () => {
    const tunnel = cloudflare.seedTunnel("nport-anarecord", OLD)
    cloudflare.seedDns(`anarecord.${env.CF_DOMAIN}`, "A", "203.0.113.7")

    await sweep()

    expect(cloudflare.tunnels.has(tunnel.id)).toBe(true)
    expect(cloudflare.dns.size).toBe(1)
  })

  it("removes a tunnel whose record is already gone", async () => {
    // Half-completed teardown: the record went, the tunnel did not. Nothing to prove ownership *of*, so
    // the tunnel — provably ours by its `nport-` name — can go.
    cloudflare.seedTunnel("nport-halfdone", OLD)

    await sweep()

    expect(cloudflare.tunnels.size).toBe(0)
  })
})

describe("names the sweep may and may not reap", () => {
  it("reaps an orphaned generated name", async () => {
    // **Generated names are the default** — every `nport 3000` with no `-s` gets `nport-<base32>`,
    // so its tunnel is `nport-nport-<base32>` and the subdomain the sweep extracts starts with
    // `nport-`. That is a *reserved prefix*, and the sweep skipped every one of them: a whole class
    // of orphan, the commonest class, that reconciliation structurally refused to touch.
    //
    // The deny list exists so cleanup can never delete one of *our own infrastructure* records
    // (`api`, `_dmarc`). A generated name is the opposite of that — unambiguously ours, and created
    // by us, so it must be reapable.
    seedOrphan("nport-ab12cd34ef5gh")

    await sweep()

    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.dns.size).toBe(0)
  })

  it("reaps an orphaned smoke-test name", async () => {
    // Same shape, and the reason `docs/TESTING.md`'s plan for `smoke.yml` was self-defeating: it
    // reserved `smoke-` "so reconciliation can identify them", when reserving a prefix is what makes
    // the sweeper *skip* it. A leaked smoke lease was the one thing cleanup would never reap.
    seedOrphan("smoke-linux-4711")

    await sweep()

    expect(cloudflare.tunnels.size).toBe(0)
  })

  it("still refuses to touch a reserved infrastructure name", async () => {
    // The half that must not change. A record for `api` or `_dmarc` is load-bearing, and deleting one
    // is the failure the deny list exists to prevent.
    seedOrphan("api")
    seedOrphan("_dmarc")
    seedOrphan("www")

    await sweep()

    expect(cloudflare.tunnels.size).toBe(3)
    expect(cloudflare.dns.size).toBe(3)
  })
})

describe("the sweep cursor", () => {
  it("advances a page at a time and wraps", async () => {
    // Bounded per invocation, unbounded over time — the fix for v2's cleanup ceiling (defect R8), whose
    // cron had no ordering at all, so the oldest tunnel could starve indefinitely.
    for (let index = 0; index < 25; index += 1) {
      cloudflare.seedTunnel(`unrelated-${index}`, OLD)
    }
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))

    expect(await registry.sweepPage()).toBe(1)
    await sweep()
    expect(await registry.sweepPage()).toBe(2)
    await sweep()
    expect(await registry.sweepPage()).toBe(3)
    // 25 tunnels at 10 per page is three pages, so the third run wraps.
    await sweep()
    expect(await registry.sweepPage()).toBe(1)
  })

  it("removes at most a bounded number per run, and drains over successive runs", async () => {
    for (let index = 0; index < 5; index += 1) {
      seedOrphan(`backlog${index}`)
    }

    await sweep()
    // Three per run is the documented cap. Silently removing all five would be pleasant here and
    // dangerous in production, where each removal costs up to four Cloudflare calls against a budget
    // of fifty.
    expect(cloudflare.tunnels.size).toBe(2)

    // The cursor wrapped (five tunnels is one page), so the next run finds the rest.
    await sweep()
    expect(cloudflare.tunnels.size).toBe(0)
  })
})

describe("robustness", () => {
  it("restores an index entry rather than deleting a lease the index had lost", async () => {
    // The index is a derived view and can be lost. Acting on it alone would delete a live tunnel, so a
    // candidate is always confirmed against the authoritative lease first.
    // Provisioned for real, so the lease and its Cloudflare state are consistent. Seeding a record by
    // hand and *then* claiming the same name would hit 81053 and be refused with DNS_CONFLICT — which is
    // correct behaviour, and would leave no lease for this test to protect.
    const lease = env.SUBDOMAIN_LEASE.get(env.SUBDOMAIN_LEASE.idFromName("indexless"))
    const { hashOwnerToken, mintOwnerToken } = await import("../src/domain/owner-token")
    const claimed = await lease.claim({
      subdomain: "indexless",
      ownerTokenHash: await hashOwnerToken(mintOwnerToken()),
      ipHash: "test-source",
      clientVersion: "nport/3.0.0 (test; test)",
    })
    expect(claimed.ok).toBe(true)

    // Backdate it past the minimum orphan age, so the sweep will actually consider it.
    for (const [id, tunnel] of cloudflare.tunnels) {
      cloudflare.tunnels.set(id, {
        ...tunnel,
        created_at: new Date(Date.now() - OLD).toISOString(),
      })
    }

    // Then lose the index entry: exactly what a destroyed-and-restored Registry looks like.
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))
    await registry.forget("indexless")
    expect(await registry.withoutLease(["indexless"])).toEqual(["indexless"])

    await sweep()

    // The lease's own tunnel survives, and the index is repaired so the next sweep does not pay for it.
    expect(await registry.withoutLease(["indexless"])).toEqual([])
  })

  it("does not throw when Cloudflare is unreachable", async () => {
    // A cron that throws is retried on the platform's schedule, which is fine — but the failure has to
    // be visible rather than silently reducing the sweep to nothing.
    cloudflare.fail("find-tunnel", { status: 500 })
    seedOrphan("unreachable")

    await expect(sweep()).resolves.toBeUndefined()
    expect(cloudflare.tunnels.size).toBe(1)
  })

  it("does nothing when there is nothing to do", async () => {
    await sweep()
    expect(cloudflare.tunnels.size).toBe(0)
  })
})

describe("liveness of the cursor", () => {
  it("advances past a page it could not finish", async () => {
    // The failure mode this guards is v2's defect R8 arriving through a different door. If the cursor
    // only advanced after a clean run, one orphan that persistently fails to delete would pin the sweep
    // to its page forever and every other page would starve — which is exactly the ordering problem the
    // cursor exists to solve.
    for (let index = 0; index < 15; index += 1) {
      seedOrphan(`stuck${index}`)
    }
    cloudflare.fail("delete-tunnel", { status: 500 })
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))

    await sweep()

    expect(await registry.sweepPage()).toBe(2)
  })
})
