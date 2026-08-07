import { describe, expect, it } from "vitest"

import type { TunnelEvent } from "../ipc/tunnels"
import { applyEvent, CONNECTIONS, liveCount, type TunnelRow, upsertSummary } from "./tunnel-state"

const SUMMARY = {
  subdomain: "myapp",
  url: "https://myapp.nport.link",
  expiresAt: 1_786_000_000_000,
  localPort: 3000,
}

/** A row mid-flight, with `up` of its connections registered. */
function rowWith(up: number): TunnelRow[] {
  let rows = upsertSummary([], SUMMARY)
  for (let index = 0; index < up; index += 1) {
    rows = applyEvent(rows, "myapp", { type: "connectionUp", index, colo: "hkg09" })
  }
  return rows
}

describe("upsertSummary", () => {
  it("adds a tunnel that is not there yet, with nothing connected", () => {
    const [row] = upsertSummary([], SUMMARY)

    expect(row).toMatchObject({ subdomain: "myapp", localPort: 3000, connectionsUp: 0 })
    expect(row?.status).toBe("starting")
  })

  /**
   * `start_tunnel` resolves *and* emits `provisioned`, and the two race. Applying both must not
   * produce two rows for one tunnel.
   */
  it("is idempotent, because the command and the event both report the same tunnel", () => {
    const afterEvent = applyEvent([], "myapp", {
      type: "provisioned",
      url: SUMMARY.url,
      subdomain: SUMMARY.subdomain,
      expiresAt: SUMMARY.expiresAt,
    })
    const afterBoth = upsertSummary(afterEvent, SUMMARY)

    expect(afterBoth).toHaveLength(1)
    expect(afterBoth[0]?.localPort).toBe(3000)
  })

  /** The event cannot know the port; only the command that was given it can. */
  it("supplies the local port the event could not", () => {
    const fromEvent = applyEvent([], "myapp", {
      type: "provisioned",
      url: SUMMARY.url,
      subdomain: SUMMARY.subdomain,
      expiresAt: SUMMARY.expiresAt,
    })
    expect(fromEvent[0]?.localPort).toBe(0)

    expect(upsertSummary(fromEvent, SUMMARY)[0]?.localPort).toBe(3000)
  })
})

describe("connection counting", () => {
  it("is live only once every connection has registered", () => {
    for (let up = 1; up < CONNECTIONS; up += 1) {
      expect(rowWith(up)[0]?.status, `${up} of ${CONNECTIONS}`).toBe("degraded")
    }
    expect(rowWith(CONNECTIONS)[0]?.status).toBe("live")
  })

  /**
   * The edge recycles connections, so losing one is ordinary. A tunnel that dropped to three of four
   * is still serving and must not render as an error — nor as fully live, which would hide a tunnel
   * down to its last connection.
   */
  it("degrades rather than failing when one connection drops", () => {
    const rows = applyEvent(rowWith(CONNECTIONS), "myapp", { type: "connectionLost", index: 2 })

    expect(rows[0]).toMatchObject({ connectionsUp: CONNECTIONS - 1, status: "degraded" })
  })

  it("counts a connection that gave up the same as one that dropped", () => {
    const rows = applyEvent(rowWith(CONNECTIONS), "myapp", {
      type: "connectionGaveUp",
      index: 1,
      code: "EDGE_CONNECT_FAILED",
    })

    expect(rows[0]?.connectionsUp).toBe(CONNECTIONS - 1)
  })

  /** A retry is not a second loss — the count already dropped when the connection was lost. */
  it("does not double-count a retry", () => {
    const lost = applyEvent(rowWith(CONNECTIONS), "myapp", { type: "connectionLost", index: 0 })
    const retrying = applyEvent(lost, "myapp", {
      type: "connectionRetrying",
      index: 0,
      attempt: 1,
      delayMs: 1500,
    })

    expect(retrying[0]?.connectionsUp).toBe(CONNECTIONS - 1)
  })

  it("never counts past the connections a tunnel has, however many events arrive", () => {
    let rows = rowWith(CONNECTIONS)
    rows = applyEvent(rows, "myapp", { type: "connectionUp", index: 0, colo: "hkg09" })

    expect(rows[0]?.connectionsUp).toBe(CONNECTIONS)
  })
})

