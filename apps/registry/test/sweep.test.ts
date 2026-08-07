/**
 * The cron sweep: what happens to a node that stops registering.
 *
 * This is the only thing keeping the directory honest — a node's entry is a claim by a stranger that
 * it stops renewing without telling anyone — so the interesting assertions are all about *how long ago*
 * a node last called, and about the boundary between "quiet" and "gone".
 *
 * **Every one of these used to be about a probe streak** (ADR-0049). The sweep fetched each listed
 * node's `/v1/meta` and counted consecutive failures; nodes now push and the sweep only ages what they
 * pushed. That removed a `fetcher` parameter, `test/fake-upstream.ts`'s node half, and the whole
 * concept of a streak — so `resets the streak when a node comes back` has no counterpart here, and its
 * property is covered instead by `a node that re-registers is up again immediately`.
 *
 * Times are absolute and passed in, never `Date.now()` offsets read from the deployed vars: a test
 * that computed "fifteen minutes ago" against the real clock would pass or fail on how long the suite
 * took to get here.
 */

import { runInDurableObject, env as testEnv } from "cloudflare:test"
import type { Node } from "@nport/contract"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runScheduled } from "../src/sweep"
import type { Env } from "../src/types"

/**
 * `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which nothing in this repo
 * populates — and augmenting it (or `ProvidedEnv`, as older guides suggest) silently does not apply.
 * One cast here, against the app's own `Env`, beats scattering casts through the file, and it keeps
 * the property that a test reading a binding the Worker does not declare fails to compile.
 * `apps/node/test/routes.test.ts` carries the same note for the same reason.
 */
const env = testEnv as unknown as Env

const ORIGIN = "https://api.nport.link"

/** Thresholds every test overrides, so none depends on the deployed numbers. */
const DOWN_AFTER_SECONDS = 900
const DELIST_AFTER_SECONDS = 7200

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

/**
 * Seeds a listed, healthy node without going through registration.
 *
 * `lastSeenAt` defaults to now, because that is what a node that just registered looks like and it is
 * the state every "then time passes" test starts from.
 */
async function seed(overrides: Partial<Node> = {}): Promise<void> {
  await directory().upsert({
    id: "hk1",
    url: ORIGIN,
    domain: "nport.link",
    version: "3.0.0",
    status: "up",
    activeTunnels: 7,
    maxActiveTunnels: 100,
    lastSeenAt: Date.now(),
    ...overrides,
  })
}

async function listed(): Promise<Node[]> {
  return directory().list()
}

/** `env` with the two thresholds pinned, so a test does not depend on the deployed numbers. */
function withThresholds(downSeconds: number, delistSeconds: number): Env {
  return {
    ...env,
    NODE_DOWN_AFTER_SECONDS: downSeconds,
    NODE_DELIST_AFTER_SECONDS: delistSeconds,
  }
}

/** How long ago, in milliseconds, as a `lastSeenAt`. */
function secondsAgo(seconds: number): number {
  return Date.now() - seconds * 1000
}

describe("the staleness sweep", () => {
  it("leaves a node that registered recently alone", async () => {
    await seed({ lastSeenAt: secondsAgo(60) })

    await runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS))

    const nodes = await listed()
    expect(nodes[0]).toMatchObject({ status: "up", activeTunnels: 7 })
  })

  it("marks a node down after the silence threshold, and clears stale capacity", async () => {
    await seed({ lastSeenAt: secondsAgo(1000) })

    await runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS))

    const nodes = await listed()
    expect(nodes[0]?.status).toBe("down")
    // **Capacity is cleared, not left stale.** "7 of 100 tunnels" on a node that has not been heard
    // from in a quarter of an hour is a number a client would rank on, and it means nothing.
    expect(nodes[0]?.activeTunnels).toBeUndefined()
  })

  it("keeps a down node listed rather than hiding it", async () => {
    // A client shows an unavailable node greyed out rather than having it vanish and reappear
    // (`docs/FEATURES.md` §3) — and it is the honest answer: a node quiet for twenty minutes was fine
    // half an hour ago and may be fine again shortly.
    await seed({ lastSeenAt: secondsAgo(1000) })

    await runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS))

    expect(await listed()).toHaveLength(1)
  })

  it("delists a node that has been silent long enough", async () => {
    await seed({ lastSeenAt: secondsAgo(DELIST_AFTER_SECONDS + 60) })

    await runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS))

    // Gone entirely. Re-registering is one proof of work, so this costs an operator very little and
    // keeps the list from becoming a graveyard.
    expect(await listed()).toEqual([])
  })

  it("does not mark a row down on the same run that deletes it", async () => {
    // Delete-then-mark, not mark-then-delete: the other order spends a write on a row that is about to
    // be gone. Asserted through the log-shaped return rather than by timing — a node past both
    // thresholds counts once, as a delisting, and never also as a `down`.
    await seed({ lastSeenAt: secondsAgo(DELIST_AFTER_SECONDS + 60) })
    await seed({ id: "eu1", url: "https://api.nport.dev", lastSeenAt: secondsAgo(1000) })

    await runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS))

    const nodes = await listed()
    expect(nodes.map((node) => node.id)).toEqual(["eu1"])
    expect(nodes[0]?.status).toBe("down")
  })

  it("is idempotent, so a second run changes nothing", async () => {
    // The cron is at-least-once in spirit, and `down` is not a state a second sweep should disturb.
    await seed({ lastSeenAt: secondsAgo(1000) })
    const config = withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS)

    await runScheduled(config)
    const first = await listed()
    await runScheduled(config)

    expect(await listed()).toEqual(first)
  })

  it("brings a node that re-registers back up immediately", async () => {
    // **The property the old failure-streak reset stood for.** A node down for missing a few
    // heartbeats must come straight back on its next successful registration — not climb out of a
    // counter, and not have to wait for anything to expire.
    await seed({ lastSeenAt: secondsAgo(1000) })
    const config = withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS)

    await runScheduled(config)
    expect((await listed())[0]?.status).toBe("down")

    await seed({ lastSeenAt: Date.now(), activeTunnels: 2 })
    expect((await listed())[0]).toMatchObject({ status: "up", activeTunnels: 2 })

    // And a sweep straight afterwards leaves it alone.
    await runScheduled(config)
    expect((await listed())[0]?.status).toBe("up")
  })

  it("sweeps every node in one pass, not just the first stale one", async () => {
    await seed({ id: "hk1", lastSeenAt: secondsAgo(1000) })
    await seed({ id: "eu1", url: "https://api.nport.dev", lastSeenAt: secondsAgo(1000) })
    await seed({ id: "us1", url: "https://api.nport.test", lastSeenAt: secondsAgo(30) })

    await runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS))

    const byId = new Map((await listed()).map((node) => [node.id, node]))
    expect(byId.get("hk1")?.status).toBe("down")
    expect(byId.get("eu1")?.status).toBe("down")
    expect(byId.get("us1")?.status).toBe("up")
  })

  it("does nothing, loudly or otherwise, on an empty directory", async () => {
    // `SUM` over zero rows is null in SQLite, which arithmetic would turn into a NaN in the log line.
    await expect(
      runScheduled(withThresholds(DOWN_AFTER_SECONDS, DELIST_AFTER_SECONDS)),
    ).resolves.toBeUndefined()
    expect(await listed()).toEqual([])
  })
})
