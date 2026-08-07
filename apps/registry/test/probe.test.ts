/**
 * The cron sweep: what happens to a node that stops answering.
 *
 * This is the only thing keeping the directory honest — a node's entry is a claim by a stranger that
 * goes stale without telling anyone — so the interesting assertions are all about the *streak*, not
 * about a single probe.
 */

import { runInDurableObject, env as testEnv } from "cloudflare:test"
import type { Node } from "@nport/contract"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runScheduled } from "../src/probe"
import type { Env } from "../src/types"
import { fakeUpstream } from "./fake-upstream"

/**
 * `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which nothing in this repo
 * populates — and augmenting it (or `ProvidedEnv`, as older guides suggest) silently does not apply.
 * One cast here, against the app's own `Env`, beats scattering casts through the file, and it keeps
 * the property that a test reading a binding the Worker does not declare fails to compile.
 * `apps/api/test/routes.test.ts` carries the same note for the same reason.
 */
const env = testEnv as unknown as Env

const ORIGIN = "https://api.nport.link"

function directory() {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))
}

async function clearDirectory() {
  await runInDurableObject(directory(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM node")
    state.storage.sql.exec("DELETE FROM spent_challenge")
  })
}

beforeEach(clearDirectory)
afterEach(clearDirectory)

/** Seeds a listed, healthy node without going through registration. */
async function seed(overrides: Partial<Node> = {}): Promise<void> {
  await directory().upsert({
    id: "hk1",
    url: ORIGIN,
    domain: "nport.link",
    version: "3.0.0",
    status: "up",
    activeTunnels: 7,
    maxActiveTunnels: 100,
    lastSeenAt: 1,
    ...overrides,
  })
}

async function listed(): Promise<Node[]> {
  return directory().list()
}

/** `env` with the probe thresholds overridden, so a test does not depend on the deployed numbers. */
function withThresholds(down: number, delist: number): Env {
  return { ...env, PROBE_FAILURES_BEFORE_DOWN: down, PROBE_FAILURES_BEFORE_DELIST: delist }
}

describe("the probe sweep", () => {
  it("refreshes capacity from what the node reports", async () => {
    await seed()
    const fake = fakeUpstream({}, { [ORIGIN]: { activeTunnels: 42, maxActiveTunnels: 100 } })

    await runScheduled(env, fake.fetch)

    const nodes = await listed()
    expect(nodes[0]).toMatchObject({ status: "up", activeTunnels: 42 })
  })

  it("degrades on the first failure rather than going straight to down", async () => {
    // Three states, not two: "not answering right now" and "gone" deserve different answers, and a
    // client shows them differently.
    await seed()
    const fake = fakeUpstream({}, { [ORIGIN]: null })

    await runScheduled(withThresholds(3, 24), fake.fetch)

    const nodes = await listed()
    expect(nodes[0]?.status).toBe("degraded")
  })

  it("goes down once the streak reaches the threshold, and clears stale capacity", async () => {
    await seed()
    const fake = fakeUpstream({}, { [ORIGIN]: null })
    const config = withThresholds(3, 24)

    await runScheduled(config, fake.fetch)
    await runScheduled(config, fake.fetch)
    expect((await listed())[0]?.status).toBe("degraded")

    await runScheduled(config, fake.fetch)
    const nodes = await listed()
    expect(nodes[0]?.status).toBe("down")
    // **Capacity is cleared, not left stale.** "12 of 100 tunnels" on a node that has not answered in
    // fifteen minutes is a number a client would sort on, and it means nothing.
    expect(nodes[0]?.activeTunnels).toBeUndefined()
  })

  it("delists a node that has been dead long enough", async () => {
    await seed()
    const fake = fakeUpstream({}, { [ORIGIN]: null })
    const config = withThresholds(2, 4)

    for (let round = 0; round < 4; round += 1) {
      await runScheduled(config, fake.fetch)
    }

    // Gone entirely. Re-registering is one proof of work, so this costs an operator very little and
    // keeps the list from becoming a graveyard the cron has to probe forever.
    expect(await listed()).toEqual([])
  })

  it("resets the streak when a node comes back", async () => {
    // The property that stops a flaky node being delisted by accumulation: two failures a day apart
    // must not add up to a delisting.
    await seed()
    const config = withThresholds(2, 3)

    await runScheduled(config, fakeUpstream({}, { [ORIGIN]: null }).fetch)
    expect((await listed())[0]?.status).toBe("degraded")

    await runScheduled(config, fakeUpstream({}, { [ORIGIN]: { activeTunnels: 1 } }).fetch)
    expect((await listed())[0]?.status).toBe("up")

    // Back to a clean slate: one more failure is a *first* failure, so it degrades rather than
    // delisting.
    await runScheduled(config, fakeUpstream({}, { [ORIGIN]: null }).fetch)
    expect((await listed())[0]?.status).toBe("degraded")
  })

  it("keeps probing the rest after one node fails", async () => {
    // One unreachable node must not end a sweep that has others to check. Sequential, so this is the
    // assertion that a throw does not escape the loop.
    await seed({ id: "hk1", url: ORIGIN })
    await seed({ id: "eu1", url: "https://api.nport.dev", domain: "nport.dev" })

    const fake = fakeUpstream({}, { [ORIGIN]: null, "https://api.nport.dev": { activeTunnels: 3 } })
    await runScheduled(withThresholds(3, 24), fake.fetch)

    const nodes = await listed()
    const byId = new Map(nodes.map((node) => [node.id, node]))
    expect(byId.get("hk1")?.status).toBe("degraded")
    expect(byId.get("eu1")?.status).toBe("up")
    expect(byId.get("eu1")?.activeTunnels).toBe(3)
  })

  it("does nothing, loudly or otherwise, on an empty directory", async () => {
    const fake = fakeUpstream({}, {})
    await expect(runScheduled(env, fake.fetch)).resolves.toBeUndefined()
    expect(fake.calls).toEqual([])
  })
})
