import { describe, expect, it } from "vitest"

import fixtures from "../fixtures/subdomains.json" with { type: "json" }
import {
  checkSubdomain,
  isReserved,
  MAX_LENGTH,
  normalizeSubdomain,
  RESERVED_SUBDOMAINS,
} from "./subdomain"

/**
 * Every case is table-driven from `fixtures/subdomains.json` rather than written inline, because
 * `crates/contract` runs the same file. A case added only here would not constrain Rust, and the
 * two validators silently disagreeing is exactly the failure the shared fixture prevents.
 */
describe("normalizeSubdomain", () => {
  for (const { input, output, why } of fixtures.normalize) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(output)} (${why})`, () => {
      expect(normalizeSubdomain(input)).toBe(output)
    })
  }
})

describe("checkSubdomain accepts", () => {
  for (const { input, why } of fixtures.valid) {
    it(`${JSON.stringify(input)} (${why})`, () => {
      const result = checkSubdomain(input)
      expect(result.ok, `expected ${input} to be accepted`).toBe(true)
    })
  }
})

describe("checkSubdomain rejects", () => {
  for (const { input, reason, why } of fixtures.invalid) {
    it(`${JSON.stringify(input)} as ${reason} (${why})`, () => {
      const result = checkSubdomain(input)
      expect(result.ok, `expected ${input} to be rejected`).toBe(false)
      // The reason is asserted, not just the rejection: it travels to the user in
      // `details.reason`, and "invalid" alone is useless to someone who typed 64 characters.
      if (!result.ok) {
        expect(result.reason).toBe(reason)
      }
    })
  }
})

describe("isReserved", () => {
  it("covers every name in the reserved list", () => {
    for (const name of RESERVED_SUBDOMAINS) {
      expect(isReserved(name), name).toBe(true)
    }
  })

  it("normalizes before comparing", () => {
    // The sweeper reads names out of DNS records, whose case it does not control.
    expect(isReserved("API")).toBe(true)
    expect(isReserved("  www  ")).toBe(true)
    expect(isReserved("api.nport.link")).toBe(true)
  })

  it("does not reserve an ordinary name", () => {
    expect(isReserved("myapp")).toBe(false)
  })

  it("ignores length and charset rules", () => {
    // Deliberate: the sweeper asks only "is this one of ours", and a record that would fail
    // validation today may still have been created by an earlier version of the rules.
    expect(isReserved("nport-")).toBe(true)
    expect(isReserved("a")).toBe(false)
  })
})

describe("invariants the fixtures cannot express", () => {
  it("the reserved list has no duplicates", () => {
    expect(new Set(RESERVED_SUBDOMAINS).size).toBe(RESERVED_SUBDOMAINS.length)
  })

  it("every reserved name would otherwise be a plausible claim", () => {
    // A reserved entry that could never be typed is dead weight, and worse, hides a real gap.
    // `_`-prefixed DNS names are the exception: they are unclaimable by pattern but must stay
    // listed so the sweeper recognises them.
    for (const name of RESERVED_SUBDOMAINS) {
      if (name.startsWith("_")) continue
      expect(name.length, name).toBeLessThanOrEqual(MAX_LENGTH)
      expect(name, name).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it("normalization is idempotent", () => {
    // The lease key is derived from the normalized name. If normalizing twice differed from
    // normalizing once, two callers could hold the same subdomain.
    for (const { input } of [...fixtures.normalize, ...fixtures.valid, ...fixtures.invalid]) {
      const once = normalizeSubdomain(input)
      expect(normalizeSubdomain(once), input).toBe(once)
    }
  })
})
