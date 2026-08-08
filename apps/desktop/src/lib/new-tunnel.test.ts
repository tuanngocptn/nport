import { describe, expect, it } from "vitest"

import { canStart, checkPort, checkRequestedSubdomain, equivalentCommand } from "./new-tunnel"

describe("checkPort", () => {
  it("accepts the ports a machine can actually listen on", () => {
    expect(checkPort("3000")).toEqual({ ok: true, port: 3000 })
    expect(checkPort("1")).toEqual({ ok: true, port: 1 })
    expect(checkPort("65535")).toEqual({ ok: true, port: 65535 })
  })

  it("trims, because a pasted port brings whitespace with it", () => {
    expect(checkPort("  8080 ")).toEqual({ ok: true, port: 8080 })
  })

  /**
   * `parseInt("3000abc")` is 3000, which would start a tunnel to a port the field does not show.
   * `Number` rejects it, which is the whole reason it is used.
   */
  it("rejects a number with something stuck to it", () => {
    expect(checkPort("3000abc")).toEqual({ ok: false, reason: "not-a-number" })
  })

  it("rejects what is not a whole port", () => {
    expect(checkPort("")).toEqual({ ok: false, reason: "empty" })
    expect(checkPort("   ")).toEqual({ ok: false, reason: "empty" })
    expect(checkPort("80.5")).toEqual({ ok: false, reason: "not-a-number" })
    expect(checkPort("abc")).toEqual({ ok: false, reason: "not-a-number" })
  })

  /** 0 is not "pick one for me" here — the field means a port something is already listening on. */
  it("rejects ports outside 1–65535, including zero", () => {
    expect(checkPort("0")).toEqual({ ok: false, reason: "out-of-range" })
    expect(checkPort("65536")).toEqual({ ok: false, reason: "out-of-range" })
    expect(checkPort("-1")).toEqual({ ok: false, reason: "out-of-range" })
  })
})

describe("checkRequestedSubdomain", () => {
  it("treats an empty field as a request to generate one", () => {
    expect(checkRequestedSubdomain("")).toEqual({ state: "generated" })
    expect(checkRequestedSubdomain("   ")).toEqual({ state: "generated" })
  })

  it("accepts a name the server would accept", () => {
    expect(checkRequestedSubdomain("myapp")).toEqual({ state: "ok", subdomain: "myapp" })
  })

  /**
   * The rules come from `packages/contract`, which is what the server validates against, so this
   * asserts the wiring rather than restating the rules — a length bound copied into this file would
   * be a second authority to drift.
   */
  it("defers to the contract's rules rather than its own", () => {
    expect(checkRequestedSubdomain("ab")).toEqual({ state: "rejected", reason: "too-short" })
    // `leading-or-trailing-hyphen` rather than `invalid-characters`: the contract distinguishes
    // them, and this test was written expecting the coarser answer. Deferring means taking the
    // authority's word for which rule was broken, not just that one was.
    expect(checkRequestedSubdomain("-nope")).toEqual({
      state: "rejected",
      reason: "leading-or-trailing-hyphen",
    })
    expect(checkRequestedSubdomain("my app")).toEqual({
      state: "rejected",
      reason: "invalid-characters",
    })
    expect(checkRequestedSubdomain("www").state).toBe("rejected")
  })

  /** Normalization is the server's, but a pasted hostname is common enough to handle here. */
  it("normalizes what a user is likely to paste", () => {
    expect(checkRequestedSubdomain("MyApp")).toEqual({ state: "ok", subdomain: "myapp" })
    expect(checkRequestedSubdomain("myapp.nport.link")).toEqual({ state: "ok", subdomain: "myapp" })
  })
})

describe("equivalentCommand", () => {
  it("mirrors the simplest case", () => {
    expect(equivalentCommand({ port: "3000", subdomain: "" })).toBe("nport 3000")
  })

  it("names the subdomain when one is requested", () => {
    expect(equivalentCommand({ port: "3000", subdomain: "myapp" })).toBe("nport 3000 -s myapp")
  })

  /**
   * The command has to be the one being run, not a tidied version of it. Printing `myapp` for a
   * field containing `MyApp` would be a command that claims a different-looking name — the server
   * resolves them to the same lease, but the mirror's promise is that it is what runs.
   */
  it("shows the raw request, not the normalized one", () => {
    expect(equivalentCommand({ port: "3000", subdomain: "MyApp" })).toBe("nport 3000 -s MyApp")
  })

  it("adds a backend or registry only when they are set", () => {
    expect(equivalentCommand({ port: "3000", subdomain: "", backend: "" })).toBe("nport 3000")
    expect(
      equivalentCommand({ port: "3000", subdomain: "", backend: "http://localhost:8787" }),
    ).toBe("nport 3000 --backend http://localhost:8787")
    expect(
      equivalentCommand({
        port: "3000",
        subdomain: "myapp",
        registry: "https://api.nport.online",
      }),
    ).toBe("nport 3000 -s myapp --registry https://api.nport.online")
  })

  /** A half-filled form still shows a shape, rather than a command with a blank where a port goes. */
  it("says <port> rather than printing a command that cannot run", () => {
    expect(equivalentCommand({ port: "", subdomain: "myapp" })).toBe("nport <port> -s myapp")
  })
})

describe("canStart", () => {
  it("needs a usable port", () => {
    expect(canStart({ port: "3000", subdomain: "" })).toBe(true)
    expect(canStart({ port: "", subdomain: "" })).toBe(false)
    expect(canStart({ port: "0", subdomain: "" })).toBe(false)
  })

  /** An empty subdomain is a request to generate one, which is not a reason to block the button. */
  it("allows an empty subdomain and blocks a rejected one", () => {
    expect(canStart({ port: "3000", subdomain: "" })).toBe(true)
    expect(canStart({ port: "3000", subdomain: "ab" })).toBe(false)
  })
})
