import { describe, expect, it } from "vitest"

import fixtures from "../fixtures/subdomains.json" with { type: "json" }
import {
  checkSubdomain,
  checkSubdomainShape,
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

/**
 * The split between claiming a name and referring to one.
 *
 * These are not fixture-driven: the fixtures describe what may be *claimed*, and this function
 * deliberately answers a different question. Adding shape-only cases to the shared file would make
 * the Rust mirror assert the wrong thing.
 */
describe("checkSubdomainShape", () => {
  it("accepts a generated name, which the claim validator must reject", () => {
    // The regression this exists for: `nport-` is a reserved prefix, so validating a `:subdomain`
    // path parameter with `checkSubdomain` makes every generated tunnel unable to report its status,
    // heartbeat, or delete itself.
    const generated = "nport-ab12cd34ef5gh"
    expect(checkSubdomainShape(generated)).toEqual({ ok: true, subdomain: generated })
    expect(checkSubdomain(generated)).toEqual({ ok: false, reason: "reserved-prefix" })
  })

  it("accepts a reserved name, because looking one up leaks nothing", () => {
    // `api` has no lease, so the caller gets `TUNNEL_NOT_FOUND` — the same answer as for any other
    // unclaimed name, which is what makes this safe.
    expect(checkSubdomainShape("api")).toEqual({ ok: true, subdomain: "api" })
  })

  it("still refuses anything that could never have been issued", () => {
    // This is the guard that stops a junk path parameter becoming a Durable Object: an unbounded key
    // space is an unbounded number of objects.
    const rejections: [string, string][] = [
      ["ab", "too-short"],
      ["bad_name", "invalid-characters"],
      ["-lead", "leading-or-trailing-hyphen"],
      ["xn--abc", "double-hyphen-prefix"],
      ["a".repeat(64), "too-long"],
    ]
    for (const [input, reason] of rejections) {
      const check = checkSubdomainShape(input)
      expect(check.ok, input).toBe(false)
      if (!check.ok) {
        expect(check.reason, input).toBe(reason)
      }
    }
  })

  it("normalizes first, so a pasted URL resolves to the same object", () => {
    expect(checkSubdomainShape("MyApp.nport.link.")).toEqual({ ok: true, subdomain: "myapp" })
  })

  it("agrees with the claim validator on every fixture that is not reserved", () => {
    // Shape is a strict subset of the claim rules, so any name the claim validator accepts must pass
    // here too. A divergence would mean a tunnel that can be created but not addressed.
    for (const { input } of fixtures.valid) {
      expect(checkSubdomainShape(input).ok, input).toBe(true)
    }
  })
})
