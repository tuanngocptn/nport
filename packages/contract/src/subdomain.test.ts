import { describe, expect, it } from "vitest"

import fixtures from "../fixtures/subdomains.json" with { type: "json" }
import {
  checkSubdomain,
  checkSubdomainShape,
  isProtectedFromCleanup,
  isReserved,
  MAX_INPUT_LENGTH,
  MAX_LENGTH,
  normalizeSubdomain,
  RESERVED_SUBDOMAINS,
  ZONE_SUFFIX,
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

/**
 * Cost, not correctness — the one property in this file that a wrong answer does not reveal.
 *
 * `normalizeSubdomain` strips the zone suffix in a loop, and doing that by re-slicing copied the whole
 * remaining string each time: O(n·k) for k suffixes, and k grows with n. Measured on the old code,
 * `"a" + ".nport.link"` repeated took 4 ms at 11 KiB, 87 ms at 54 KiB and **12.5 s at 645 KiB** — one
 * unauthenticated request, on the shim that cannot ask for proof of work, ending a Worker invocation on
 * CPU time. Two independent guards now: the function is linear, and the entry points refuse absurd
 * input before calling it at all.
 */
describe("resource bounds", () => {
  it("normalizes a pathological input in linear time", () => {
    // 60,000 suffixes is 645 KiB — the size that took 12.5 seconds. A generous ceiling rather than a
    // tight one, so this asserts "not quadratic" and never fails on a loaded CI runner.
    const input = `a${ZONE_SUFFIX.repeat(60_000)}`
    const started = Date.now()
    expect(normalizeSubdomain(input)).toBe("a")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("still strips a repeated suffix, which is what the loop is for", () => {
    expect(normalizeSubdomain(`myapp${ZONE_SUFFIX}${ZONE_SUFFIX}`)).toBe("myapp")
    expect(normalizeSubdomain(`myapp${ZONE_SUFFIX}.${ZONE_SUFFIX}..`)).toBe("myapp")
  })

  it("refuses input longer than the raw bound before normalizing it", () => {
    const oversized = "a".repeat(MAX_INPUT_LENGTH + 1)
    expect(checkSubdomain(oversized)).toEqual({ ok: false, reason: "too-long" })
    expect(checkSubdomainShape(oversized)).toEqual({ ok: false, reason: "too-long" })
  })

  it("still accepts a name at the raw bound that normalizes to a legal one", () => {
    // The bound is on *input*, so a pasted URL and a trailing dot must still fit. Guards against
    // tightening it to `MAX_LENGTH` and breaking `myapp.nport.link`.
    const pasted = `myapp${ZONE_SUFFIX}.`
    expect(pasted.length).toBeLessThanOrEqual(MAX_INPUT_LENGTH)
    expect(checkSubdomain(pasted)).toEqual({ ok: true, subdomain: "myapp" })
  })

  it("does not call an oversized name reserved", () => {
    // `isReserved` is the sweeper's guard, and it must answer rather than spend the input's length.
    expect(isReserved(`api${ZONE_SUFFIX.repeat(60_000)}`)).toBe(false)
  })
})

/**
 * The two questions the deny list answers, and why they are not the same one.
 *
 * "May a stranger claim this?" and "may cleanup delete this record?" have different answers for our
 * own prefixes, and treating them as one question meant the reconciliation sweep skipped every
 * orphaned generated name — the commonest kind (ADR-0036).
 */
describe("isProtectedFromCleanup", () => {
  it("protects reserved infrastructure names", () => {
    for (const name of ["api", "www", "mail", "_dmarc", "_acme-challenge"]) {
      expect(isProtectedFromCleanup(name), name).toBe(true)
    }
  })

  it("does not protect NPort's own prefixes, because they are ours to reap", () => {
    // A generated name is `nport-<base32>`; nobody else can create one, so an orphan carrying it is
    // exactly what the sweep exists for.
    expect(isProtectedFromCleanup("nport-ab12cd34ef5gh")).toBe(false)
    expect(isProtectedFromCleanup("smoke-linux-4711")).toBe(false)
  })

  it("does not protect an ordinary name", () => {
    expect(isProtectedFromCleanup("myapp")).toBe(false)
  })

  it("stays stricter than isReserved in exactly one direction", () => {
    // Anything protected must also be unclaimable; the reverse does not hold, and that asymmetry is
    // the whole point. A name cleanup may delete but a stranger may not claim is fine; a name a
    // stranger may claim but cleanup may not delete would be an unreapable orphan factory.
    for (const name of ["api", "_dmarc", "nport-ab12cd34ef5gh", "smoke-x", "myapp", "www"]) {
      if (isProtectedFromCleanup(name)) {
        expect(isReserved(name), `${name} is protected but not reserved`).toBe(true)
      }
    }
  })

  it("normalizes before deciding, like every other entry point", () => {
    expect(isProtectedFromCleanup("API")).toBe(true)
    expect(isProtectedFromCleanup("NPORT-AB12CD34EF5GH")).toBe(false)
  })
})