describe("shutdown", () => {
  /**
   * Connections drop as a tunnel drains. Recomputing status from the count would walk a stopping
   * tunnel back through `degraded` and `starting` on its way to zero.
   */
  it("stays stopping while its connections drain", () => {
    let rows = applyEvent(rowWith(CONNECTIONS), "myapp", {
      type: "shuttingDown",
      reason: "requested",
    })
    expect(rows[0]?.status).toBe("stopping")

    for (let index = 0; index < CONNECTIONS; index += 1) {
      rows = applyEvent(rows, "myapp", { type: "connectionLost", index })
      expect(rows[0]?.status, `after losing ${index + 1}`).toBe("stopping")
    }
  })

  it("removes the tunnel once it has stopped", () => {
    const rows = applyEvent(rowWith(CONNECTIONS), "myapp", { type: "stopped", drained: true })

    expect(rows).toEqual([])
  })

  /** Two stops racing: the second arrives for a row that is already gone. */
  it("ignores a stop for a tunnel that is no longer listed", () => {
    const rows = applyEvent([], "myapp", { type: "stopped", drained: true })

    expect(rows).toEqual([])
  })
})

describe("attribution", () => {
  /**
   * The reason `TunnelMessage` carries a subdomain at all: connection indices are 0..3 for *every*
   * tunnel, so without it this event could belong to either row.
   */
  it("applies an event only to the tunnel it names", () => {
    const rows = upsertSummary(upsertSummary([], SUMMARY), {
      ...SUMMARY,
      subdomain: "other",
      url: "https://other.nport.link",
      localPort: 4000,
    })

    const after = applyEvent(rows, "other", { type: "connectionUp", index: 0, colo: "fra05" })

    expect(after.find((row) => row.subdomain === "myapp")?.connectionsUp).toBe(0)
    expect(after.find((row) => row.subdomain === "other")?.connectionsUp).toBe(1)
  })

  it("drops a connection event for a tunnel it does not know", () => {
    const rows = rowWith(CONNECTIONS)
    const after = applyEvent(rows, "ghost", { type: "connectionLost", index: 0 })

    expect(after).toEqual(rows)
  })
})

describe("liveCount", () => {
  it("counts serving tunnels, degraded included, and excludes those still starting", () => {
    const starting = upsertSummary([], SUMMARY)
    expect(liveCount(starting)).toBe(0)

    const degraded = rowWith(2)
    expect(liveCount(degraded)).toBe(1)

    const live = rowWith(CONNECTIONS)
    expect(liveCount(live)).toBe(1)
  })

  /** A draining tunnel is not serving; counting it would overstate what is reachable. */
  it("does not count a tunnel that is shutting down", () => {
    const stopping = applyEvent(rowWith(CONNECTIONS), "myapp", {
      type: "shuttingDown",
      reason: "requested",
    })

    expect(liveCount(stopping)).toBe(0)
  })
})

describe("the event union", () => {
  /**
   * Every variant reaches the reducer without throwing. Not a substitute for the Rust test that
   * pins the payloads — this checks the TypeScript half stays exhaustive as the union grows.
   */
  it("handles every variant it declares", () => {
    const events: TunnelEvent[] = [
      { type: "provisioned", url: SUMMARY.url, subdomain: "myapp", expiresAt: 1 },
      { type: "connectionUp", index: 0, colo: "hkg09" },
      { type: "connectionLost", index: 0 },
      { type: "connectionRetrying", index: 0, attempt: 1, delayMs: 1500 },
      { type: "connectionGaveUp", index: 0, code: "EDGE_CONNECT_FAILED" },
      { type: "shuttingDown", reason: "leaseExpired" },
      { type: "stopped", drained: true },
    ]

    let rows: TunnelRow[] = []
    for (const event of events) {
      rows = applyEvent(rows, "myapp", event)
    }

    expect(rows).toEqual([])
  })
})
