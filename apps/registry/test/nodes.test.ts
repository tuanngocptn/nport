/**
 * `GET /v1/nodes` and `POST /v1/nodes`, end to end in real `workerd`.
 *
 * Drives the **real** app via `createApp`, with only its outbound `fetch` swapped for
 * `test/fake-upstream.ts`. Assembling a test app by hand would have been easier and is the trap
 * `docs/ROADMAP.md`'s defect 25 records: it would keep passing after someone removed a middleware from
 * the app that actually ships.
 *
 * **Every request here carries `x-nport-source-hash`** (ADR-0049), because that is what arriving through
 * the gateway looks like: the client gate and the rate limiter run there, and this Worker refuses
 * anything that reaches it without an identity. Tests used to send a `user-agent` and rely on this
 * Worker's own gate — which meant every registration test was also, silently, a client-gate test.
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
 * `apps/node/test/routes.test.ts` carries the same note for the same reason.
 */
const env = testEnv as unknown as Env

/**
 * What the gateway forwards. Any stable string works — this Worker only keys on it, and never derives
 * it (`packages/worker-kit/src/ip-hash.test.ts` covers the derivation).
 */
const GATEWAY = { "x-nport-source-hash": "test-source-hash" }
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

/**
 * DNS only. `fakeUpstream`'s node half is unused now that nothing here probes (ADR-0049) — kept in the
 * helper because `test/fake-upstream.ts` throws on an unknown host, and a registration that somehow
 * fetched a node's `/v1/meta` should fail loudly rather than quietly succeed.
 */
function upstream(overrides: { dns?: FakeDns; nodes?: FakeNodes } = {}) {
  return fakeUpstream(overrides.dns ?? { [PROOF]: ["nport-node=hk1"] }, overrides.nodes ?? {})
}

/** Fetches a real challenge and solves it, exactly as a node would. */
async function solved(app: ReturnType<typeof createApp>) {
  const response = await app.request("/v1/nodes/challenge", { headers: GATEWAY }, env)
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
      headers: { ...GATEWAY, "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...(await solved(app)) }),
    },
    env,
  )
}

/**
 * `isolatedStorage` does not exist in vitest-pool-workers 0.20 and is *silently ignored*, so Durable
 * Object state leaks between tests unless every suite clears it (`apps/node/CLAUDE.md` § Gotchas).
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
    const response = await createApp(upstream().fetch).request(
      "/v1/nodes",
      { headers: GATEWAY },
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      nodes: [],
      refreshAfterMs: Number(env.NODE_LIST_REFRESH_MS),
    })
  })

  it("publishes the cache lifetime so a client does not pick one", async () => {
    const response = await createApp(upstream().fetch).request(
      "/v1/nodes",
      { headers: GATEWAY },
      env,
    )
    const body = (await response.json()) as { refreshAfterMs: number }
    expect(body.refreshAfterMs).toBeGreaterThan(0)
  })

  it("lists a node once it has registered", async () => {
    const app = createApp(upstream().fetch)
    expect(
      (await register(app, { ...REGISTRATION, activeTunnels: 7, maxActiveTunnels: 100 })).status,
    ).toBe(201)

    const response = await app.request("/v1/nodes", { headers: GATEWAY }, env)
    const body = (await response.json()) as { nodes: Array<Record<string, unknown>> }
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({
      id: "hk1",
      url: ORIGIN,
      domain: "nport.link",
      region: "apac",
      version: "3.0.0",
      status: "up",
      // Claimed by the node and stored as sent (ADR-0049).
      activeTunnels: 7,
      maxActiveTunnels: 100,
    })
  })

  it("refuses a request that did not come through the gateway", async () => {
    // **Replaces `needs a client version like every other route`**, which tested a gate that is the
    // gateway's now (`apps/gateway/test/dispatch.test.ts`). What is worth asserting here is the other
    // half of that move: this Worker declares no route, so a request with no forwarded identity should
    // be impossible — and if one arrives, serving it would give every direct caller one shared identity
    // and no per-source limit would apply to any of them. It fails closed.
    const response = await createApp(upstream().fetch).request("/v1/nodes", {}, env)
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INTERNAL")
  })

  it("still answers health without one, for an uptime monitor", async () => {
    const response = await createApp(upstream().fetch).request("/v1/health", {}, env)
    expect(response.status).toBe(200)
  })
})

describe("POST /v1/nodes", () => {
  it("registers a node that proves its domain", async () => {
    const fake = upstream()
    const response = await register(createApp(fake.fetch), {
      ...REGISTRATION,
      activeTunnels: 7,
      maxActiveTunnels: 100,
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { node: Record<string, unknown> }
    expect(body.node).toMatchObject({ id: "hk1", status: "up", activeTunnels: 7 })

    // **One subrequest, and it is the resolver.** It was two — the second fetched the node's own
    // `/v1/meta` — and that probe is gone with ADR-0049. A registration must never fetch the URL it
    // was handed: that is what made this endpoint an open fetch proxy risk in the first place, held in
    // check only by `verifyNodeUrl`.
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toContain("cloudflare-dns.com")
  })

  it("lists the capacity a registration claims", async () => {
    // **Inverted by ADR-0049**, which reverses ADR-0046 on this point. The old objection stands and is
    // accepted: a node asserting `activeTunnels: 0` is picked first by every client, a free denial of
    // service against its own operator. The probe was never much of a defence — a node can answer
    // `/v1/meta` with anything — and a directory of parties already trusted to carry traffic is not
    // made safer by distrusting them about a counter.
    const app = createApp(upstream().fetch)
    const response = await register(app, {
      ...REGISTRATION,
      activeTunnels: 42,
      maxActiveTunnels: 999,
      status: "down",
    })
    expect(response.status).toBe(201)

    const body = (await response.json()) as { node: Record<string, unknown> }
    expect(body.node.activeTunnels).toBe(42)
    expect(body.node.maxActiveTunnels).toBe(999)
    // **`status` is still not the node's to claim.** It is absent from the schema, so it is stripped
    // rather than refused (forward compatibility: a newer client's unknown field must not be turned
    // away), and a node that just called is `up` by definition. A node asking to be listed as `down`
    // is asking for what not registering already achieves.
    expect(body.node.status).toBe("up")
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

  it("lists a node that claims no capacity, without inventing a zero", async () => {
    // **Absent means unknown, not empty.** Both fields are optional, and storing `0` for a node that
    // said nothing would make it look idle and sort it to the front of every client's list — the exact
    // failure the old probe's "empty observation" case existed to avoid, arriving from the other side.
    const response = await register(createApp(upstream().fetch), REGISTRATION)
    expect(response.status).toBe(201)

    const body = (await response.json()) as { node: Record<string, unknown> }
    expect(body.node).not.toHaveProperty("activeTunnels")
    expect(body.node).not.toHaveProperty("maxActiveTunnels")
    expect(body.node.status).toBe("up")
  })

  it("refuses an unsolved proof of work", async () => {
    const app = createApp(upstream().fetch)
    const challenge = await app.request("/v1/nodes/challenge", { headers: GATEWAY }, env)
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
        headers: { ...GATEWAY, "content-type": "application/json" },
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
    const headers = { ...GATEWAY, "content-type": "application/json" }

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

    const list = await app.request("/v1/nodes", { headers: GATEWAY }, env)
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
    const list = await app.request("/v1/nodes", { headers: GATEWAY }, env)
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
