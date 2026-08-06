/**
 * The client-version gate's arithmetic, tested directly for the first time.
 *
 * It had route-level coverage in `apps/api` and no unit tests, which left the one genuinely subtle
 * rule — that a pre-release sorts *below* its release — resting on whichever User-Agent the route
 * tests happened to send. Both Workers now share these functions, so a disagreement here would mean
 * one service admitting a client the other refuses.
 */

import { describe, expect, it } from "vitest"

import { compareVersions, parseVersion } from "./version"

describe("parseVersion", () => {
  it("reads the version out of the CLI's User-Agent", () => {
    expect(parseVersion("nport/3.0.0 (darwin; arm64)")).toBe("3.0.0")
    expect(parseVersion("nport/3.0.0")).toBe("3.0.0")
  })

  it("keeps a pre-release suffix", () => {
    // Dropping it would make `3.0.0-beta.1` indistinguishable from `3.0.0`, which is the whole
    // distinction the floor depends on at a release boundary.
    expect(parseVersion("nport/3.0.0-dev (linux; x86_64)")).toBe("3.0.0-dev")
    expect(parseVersion("nport/3.0.0-beta.1 (windows; x86_64)")).toBe("3.0.0-beta.1")
  })

  it("refuses a version smuggled in past the start of the string", () => {
    // The anchor is the point: a hostile client must not be able to append a high version and pass.
    expect(parseVersion("curl/8.0 nport/9.9.9")).toBeUndefined()
    expect(parseVersion("Mozilla/5.0 (compatible; nport/9.9.9)")).toBeUndefined()
  })

  it("is undefined for anything that did not identify itself", () => {
    expect(parseVersion("")).toBeUndefined()
    expect(parseVersion("curl/8.0")).toBeUndefined()
    // Not three numeric parts.
    expect(parseVersion("nport/3.0")).toBeUndefined()
    expect(parseVersion("nport/three.oh.oh")).toBeUndefined()
  })
})

describe("compareVersions", () => {
  it("orders numeric triples by each component", () => {
    expect(compareVersions("3.0.0", "3.0.0")).toBe(0)
    expect(compareVersions("2.9.9", "3.0.0")).toBe(-1)
    expect(compareVersions("3.1.0", "3.0.9")).toBe(1)
    expect(compareVersions("3.0.2", "3.0.10")).toBe(-1)
  })

  it("sorts a pre-release below its own release", () => {
    // **The rule the release boundary turns on.** Without it, every beta satisfies a `3.0.0` floor
    // the moment 3.0.0 ships.
    expect(compareVersions("3.0.0-beta.1", "3.0.0")).toBe(-1)
    expect(compareVersions("3.0.0", "3.0.0-beta.1")).toBe(1)
    expect(compareVersions("3.0.0-dev", "3.0.0-dev")).toBe(0)
  })

  it("sorts a pre-release above the previous release", () => {
    expect(compareVersions("3.0.0-beta.1", "2.9.9")).toBe(1)
  })

  it("compares pre-release tags as strings, which is why staging's floor is 0.0.0", () => {
    // Documented rather than admired: `beta` < `dev` lexically, so a floor of `3.0.0-dev` would
    // refuse every beta. `apps/api/wrangler.jsonc` explains why staging uses `0.0.0` instead, and
    // this is the assertion behind that paragraph.
    expect(compareVersions("3.0.0-beta.1", "3.0.0-dev")).toBe(-1)
    expect(compareVersions("3.0.0-dev", "3.0.0-beta.1")).toBe(1)
    // Which is exactly what a `0.0.0` floor sidesteps: everything clears it.
    expect(compareVersions("3.0.0-beta.1", "0.0.0")).toBe(1)
    expect(compareVersions("3.0.0-dev", "0.0.0")).toBe(1)
  })

  it("treats a missing or unparseable component as zero rather than throwing", () => {
    // The gate calls this with a floor from a config var, which a misconfiguration can make odd. A
    // throw here would be a 500 on every request; reading it as 0.0.0 fails open on the version
    // check only, which the other controls still cover.
    expect(compareVersions("3", "3.0.0")).toBe(0)
    expect(compareVersions("", "0.0.0")).toBe(0)
    expect(compareVersions("3.0.0", "")).toBe(1)
  })
})
