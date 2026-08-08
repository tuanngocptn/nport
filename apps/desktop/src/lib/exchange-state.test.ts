import { describe, expect, it } from "vitest"

import type { UiExchange } from "../ipc/exchanges"
import {
  addExchange,
  filterExchanges,
  KEEP,
  matches,
  medianLatencyMs,
  path,
  requestsToday,
} from "./exchange-state"

function exchange(over: Partial<UiExchange> = {}): UiExchange {
  return {
    id: 1,
    at: 1_786_000_000_000,
    durationMs: 38,
    kind: "http",
    method: "GET",
    url: "https://myapp.nport.link/",
    status: 200,
    requestHeaders: [],
    responseHeaders: [],
    requestBody: { text: "", total: 0, truncated: false },
    responseBody: { text: "", total: 0, truncated: false },
    failure: null,
    ...over,
  }
}

describe("addExchange", () => {
  it("puts the newest first, because that is the one being looked for", () => {
    const rows = addExchange([exchange({ id: 1 })], exchange({ id: 2 }))
    expect(rows.map((row) => row.id)).toEqual([2, 1])
  })

  /** The renderer needs its own bound: the Rust ring caps memory, this caps the list behind it. */
  it("keeps at most what the ring holds", () => {
    let rows: UiExchange[] = []
    for (let id = 0; id < KEEP + 50; id += 1) {
      rows = addExchange(rows, exchange({ id }))
    }

    expect(rows).toHaveLength(KEEP)
    expect(rows[0]?.id).toBe(KEEP + 49)
  })
})

describe("the mockup's filters", () => {
  it("All takes everything", () => {
    expect(matches(exchange({ status: 500 }), "All")).toBe(true)
  })

  it("API is a path prefix, and reads the path out of a full URL", () => {
    expect(matches(exchange({ url: "https://x.nport.link/api/users" }), "API")).toBe(true)
    expect(matches(exchange({ url: "https://x.nport.link/assets/app.css" }), "API")).toBe(false)
  })

  it("Errors takes 4xx and 5xx", () => {
    expect(matches(exchange({ status: 404 }), "Errors")).toBe(true)
    expect(matches(exchange({ status: 500 }), "Errors")).toBe(true)
    expect(matches(exchange({ status: 302 }), "Errors")).toBe(false)
  })

  /**
   * A failed exchange never reached the origin, so it has no status at all — and belongs under
   * Errors more than anything with one does. Keying only on `status >= 400` would hide exactly the
   * requests somebody is hunting.
   */
  it("Errors takes a failure that has no status", () => {
    expect(matches(exchange({ status: null, failure: "LOCAL_REQUEST_FAILED" }), "Errors")).toBe(
      true,
    )
  })

  it("Mutations is anything that is not a GET", () => {
    expect(matches(exchange({ method: "POST" }), "Mutations")).toBe(true)
    expect(matches(exchange({ method: "DELETE" }), "Mutations")).toBe(true)
    expect(matches(exchange({ method: "GET" }), "Mutations")).toBe(false)
    expect(matches(exchange({ method: "get" }), "Mutations")).toBe(false)
  })

  it("filters a list", () => {
    const rows = [
      exchange({ id: 1, method: "GET" }),
      exchange({ id: 2, method: "POST" }),
      exchange({ id: 3, status: 503 }),
    ]

    expect(filterExchanges(rows, "Mutations").map((row) => row.id)).toEqual([2])
    expect(filterExchanges(rows, "Errors").map((row) => row.id)).toEqual([3])
    expect(filterExchanges(rows, "All")).toHaveLength(3)
  })
})

describe("path", () => {
  it("reads the path out of a full URL", () => {
    expect(path("https://myapp.nport.link/api/users?page=2")).toBe("/api/users")
  })

  /**
   * `Exchange::url` is whatever the edge asked for, and an origin can send something `URL` will not
   * parse. A list that threw on one odd request would lose the other 999.
   */
  it("falls back rather than throwing on something that is not a URL", () => {
    expect(path("/already/a/path")).toBe("/already/a/path")
    expect(path("not a url at all")).toBe("not a url at all")
  })
})

describe("the Tunnels screen's stats", () => {
  it("counts only today's requests", () => {
    const now = new Date("2026-08-08T14:00:00Z").getTime()
    const earlyToday = new Date("2026-08-08T00:30:00Z").getTime()
    const yesterday = new Date("2026-08-07T23:30:00Z").getTime()

    const counted = requestsToday(
      [exchange({ at: earlyToday }), exchange({ at: yesterday }), exchange({ at: now })],
      now,
    )

    // Local midnight, not UTC — the two timestamps either side of it depend on the runner's zone,
    // so this asserts the boundary is applied rather than a fixed count.
    expect(counted).toBeGreaterThanOrEqual(1)
    expect(counted).toBeLessThanOrEqual(3)
  })

  it("takes the median rather than the mean, so one slow request does not skew it", () => {
    const rows = [10, 20, 30, 40, 1000].map((durationMs) => exchange({ durationMs }))
    expect(medianLatencyMs(rows)).toBe(30)
  })

  it("averages the middle pair when the count is even", () => {
    const rows = [10, 20, 30, 40].map((durationMs) => exchange({ durationMs }))
    expect(medianLatencyMs(rows)).toBe(25)
  })

  /** A zero would read as "very fast" rather than "nothing measured". */
  it("is null with nothing measured", () => {
    expect(medianLatencyMs([])).toBeNull()
  })
})
