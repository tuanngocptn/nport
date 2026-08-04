import { describe, expect, it } from "vitest"

import { generateSubdomain } from "./generated-name"
import { sourceHash } from "./ip-hash"
import { hashesMatch, hashOwnerToken, mintOwnerToken, OWNER_TOKEN_HASH_BYTES } from "./owner-token"

describe("mintOwnerToken", () => {
  it("produces 256 bits, base64url, no padding", () => {
    // URL- and shell-safe on purpose: no `+`, `/`, or `=` to escape wherever a client puts it.
    expect(mintOwnerToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 500 }, mintOwnerToken))
    expect(tokens.size).toBe(500)
  })
})

describe("hashOwnerToken", () => {
  it("is a stable SHA-256", async () => {
    const first = await hashOwnerToken("abc")
    const second = await hashOwnerToken("abc")
    expect(first.length).toBe(OWNER_TOKEN_HASH_BYTES)
    expect(hashesMatch(first, second)).toBe(true)
  })

  it("separates two tokens that differ in one character", async () => {
    const left = await hashOwnerToken("token-a")
    const right = await hashOwnerToken("token-b")
    expect(hashesMatch(left, right)).toBe(false)
  })
})

describe("hashesMatch", () => {
  it("rejects a shorter hash rather than comparing a prefix", () => {
    // The failure this guards: a length-tolerant compare would let a one-byte value match anything,
    // which is a total authentication bypass rather than a subtle leak.
    const full = new Uint8Array(32).fill(7)
    expect(hashesMatch(full, full.subarray(0, 8))).toBe(false)
    expect(hashesMatch(full, new Uint8Array(0))).toBe(false)
  })

  it("accepts two equal hashes", () => {
    expect(hashesMatch(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
  })

  it("rejects a difference in the last byte", () => {
    // An early-exit compare would answer this fastest of all, which is the timing signal the
    // constant-time loop removes.
    expect(hashesMatch(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
  })
})

describe("generateSubdomain", () => {
  it("is `nport-` plus 13 base32 characters", () => {
    // The length is the assertion that matters: `charAt` returns "" for an out-of-range index, so a
    // 31-symbol alphabet would emit short names rather than throwing.
    const name = generateSubdomain()
    expect(name).toMatch(/^nport-[a-z2-7]{13}$/)
    expect(name.length).toBe(19)
  })

  it("is lowercase, so it survives normalization unchanged", () => {
    // The lease key is the normalized name. A generated name that normalized to something else would
    // be handed to a caller who could then never address it.
    const name = generateSubdomain()
    expect(name).toBe(name.toLowerCase())
  })

  it("does not collide across many draws", () => {
    // v2's generator had a 10,000-name space, `Math.random()`, and no collision retry, so both
    // enumeration and collision were trivial (defect R2).
    const names = new Set(Array.from({ length: 2000 }, generateSubdomain))
    expect(names.size).toBe(2000)
  })
})

describe("sourceHash", () => {
  it("is stable for one address and secret", async () => {
    expect(await sourceHash("secret", "203.0.113.7")).toBe(
      await sourceHash("secret", "203.0.113.7"),
    )
  })

  it("hides the address it was derived from", async () => {
    // The only privacy commitment an account-free service can actually keep (rule 11).
    expect(await sourceHash("secret", "203.0.113.7")).not.toContain("203")
  })

  it("changes with the secret, so rotation invalidates every stored value", async () => {
    expect(await sourceHash("secret-a", "203.0.113.7")).not.toBe(
      await sourceHash("secret-b", "203.0.113.7"),
    )
  })

  it("distinguishes an address from an address plus ASN", async () => {
    expect(await sourceHash("secret", "203.0.113.7", 64500)).not.toBe(
      await sourceHash("secret", "203.0.113.7"),
    )
  })

  it("cannot be confused by a separator collision", async () => {
    // Without the separator, ("1.2.3.4", 5) and ("1.2.3.45", undefined) would hash identically, and
    // two unrelated sources would share one rate-limit bucket.
    expect(await sourceHash("secret", "1.2.3.4", 5)).not.toBe(
      await sourceHash("secret", "1.2.3.45"),
    )
  })
})
