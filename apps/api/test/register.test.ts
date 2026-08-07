/**
 * Self-registration: what a node tells the directory, and what it does when the directory says no.
 *
 * The interesting half is the failure behaviour. Registration failing costs this node its *listing*
 * and nothing else — it keeps provisioning for anyone holding its URL — so every path here must end in
 * a log line rather than a throw. A throw would surface as a failed cron invocation and, worse, would
 * put the reconciliation sweep running beside it at risk of a future reordering.
 */

import { env as testEnv } from "cloudflare:test"
import { hasLeadingZeroBits, issueChallenge } from "@nport/worker-kit"
import { describe, expect, it } from "vitest"

import { registerWithRegistry, resolveIdentity } from "../src/register"
import type { Env } from "../src/types"

/**
 * `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which nothing in this repo
 * populates. One cast, as `test/routes.test.ts` explains at length.
 */
const baseEnv = testEnv as unknown as Env

const REGISTRY = "https://registry.nport.link"

/** A fully federated node. The suite's `env` has no federation vars, so they are added here. */
function federated(overrides: Partial<Env> = {}): Env {
  return {
    ...baseEnv,
    NODE_ID: "nport-link-1",
    PUBLIC_URL: "https://api.nport.link",
    REGISTRY_URL: REGISTRY,
    NODE_VERSION: "3.0.0",
    ...overrides,
  }
}

interface FakeRegistry {
  readonly fetch: typeof fetch
  readonly posts: Array<Record<string, unknown>>
  readonly calls: string[]
}

/**
 * A registry that issues real challenges and verifies nothing else.
 *
 * Real challenges rather than a canned string, because the point of most of these tests is that the
 * node *solves* one — and a fake that accepted any nonce would let a broken solver pass. Difficulty is
 * 4 bits so a solve is instant; `apps/registry`'s own suite covers the arithmetic.
 */
function fakeRegistry(
  options: { postStatus?: number; postBody?: unknown; difficulty?: number } = {},
) {
  const posts: Array<Record<string, unknown>> = []
  const calls: string[] = []

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`)

    if (url.pathname === "/v1/nodes/challenge") {
      const issued = await issueChallenge("registry-secret", options.difficulty ?? 4, Date.now())
      return Response.json(issued)
    }
    if (url.pathname === "/v1/nodes") {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const status = options.postStatus ?? 201
      return Response.json(options.postBody ?? { node: {} }, { status })
    }
    throw new Error(`fake registry: unexpected ${url.toString()}`)
  }) as typeof fetch

  return { fetch: fetcher, posts, calls } satisfies FakeRegistry
}

describe("the suite's own configuration", () => {
  /**
   * **No test may reach the real registry**, and this is what enforces it rather than a comment.
   *
   * `test/reconcile.test.ts` drives the real `scheduled` handler, which calls `registerWithRegistry`.
   * Adding `REGISTRY_URL` to `wrangler.jsonc` therefore made that suite fetch
   * `https://registry.nport.link` for real — silently, because registration swallows every error by
   * design. `vitest.config.ts` pins the four federation vars empty; unpinning one puts the escape
   * back, and this fails instead.
   */
  it("has federation switched off, so nothing can escape to a real registry", () => {
    expect(resolveIdentity(baseEnv).kind).toBe("private")
  })
})

describe("resolveIdentity", () => {
  it("is `private` when nothing about federation is set", () => {
    // **The self-hosted case, reached by setting nothing.** A private deployment should not have to
    // know these vars exist, let alone opt out of them.
    expect(resolveIdentity(baseEnv).kind).toBe("private")
  })

  it("is `ok` when the whole group is set", () => {
    const resolved = resolveIdentity(federated())
    expect(resolved.kind).toBe("ok")
    if (resolved.kind !== "ok") return
    expect(resolved.identity.id).toBe("nport-link-1")
    // The domain comes from `CF_DOMAIN` — the zone this node actually provisions into — rather than
    // being configured twice and allowed to disagree with itself.
    expect(resolved.identity.domain).toBe(String(baseEnv.CF_DOMAIN))
  })

  it("distinguishes a half-configured node from a private one", () => {
    // Somebody meant to federate and left a var out. Silence would be wrong here and right above,
    // which is the whole reason this returns three states rather than a boolean.
    const resolved = resolveIdentity(federated({ PUBLIC_URL: undefined }))
    expect(resolved.kind).toBe("incomplete")
    if (resolved.kind !== "incomplete") return
    expect(resolved.missing).toContain("PUBLIC_URL")
  })

  it("treats whitespace as unset", () => {
    // A var set to an empty string in a config is a var somebody meant to remove.
    expect(resolveIdentity(federated({ NODE_ID: "   " })).kind).toBe("incomplete")
    expect(
      resolveIdentity({ ...baseEnv, NODE_ID: "  ", PUBLIC_URL: "  ", REGISTRY_URL: "  " }).kind,
    ).toBe("private")
  })

  it("falls back to an unknown version rather than refusing to register", () => {
    // `version` is display-only in the contract, so an unset one is a cosmetic gap. Refusing to be
    // listed over it would trade a working node for a tidy field.
    const resolved = resolveIdentity(federated({ NODE_VERSION: undefined }))
    expect(resolved.kind).toBe("ok")
    if (resolved.kind !== "ok") return
    expect(resolved.identity.version).toBe("unknown")
  })
})

