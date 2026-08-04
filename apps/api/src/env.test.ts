import { describe, expect, it } from "vitest"

import { missingBindings } from "./env"

const COMPLETE = {
  POW_SECRET: "s",
  IP_HASH_SECRET: "h",
  LEASE_TTL_SECONDS: 14400,
  HEARTBEAT_GRACE_SECONDS: 120,
  MAX_ACTIVE_TUNNELS: 1000,
  MIN_CLIENT_VERSION: "3.0.0",
  POW_DIFFICULTY_BITS: 20,
} as const

describe("missingBindings", () => {
  it("reports nothing for a complete environment", () => {
    expect(missingBindings({ ...COMPLETE })).toEqual([])
  })

  it("catches an absent secret", () => {
    const { POW_SECRET: _omitted, ...rest } = COMPLETE
    expect(missingBindings(rest)).toContain("POW_SECRET")
  })

  it("treats an empty secret as missing", () => {
    // A secret rotated to empty is the failure mode that produced the WebCrypto DataError, and
    // it is indistinguishable from unset in practice.
    expect(missingBindings({ ...COMPLETE, POW_SECRET: "" })).toContain("POW_SECRET")
  })

  it("catches a numeric var that does not parse", () => {
    // `Number("")` is 0, so an empty LEASE_TTL_SECONDS would otherwise mean a zero-second lease —
    // a tunnel that expires the instant it is created.
    expect(missingBindings({ ...COMPLETE, LEASE_TTL_SECONDS: "" as never })).toContain(
      "LEASE_TTL_SECONDS",
    )
    expect(missingBindings({ ...COMPLETE, POW_DIFFICULTY_BITS: "abc" as never })).toContain(
      "POW_DIFFICULTY_BITS",
    )
  })

  it("accepts a numeric var supplied as a string, which is how Workers deliver them", () => {
    expect(missingBindings({ ...COMPLETE, LEASE_TTL_SECONDS: "14400" as never })).toEqual([])
  })

  it("does not require MIN_CLIENT_VERSION to be numeric", () => {
    expect(missingBindings({ ...COMPLETE, MIN_CLIENT_VERSION: "3.0.0-beta.1" })).toEqual([])
  })

  it("lists every missing binding, not just the first", () => {
    // An operator fixing one at a time is a slow way to learn there were four.
    expect(missingBindings({}).length).toBeGreaterThanOrEqual(7)
  })
})
