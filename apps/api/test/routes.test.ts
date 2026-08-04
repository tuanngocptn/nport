/**
 * Integration tests against the real Worker in real `workerd`.
 *
 * `SELF.fetch` goes through the actual `fetch` handler — middleware, routing, error handler — so
 * these assert the contract as a client sees it rather than as the handlers intend it.
 */

import { SELF, env as testEnv } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { solveChallenge, verifyChallenge } from "../src/domain/pow"
import type { Env } from "../src/types"

/**
 * `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which nothing in this repo
 * populates — and augmenting it (or `ProvidedEnv`, as older guides suggest) silently does not
 * apply. One cast here, against the app's own `Env`, beats scattering casts through the file, and
 * it keeps the property that a test reading a binding the Worker does not declare fails to compile.
 */
const env = testEnv as unknown as Env

const UA = { "user-agent": "nport/3.0.0 (darwin; arm64)" }

async function get(path: string, headers: Record<string, string> = UA) {
  return SELF.fetch(`https://api.nport.link${path}`, { headers })
}

describe("GET /", () => {
  it("redirects to the website, matching v2", async () => {
    // Some users type the API host into a browser. v2 did this and the shim must keep doing it.
    const response = await SELF.fetch("https://api.nport.link/", { redirect: "manual" })
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe("https://nport.link")
  })
})