describe("registerWithRegistry", () => {
  it("keeps a path prefix on REGISTRY_URL", async () => {
    // **A silent bug until ADR-0049 made it reachable.** Both endpoints were built with
    // `new URL("/v1/nodes", registryUrl)`, and a leading slash makes the path absolute — so it
    // replaced the base's path outright. A registry mounted at `https://host/registry` would have been
    // sent `https://host/v1/nodes` instead, and because `registerWithRegistry` swallows every failure
    // by design, the node would have gone on failing to register for ever without a word.
    const registry = fakeRegistry()
    const prefixed = new Proxy(registry, {}) as typeof registry
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url.pathname)
      // Re-issue against the un-prefixed path so the fake still recognises it.
      return prefixed.fetch(
        `${url.origin}${url.pathname.replace("/registry", "")}${url.search}`,
        init,
      )
    }) as typeof fetch

    await registerWithRegistry(federated({ REGISTRY_URL: `${REGISTRY}/registry` }), fetcher)

    expect(calls).toEqual(["/registry/v1/nodes/challenge", "/registry/v1/nodes"])
  })

  it("solves a real challenge and posts the registration", async () => {
    const registry = fakeRegistry()
    await registerWithRegistry(federated(), registry.fetch)

    expect(registry.calls).toEqual(["GET /v1/nodes/challenge", "POST /v1/nodes"])
    expect(registry.posts).toHaveLength(1)

    const posted = registry.posts[0] as Record<string, string>
    expect(posted.id).toBe("nport-link-1")
    expect(posted.url).toBe("https://api.nport.link")
    expect(posted.domain).toBe(String(baseEnv.CF_DOMAIN))
    expect(posted.version).toBe("3.0.0")

    // **The nonce actually satisfies the challenge.** Asserting a nonce was merely *present* would
    // pass with a solver that returned "0" — and the registry would then refuse every registration
    // while this test stayed green.
    expect(await hasLeadingZeroBits(`${posted.challenge}.${posted.nonce}`, 4)).toBe(true)
  })

  it("carries no capacity claim", async () => {
    // ADR-0046: capacity is probed, never claimed. The node knows its own count — it publishes it on
    // `/v1/meta` — and must not be able to assert it here, or a lying node gets picked first.
    const registry = fakeRegistry()
    await registerWithRegistry(federated(), registry.fetch)

    const posted = registry.posts[0] as Record<string, unknown>
    expect(posted).not.toHaveProperty("activeTunnels")
    expect(posted).not.toHaveProperty("maxActiveTunnels")
    expect(posted).not.toHaveProperty("status")
  })

  it("identifies itself with a parseable client version", async () => {
    // The registry gates on `nport/<major.minor.patch>`, and a node is not exempt. Sending
    // `NODE_VERSION` — free text — would get a node refused as an unrecognised client, which is a
    // confusing way to fail for a field that is display-only.
    const seen: string[] = []
    const registry = fakeRegistry()
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(new Headers(init?.headers).get("user-agent")))
      return registry.fetch(input, init)
    }) as typeof fetch

    await registerWithRegistry(federated({ NODE_VERSION: "brand-new-friday-build" }), spy)

    for (const agent of seen) {
      expect(agent).toMatch(/^nport\/\d+\.\d+\.\d+/)
    }
  })

  it("does nothing at all when there is no registry", async () => {
    const registry = fakeRegistry()
    await registerWithRegistry(baseEnv, registry.fetch)
    expect(registry.calls).toEqual([])
  })

  it("does nothing when the identity is incomplete", async () => {
    const registry = fakeRegistry()
    await registerWithRegistry(federated({ NODE_ID: undefined }), registry.fetch)
    // Not even a challenge fetched: a node that cannot say who it is has nothing to register.
    expect(registry.calls).toEqual([])
  })

  it("survives a registry that refuses the registration", async () => {
    // The commonest real failure: the TXT record is not published yet. One log line, no throw — the
    // node keeps serving tunnels and the next cron tick tries again.
    const registry = fakeRegistry({
      postStatus: 403,
      postBody: { error: { code: "REGISTRATION_REFUSED", details: { reason: "proof-missing" } } },
    })

    await expect(registerWithRegistry(federated(), registry.fetch)).resolves.toBeUndefined()
    expect(registry.posts).toHaveLength(1)
  })

  it("survives a registry that is down", async () => {
    const dead = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    await expect(registerWithRegistry(federated(), dead)).resolves.toBeUndefined()
  })

  it("survives a registry answering something that is not a challenge", async () => {
    const nonsense = (async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      )
      if (url.pathname === "/v1/nodes/challenge") return Response.json({ hello: "world" })
      throw new Error("should not have got as far as posting")
    }) as typeof fetch

    await expect(registerWithRegistry(federated(), nonsense)).resolves.toBeUndefined()
  })

  it("refuses a difficulty it cannot afford instead of spending the cron on it", async () => {
    // A 32-bit solve is hours. The node declines rather than burning an invocation discovering that,
    // which also means a hostile or misconfigured registry cannot use this as a CPU sink.
    const registry = fakeRegistry({ difficulty: 32 })
    await registerWithRegistry(federated(), registry.fetch)

    expect(registry.calls).toEqual(["GET /v1/nodes/challenge"])
    expect(registry.posts).toEqual([])
  })
})
