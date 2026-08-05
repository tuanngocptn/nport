/**
 * Turning an `ApiError` into HTTP, at the two edges that a route test cannot reach.
 *
 * `retryAfterSeconds` is where the header comes from, and both of its inputs are easy to get wrong in
 * ways an integration test would not notice: an absolute instant read as a duration is nonsense, and a
 * clamp that lets `0` through invites the immediate retry the header exists to prevent.
 */

import { describe, expect, it } from "vitest"

import { retryAfterSeconds } from "./errors"

const NOW = 1_785_000_000_000

describe("retryAfterSeconds", () => {
  it("reads `retryAfter` as a duration", () => {
    // What `RATE_LIMITED` and `CAPACITY_EXHAUSTED` carry: seconds from now.
    expect(retryAfterSeconds({ retryAfter: 60 }, NOW)).toBe(60)
  })

  it("reads `resetAt` as an instant", () => {
    // What `CREATE_QUOTA_EXCEEDED` carries: the moment the sliding window's oldest attempt expires.
    // Treating this as a duration would tell a client to wait for fifty-six thousand years.
    expect(retryAfterSeconds({ resetAt: NOW + 90_000 }, NOW)).toBe(90)
  })

  it("prefers a duration when both are present", () => {
    // Only one refusal should ever carry both, but the precedence has to be decided rather than
    // discovered: a duration is already relative to now and needs no clock agreement.
    expect(retryAfterSeconds({ retryAfter: 30, resetAt: NOW + 900_000 }, NOW)).toBe(30)
  })

  it("never returns less than one second", () => {
    // `Retry-After: 0` is an invitation to retry immediately, which is the opposite of the point. A
    // `resetAt` in the past is reachable: the window can lapse between the check and the response.
    expect(retryAfterSeconds({ retryAfter: 0 }, NOW)).toBe(1)
    expect(retryAfterSeconds({ resetAt: NOW - 5_000 }, NOW)).toBe(1)
    expect(retryAfterSeconds({ retryAfter: 0.2 }, NOW)).toBe(1)
  })

  it("never returns more than the longest window", () => {
    // An hour is the longest limit here. A `resetAt` far in the future — clock skew, or a value stored
    // under a longer window — must not tell a client to sleep for a day.
    expect(retryAfterSeconds({ resetAt: NOW + 86_400_000 }, NOW)).toBe(3600)
    expect(retryAfterSeconds({ retryAfter: 99_999 }, NOW)).toBe(3600)
  })

  it("rounds up, so the header never expires early", () => {
    expect(retryAfterSeconds({ resetAt: NOW + 1_400 }, NOW)).toBe(2)
  })

  it("says nothing when there is nothing to say", () => {
    // `CONCURRENCY_LIMIT` carries only a `limit`: waiting does not help, closing a tunnel does, and a
    // header there would invite exactly the loop it should discourage.
    expect(retryAfterSeconds({ limit: 3 }, NOW)).toBeUndefined()
    expect(retryAfterSeconds(undefined, NOW)).toBeUndefined()
    expect(retryAfterSeconds({}, NOW)).toBeUndefined()
  })

  it("ignores values that are not finite numbers", () => {
    // `details` is `Record<string, unknown>`, so a string or a NaN is a type the compiler allows in.
    expect(retryAfterSeconds({ retryAfter: "60" }, NOW)).toBeUndefined()
    expect(retryAfterSeconds({ resetAt: Number.NaN }, NOW)).toBeUndefined()
    expect(retryAfterSeconds({ retryAfter: Number.POSITIVE_INFINITY }, NOW)).toBeUndefined()
  })
})
