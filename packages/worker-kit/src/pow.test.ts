import { describe, expect, it } from "vitest"

import {
  CHALLENGE_TTL_MS,
  hasLeadingZeroBits,
  issueChallenge,
  solveChallenge,
  verifyChallenge,
} from "./pow"

const SECRET = "test-secret-not-the-real-one"
const NOW = 1_767_225_600_000

describe("hasLeadingZeroBits", () => {
  it("accepts any input for zero required bits", async () => {
    expect(await hasLeadingZeroBits("anything", 0)).toBe(true)
  })

  it("counts bits, not hex digits", async () => {
    // The reason this is bit-level: a hex-digit check can only express multiples of four, so
    // difficulty would jump 16x per step with nothing in between. Find an input whose digest
    // has between 1 and 3 leading zero bits and assert the boundary is honoured exactly.
    let found = false
    for (let index = 0; index < 5000 && !found; index += 1) {
      const input = `probe-${index}`
      if ((await hasLeadingZeroBits(input, 1)) && !(await hasLeadingZeroBits(input, 4))) {
        found = true
        // Somewhere in 1..3 it must flip, and it must stay flipped.
        expect(await hasLeadingZeroBits(input, 1)).toBe(true)
        expect(await hasLeadingZeroBits(input, 4)).toBe(false)
      }
    }
    expect(found, "no input with 1..3 leading zero bits in 5000 probes").toBe(true)
  })

  it("is monotonic — more required bits is never easier", async () => {
    const input = "monotonic-probe"
    let previous = true
    for (let bits = 0; bits <= 24; bits += 1) {
      const satisfied = await hasLeadingZeroBits(input, bits)
      if (!previous) {
        expect(satisfied, `${bits} bits satisfied after a lower count failed`).toBe(false)
      }
      previous = satisfied
    }
  })
})

describe("issueChallenge", () => {
  it("returns a two-part challenge and the difficulty it committed to", async () => {
    const issued = await issueChallenge(SECRET, 8, NOW)
    expect(issued.challenge.split(".")).toHaveLength(2)
    expect(issued.difficulty).toBe(8)
    expect(issued.expiresAt).toBe(NOW + CHALLENGE_TTL_MS)
  })

  it("never issues the same challenge twice", async () => {
    // Same secret, same difficulty, same millisecond. Without the salt these would collide, and
    // a repeated challenge means a solved nonce can be replayed.
    const first = await issueChallenge(SECRET, 4, NOW)
    const second = await issueChallenge(SECRET, 4, NOW)
    expect(first.challenge).not.toBe(second.challenge)
  })

  it("rejects a difficulty outside the supported range", async () => {
    await expect(issueChallenge(SECRET, 0, NOW)).rejects.toThrow(RangeError)
    await expect(issueChallenge(SECRET, 33, NOW)).rejects.toThrow(RangeError)
    await expect(issueChallenge(SECRET, 1.5, NOW)).rejects.toThrow(RangeError)
  })
})

