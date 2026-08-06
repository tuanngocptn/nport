/**
 * `GET /v1/nodes` and `POST /v1/nodes`, end to end in real `workerd`.
 *
 * Drives the **real** app via `createApp`, with only its outbound `fetch` swapped for
 * `test/fake-upstream.ts`. Assembling a test app by hand would have been easier and is the trap
 * `docs/ROADMAP.md`'s defect 25 records: it would keep passing after someone removed the client gate
 * or the rate limiter from the app that actually ships.
 */

import { runInDurableObject, env as testEnv } from "cloudflare:test"
import { solveChallenge } from "@nport/worker-kit"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApp } from "../src/index"
import type { Env } from "../src/types"
import { type FakeDns, type FakeNodes, fakeUpstream } from "./fake-upstream"

/**
 * `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which nothing in this repo
 * populates — and augmenting it (or `ProvidedEnv`, as older guides suggest) silently does not apply.
 * One cast here, against the app's own `Env`, beats scattering casts through the file, and it keeps
 * the property that a test reading a binding the Worker does not declare fails to compile.
 * `apps/api/test/routes.test.ts` carries the same note for the same reason.
 */
const env = testEnv as unknown as Env

const UA = { "user-agent": "nport/3.0.0 (linux; x86_64)" }
const ORIGIN = "https://api.nport.link"
const PROOF = "_nport-node.nport.link"

/** A registration that should succeed, before the challenge is filled in. */
const REGISTRATION = {
  id: "hk1",
  url: ORIGIN,
  domain: "nport.link",
  region: "apac",
  version: "3.0.0",
}

function upstream(overrides: { dns?: FakeDns; nodes?: FakeNodes } = {}) {
  return fakeUpstream(
    overrides.dns ?? { [PROOF]: ["nport-node=hk1"] },
    overrides.nodes ?? { [ORIGIN]: { activeTunnels: 7, maxActiveTunnels: 100 } },
  )
}

/** Fetches a real challenge and solves it, exactly as a node would. */
async function solved(app: ReturnType<typeof createApp>) {
  const response = await app.request("/v1/challenge", { headers: UA }, env)
  const issued = (await response.json()) as { challenge: string; difficulty: number }
  return {
    challenge: issued.challenge,
    nonce: await solveChallenge(issued.challenge, issued.difficulty),
  }
}

async function register(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown> = REGISTRATION,
) {
  return app.request(
    "/v1/nodes",
    {
      method: "POST",
      headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...(await solved(app)) }),
    },
    env,
  )
}

/**
 * `isolatedStorage` does not exist in vitest-pool-workers 0.20 and is *silently ignored*, so Durable
 * Object state leaks between tests unless every suite clears it (`apps/api/CLAUDE.md` § Gotchas).
 * Clearing by hand rather than with `reset()` because the directory is one object with two tables.
 */
async function clearDirectory() {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM node")
    state.storage.sql.exec("DELETE FROM spent_challenge")
  })
}

beforeEach(clearDirectory)
afterEach(clearDirectory)

describe("GET /v1/nodes", () => {
  it("is an empty list before anyone registers, not an error", async () => {
    // An empty directory is a 200. `NO_NODE_AVAILABLE` is a *client* code, raised once discovery has
    // exhausted the list — the registry never sends it.
    const response = await createApp(upstream().fetch).request("/v1/nodes", { headers: UA }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      nodes: [],
      refreshAfterMs: Number(env.NODE_LIST_REFRESH_MS),
    })
  })

  it("publishes the cache lifetime so a client does not pick one", async () => {
    const response = await createApp(upstream().fetch).request("/v1/nodes", { headers: UA }, env)
    const body = (await response.json()) as { refreshAfterMs: number }
    expect(body.refreshAfterMs).toBeGreaterThan(0)
  })

  it("lists a node once it has registered", async () => {
    const app = createApp(upstream().fetch)
    expect((await register(app)).status).toBe(201)

    const response = await app.request("/v1/nodes", { headers: UA }, env)
    const body = (await response.json()) as { nodes: Array<Record<string, unknown>> }
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({
      id: "hk1",
      url: ORIGIN,
      domain: "nport.link",
      region: "apac",
      version: "3.0.0",
      status: "up",
      // Probed, not claimed: the registration carried no capacity at all.
      activeTunnels: 7,
      maxActiveTunnels: 100,
    })
  })

  it("needs a client version like every other route", async () => {
    const response = await createApp(upstream().fetch).request("/v1/nodes", {}, env)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INVALID_REQUEST")
  })
})