describe("no CORS, ever", () => {
  it("sends no CORS headers on any route", async () => {
    // Their absence is an abuse control: without them no web page can drive this API, so a
    // browser-based attack has to become a server-based one (docs/ARCHITECTURE.md §7).
    for (const path of ["/v1/health", "/v1/meta", "/v1/challenge"]) {
      const response = await get(path)
      expect(response.headers.get("access-control-allow-origin"), path).toBeNull()
      expect(response.headers.get("access-control-allow-methods"), path).toBeNull()
    }
  })

  it("does not answer a preflight with permission", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/challenge", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", ...UA },
    })
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("GET /v1/health", () => {
  it("answers without client identification", async () => {
    // Uptime monitors send no NPort headers. Gating health behind a version would make a version
    // bump look like an outage.
    const response = await SELF.fetch("https://api.nport.link/v1/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  it("is not cached", async () => {
    const response = await SELF.fetch("https://api.nport.link/v1/health")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("the client gate", () => {
  it("rejects a request with no User-Agent", async () => {
    const response = await get("/v1/meta", {})
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    // INVALID_REQUEST, not CLIENT_TOO_OLD: we know it did not identify itself, not that it is old.
    expect(body.error.code).toBe("INVALID_REQUEST")
  })

  it("rejects a browser User-Agent", async () => {
    const response = await get("/v1/meta", { "user-agent": "Mozilla/5.0 (Macintosh)" })
    expect(response.status).toBe(400)
  })

  it("rejects a client below the minimum version", async () => {
    const response = await get("/v1/meta", { "user-agent": "nport/2.4.0 (linux; amd64)" })
    expect(response.status).toBe(426)
    const body = (await response.json()) as { error: { code: string; details?: unknown } }
    expect(body.error.code).toBe("CLIENT_TOO_OLD")
    expect(body.error.details).toEqual({ minimumVersion: String(env.MIN_CLIENT_VERSION) })
  })

  it("rejects a version smuggled into a comment", async () => {
    // The match is anchored, so a hostile UA cannot claim a high version after the fact.
    const response = await get("/v1/meta", { "user-agent": "curl/8 (nport/9.9.9)" })
    expect(response.status).toBe(400)
  })

  it("accepts a current client", async () => {
    expect((await get("/v1/meta")).status).toBe(200)
  })
})

describe("GET /v1/meta", () => {
  it("reports limits from the environment rather than hardcoding them", async () => {
    const response = await get("/v1/meta")
    const body = (await response.json()) as Record<string, number | string>

    expect(body.minClientVersion).toBe(String(env.MIN_CLIENT_VERSION))
    expect(body.tunnelDurationMs).toBe(Number(env.LEASE_TTL_SECONDS) * 1000)
    expect(body.powDifficulty).toBe(Number(env.POW_DIFFICULTY_BITS))
  })

  it("leaves room for more than one heartbeat inside the grace period", async () => {
    // If a single dropped heartbeat could end a healthy tunnel, the grace period is decoration.
    const body = (await (await get("/v1/meta")).json()) as { heartbeatIntervalMs: number }
    const graceMs = Number(env.HEARTBEAT_GRACE_SECONDS) * 1000
    expect(body.heartbeatIntervalMs).toBeLessThanOrEqual(graceMs / 2)
    expect(body.heartbeatIntervalMs).toBeGreaterThan(0)
  })

  it("exposes no secret", async () => {
    const text = await (await get("/v1/meta")).text()
    expect(text).not.toContain(String(env.POW_SECRET))
    expect(text).not.toContain(String(env.IP_HASH_SECRET))
  })
})

describe("GET /v1/challenge", () => {
  it("issues a challenge the verifier accepts", async () => {
    // End to end through the real handler: issue over HTTP, solve locally, verify with the same
    // secret the Worker used. If the route and the domain logic ever disagree, this fails.
    const response = await get("/v1/challenge")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      challenge: string
      difficulty: number
      expiresAt: number
    }

    expect(body.difficulty).toBe(Number(env.POW_DIFFICULTY_BITS))
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    // Solve at a low difficulty: the deployed floor is 20 bits, which is ~100 ms for a user but
    // slow enough to make a test flaky on a loaded runner. The signature path is what matters here.
    const cheap = await solveChallenge(body.challenge, 8)
    const result = await verifyChallenge(String(env.POW_SECRET), body.challenge, cheap, Date.now())
    // The challenge commits to 20 bits, so an 8-bit solution is correctly insufficient — proving
    // the difficulty travelled intact rather than being taken from the request.
    expect(result).toEqual({ ok: false, reason: "insufficient-work" })
  })

  it("never issues the same challenge twice", async () => {
    const first = (await (await get("/v1/challenge")).json()) as { challenge: string }
    const second = (await (await get("/v1/challenge")).json()) as { challenge: string }
    expect(first.challenge).not.toBe(second.challenge)
  })

  it("is not cached", async () => {
    // A cached challenge is replayable, which defeats the point of a per-request cost.
    const response = await get("/v1/challenge")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("does not leak the signing secret", async () => {
    const text = await (await get("/v1/challenge")).text()
    expect(text).not.toContain(String(env.POW_SECRET))
  })
})

describe("errors", () => {
  it("uses the documented envelope on every failure", async () => {
    const response = await get("/v1/meta", { "user-agent": "nport/1.0.0 (linux; amd64)" })
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string; docsUrl: string }
    }

    // Exactly the shape in docs/ERRORS.md § Response shape.
    expect(Object.keys(body)).toEqual(["error"])
    expect(body.error.code).toBe("CLIENT_TOO_OLD")
    expect(body.error.message.length).toBeGreaterThan(0)
    expect(body.error.requestId.length).toBeGreaterThan(0)
    expect(body.error.docsUrl).toBe("https://nport.link/errors/client-too-old")
  })

  it("gives an unknown route the envelope too, not an HTML 404", async () => {
    const response = await get("/v1/nope")
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  it("prefers cf-ray as the request id, so it matches Cloudflare's logs", async () => {
    const response = await get("/v1/meta", { ...UA, "cf-ray": "abc123-HKG" })
    // Reached only on failure, so provoke one.
    const failed = await get("/v1/meta", {
      "user-agent": "nport/1.0.0 (linux; amd64)",
      "cf-ray": "abc123-HKG",
    })
    expect(response.status).toBe(200)
    const body = (await failed.json()) as { error: { requestId: string } }
    expect(body.error.requestId).toBe("abc123-HKG")
  })
})

describe("binding validation", () => {
  it("refuses a request when a required secret is missing", async () => {
    // The regression test for a 500 that was very hard to read: with POW_SECRET absent, an empty
    // HMAC key reached WebCrypto and failed as `DataError: Imported HMAC key length (0)...`.
    // `wrangler dev` hits this by default because secrets are not in wrangler.jsonc.
    const original = env.POW_SECRET
    try {
      // @ts-expect-error deliberately simulating an unset secret
      env.POW_SECRET = ""
      const response = await get("/v1/challenge")
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe("INTERNAL")
      // The response must not name the binding. Telling an anonymous caller which secret is
      // missing is free reconnaissance; the operator gets it from the log instead.
      expect(body.error.message).not.toContain("POW_SECRET")
      expect(JSON.stringify(body)).not.toContain("POW_SECRET")
    } finally {
      // @ts-expect-error restoring
      env.POW_SECRET = original
    }
  })

  it("still answers health when misconfigured, so a monitor can tell it apart from a dead worker", async () => {
    const original = env.POW_SECRET
    try {
      // @ts-expect-error deliberately simulating an unset secret
      env.POW_SECRET = ""
      const response = await SELF.fetch("https://api.nport.link/v1/health")
      expect(response.status).toBe(200)
    } finally {
      // @ts-expect-error restoring
      env.POW_SECRET = original
    }
  })
})