describe("verifyChallenge", () => {
  it("accepts a correctly solved challenge", async () => {
    const issued = await issueChallenge(SECRET, 8, NOW)
    const nonce = await solveChallenge(issued.challenge, 8)
    const result = await verifyChallenge(SECRET, issued.challenge, nonce, NOW + 1000)
    expect(result).toEqual({ ok: true, bits: 8 })
  })

  it("rejects a wrong nonce as insufficient work", async () => {
    const issued = await issueChallenge(SECRET, 12, NOW)
    const result = await verifyChallenge(SECRET, issued.challenge, "definitely-not-solved", NOW)
    expect(result).toEqual({ ok: false, reason: "insufficient-work" })
  })

  it("rejects a challenge signed with a different secret", async () => {
    // The whole point of statelessness: integrity comes from the MAC, so a challenge minted
    // elsewhere must not verify here.
    const issued = await issueChallenge("some-other-secret", 4, NOW)
    const nonce = await solveChallenge(issued.challenge, 4)
    const result = await verifyChallenge(SECRET, issued.challenge, nonce, NOW)
    expect(result).toEqual({ ok: false, reason: "bad-signature" })
  })

  it("rejects a challenge whose difficulty was edited down", async () => {
    // The attack the MAC exists to stop: solve an easy challenge, then claim it was hard. Or
    // rather the reverse — take a hard challenge and rewrite `bits` to 1.
    const issued = await issueChallenge(SECRET, 20, NOW)
    const [encoded, signature] = issued.challenge.split(".") as [string, string]
    const payload = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))) as {
      exp: number
      bits: number
      salt: string
    }
    payload.bits = 1
    const forged = btoa(JSON.stringify(payload))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    const result = await verifyChallenge(SECRET, `${forged}.${signature}`, "0", NOW)
    expect(result).toEqual({ ok: false, reason: "bad-signature" })
  })

  it("rejects an expired challenge", async () => {
    const issued = await issueChallenge(SECRET, 4, NOW)
    const nonce = await solveChallenge(issued.challenge, 4)
    const result = await verifyChallenge(
      SECRET,
      issued.challenge,
      nonce,
      NOW + CHALLENGE_TTL_MS + 1,
    )
    expect(result).toEqual({ ok: false, reason: "expired" })
  })

  it("accepts a challenge on the last valid millisecond", async () => {
    // Off-by-one at the boundary would reject work a client legitimately finished in time.
    const issued = await issueChallenge(SECRET, 4, NOW)
    const nonce = await solveChallenge(issued.challenge, 4)
    const result = await verifyChallenge(SECRET, issued.challenge, nonce, issued.expiresAt)
    expect(result.ok).toBe(true)
  })

  it("checks the signature before the expiry", async () => {
    // Order matters for the reported reason: CHALLENGE_EXPIRED is retryable and POW_INVALID is
    // not, so a forged challenge with a past `exp` must report the forgery, not the expiry —
    // otherwise a client politely retries an attack forever.
    //
    // The signature is a *well-formed* 32-byte base64url value that simply does not match. An
    // unparseable one (`.bogus`) fails base64 decoding first and reports `malformed`, which is
    // also correct but proves nothing about ordering.
    const encoded = btoa('{"exp":1,"bits":4,"salt":"x"}')
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    const wrongSignature = btoa(String.fromCharCode(...new Uint8Array(32)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    const result = await verifyChallenge(SECRET, `${encoded}.${wrongSignature}`, "0", NOW)
    expect(result).toEqual({ ok: false, reason: "bad-signature" })
  })

  it("reports an unparseable signature as malformed, not as a bad signature", async () => {
    // Distinct from the case above: this one never reaches the HMAC. Both are rejections, but a
    // handler mapping them to different registry codes needs them distinguishable.
    const encoded = btoa('{"exp":1,"bits":4,"salt":"x"}')
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    const result = await verifyChallenge(SECRET, `${encoded}.!!!not-base64!!!`, "0", NOW)
    expect(result).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects malformed input without throwing", async () => {
    // These arrive from unauthenticated callers, so every one of them must be a clean rejection
    // rather than an exception that becomes a 500.
    for (const challenge of ["", "no-dot", "a.b.c", "!!!.???", "."]) {
      const result = await verifyChallenge(SECRET, challenge, "0", NOW)
      expect(result.ok, `${challenge} should be rejected`).toBe(false)
    }
  })

  it("rejects a challenge whose payload is not the expected shape", async () => {
    // Signed by us, but with a payload that is valid JSON and wrong. Reachable only if a future
    // version changes the payload shape, which is exactly when a silent `undefined` comparison
    // would become an accept-everything bug.
    const encoder = new TextEncoder()
    const encoded = btoa('{"nope":true}')
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(encoded)))
    let binary = ""
    for (const byte of mac) binary += String.fromCharCode(byte)
    const signature = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")

    const result = await verifyChallenge(SECRET, `${encoded}.${signature}`, "0", NOW)
    expect(result).toEqual({ ok: false, reason: "malformed" })
  })

  it("does not accept a nonce solved for a different challenge", async () => {
    // Nonces are bound to their challenge, so a solution cannot be reused across them.
    const first = await issueChallenge(SECRET, 8, NOW)
    const second = await issueChallenge(SECRET, 8, NOW)
    const nonce = await solveChallenge(first.challenge, 8)
    const result = await verifyChallenge(SECRET, second.challenge, nonce, NOW)
    expect(result).toEqual({ ok: false, reason: "insufficient-work" })
  })
})