describe("POST /v1/nodes", () => {
  it("registers a node that proves its domain and answers a probe", async () => {
    const fake = upstream()
    const response = await register(createApp(fake.fetch))

    expect(response.status).toBe(201)
    const body = (await response.json()) as { node: Record<string, unknown> }
    expect(body.node).toMatchObject({ id: "hk1", status: "up", activeTunnels: 7 })

    // Both subrequests, in the documented order: the proof is cheaper than the probe, so refusing on
    // it saves a fetch to a host nobody has yet shown they control.
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]).toContain("cloudflare-dns.com")
    expect(fake.calls[1]).toBe(`${ORIGIN}/v1/meta`)
  })

  it("ignores a capacity a registration tries to claim", async () => {
    // ADR-0046: a node that could assert `activeTunnels: 0` would be picked first by every client — a
    // free denial of service against its own operator.
    //
    // The schema **strips** the unknown field rather than refusing the request, which is the right
    // choice for forward compatibility — a newer client sending a field this node has not heard of
    // must not be turned away. So the assertion is about the *effect*: what gets listed is what the
    // probe saw, never what was sent. Asserting a 400 here was this test's first draft, and it was
    // testing zod's strictness rather than the property that matters.
    const app = createApp(upstream().fetch)
    const response = await register(app, {
      ...REGISTRATION,
      activeTunnels: 0,
      maxActiveTunnels: 999_999,
      status: "up",
    })
    expect(response.status).toBe(201)

    const body = (await response.json()) as { node: Record<string, unknown> }
    expect(body.node.activeTunnels).toBe(7)
    expect(body.node.maxActiveTunnels).toBe(100)
  })

  it("refuses a URL outside the domain being proved", async () => {
    // The amplification case. Proving `nport.link` must not let the directory advertise — or the
    // registry fetch — a host the operator has proved nothing about.
    const fake = upstream()
    const response = await register(createApp(fake.fetch), {
      ...REGISTRATION,
      url: "https://evil.test",
    })

    expect(response.status).toBe(403)
    const body = (await response.json()) as {
      error: { code: string; details?: { reason?: string } }
    }
    expect(body.error.code).toBe("REGISTRATION_REFUSED")
    expect(body.error.details?.reason).toBe("invalid-url")
    // **Nothing was fetched.** The refusal happens before any subrequest, which is what stops this
    // being a way to make Cloudflare fetch arbitrary hosts.
    expect(fake.calls).toEqual([])
  })

  it("refuses plaintext http", async () => {
    const response = await register(createApp(upstream().fetch), {
      ...REGISTRATION,
      url: "http://api.nport.link",
    })
    expect(response.status).toBe(403)
  })

  it("refuses a node with no TXT proof", async () => {
    const fake = upstream({ dns: {} })
    const response = await register(createApp(fake.fetch), REGISTRATION)

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe("proof-missing")
    // The proof failed, so the probe never ran.
    expect(fake.calls).toHaveLength(1)
  })

  it("refuses a TXT record naming a different node id", async () => {
    const fake = upstream({ dns: { [PROOF]: ["nport-node=someone-else"] } })
    const response = await register(createApp(fake.fetch), REGISTRATION)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe("proof-missing")
  })

  it("refuses a node whose own /v1/meta does not answer", async () => {
    const fake = upstream({ nodes: { [ORIGIN]: null } })
    const response = await register(createApp(fake.fetch), REGISTRATION)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe("unreachable")
  })

  it("refuses an unsolved proof of work", async () => {
    const app = createApp(upstream().fetch)
    const challenge = await app.request("/v1/challenge", { headers: UA }, env)
    const issued = (await challenge.json()) as { challenge: string; difficulty: number }

    // A nonce verified *not* to satisfy the difficulty, rather than a hardcoded "0" — which would
    // satisfy a low difficulty about one time in sixteen and make this the worst possible flaky test.
    let bad = 0
    const { hasLeadingZeroBits } = await import("@nport/worker-kit")
    while (await hasLeadingZeroBits(`${issued.challenge}.${bad}`, issued.difficulty)) {
      bad += 1
    }

    const response = await app.request(
      "/v1/nodes",
      {
        method: "POST",
        headers: { ...UA, "content-type": "application/json" },
        body: JSON.stringify({ ...REGISTRATION, challenge: issued.challenge, nonce: String(bad) }),
      },
      env,
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("POW_INVALID")
  })

  it("refuses a replayed challenge", async () => {
    // ADR-0027's ledger. Without it, one solved challenge registers unlimited nodes inside its
    // two-minute window and the control that is supposed to cost something does not.
    const app = createApp(upstream().fetch)
    const proof = await solved(app)
    const body = JSON.stringify({ ...REGISTRATION, ...proof })
    const headers = { ...UA, "content-type": "application/json" }

    const first = await app.request("/v1/nodes", { method: "POST", headers, body }, env)
    expect(first.status).toBe(201)

    const replay = await app.request("/v1/nodes", { method: "POST", headers, body }, env)
    expect(replay.status).toBe(400)
    const refused = (await replay.json()) as { error: { code: string } }
    expect(refused.error.code).toBe("POW_INVALID")
  })

  it("lets the same domain refresh its own id", async () => {
    const app = createApp(upstream().fetch)
    expect((await register(app)).status).toBe(201)
    // A fresh challenge, which is what a node re-registering on boot would take.
    expect((await register(app, { ...REGISTRATION, version: "3.0.1" })).status).toBe(201)

    const list = await app.request("/v1/nodes", { headers: UA }, env)
    const body = (await list.json()) as { nodes: Array<{ version: string }> }
    // Refreshed, not duplicated.
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]?.version).toBe("3.0.1")
  })

  it("refuses a different domain claiming a listed id", async () => {
    // **The takeover case.** Proving your own domain must not let you take an id someone else holds,
    // or the directory would happily point every client at you.
    const app = createApp(
      fakeUpstream(
        {
          [PROOF]: ["nport-node=hk1"],
          "_nport-node.attacker.test": ["nport-node=hk1"],
        },
        {
          [ORIGIN]: { activeTunnels: 1 },
          "https://api.attacker.test": { activeTunnels: 0 },
        },
      ).fetch,
    )

    expect((await register(app)).status).toBe(201)

    const stolen = await register(app, {
      id: "hk1",
      url: "https://api.attacker.test",
      domain: "attacker.test",
      version: "3.0.0",
    })
    expect(stolen.status).toBe(403)
    const body = (await stolen.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe("id-taken")

    // And the original entry is untouched.
    const list = await app.request("/v1/nodes", { headers: UA }, env)
    const listed = (await list.json()) as { nodes: Array<{ url: string }> }
    expect(listed.nodes[0]?.url).toBe(ORIGIN)
  })

  it("refuses an id that is not a usable identifier", async () => {
    const app = createApp(upstream().fetch)
    for (const id of ["ab", "HK1", "hk_1", "-hk"]) {
      const response = await register(app, { ...REGISTRATION, id })
      expect(response.status, id).toBe(403)
      const body = (await response.json()) as { error: { details?: { reason?: string } } }
      expect(body.error.details?.reason, id).toBe("invalid-node-id")
    }
  })

  it("refuses a domain that is really a URL", async () => {
    // So an operator who pastes `https://nport.dev/` gets `invalid-domain` rather than a confusing
    // `proof-missing` after a pointless DNS query.
    const fake = upstream()
    const response = await register(createApp(fake.fetch), {
      ...REGISTRATION,
      url: "https://nport.dev",
      domain: "https://nport.dev/",
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe("invalid-domain")
    expect(fake.calls).toEqual([])
  })
})
