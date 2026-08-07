import type { TunnelEvent, TunnelSummary } from "../ipc/tunnels"

/**
 * The tunnel list, as a pure function of what the backend has said.
 *
 * In `lib/` rather than inside a hook so it can be tested without a React renderer or a Tauri
 * runtime — the same reason `apps/web/src/lib/error-codes.ts` sits outside its route. What is worth
 * testing here is the bookkeeping: how many connections are up, when a tunnel stops being *live*,
 * and which row an event belongs to. None of that needs a DOM.
 */

/** How many HA connections a tunnel opens. `docs/PROTOCOL.md` §4; `core` fixes it at four. */
export const CONNECTIONS = 4

/**
 * What the row shows.
 *
 * `degraded` is a real state and not a failure: the edge recycles connections, so losing one is
 * ordinary and the tunnel keeps serving on the rest. Rendering it as an error would cry wolf several
 * times an hour; rendering it as `live` would hide a tunnel that is genuinely down to its last
 * connection.
 */
export type TunnelStatus = "starting" | "live" | "degraded" | "stopping"

export interface TunnelRow {
  subdomain: string
  url: string
  /** Epoch milliseconds, server-authoritative. Display only (invariant 3). */
  expiresAt: number
  localPort: number
  connectionsUp: number
  status: TunnelStatus
}

/**
 * Merges the authoritative summary a command returned.
 *
 * `start_tunnel` resolves with a `TunnelSummary` **and** emits `provisioned`, and the two race: the
 * event can arrive before the promise settles. Both paths therefore have to be idempotent, and this
 * one wins on `localPort` because the event does not carry it — only the command knows which port
 * the user asked to tunnel.
 */
export function upsertSummary(rows: TunnelRow[], summary: TunnelSummary): TunnelRow[] {
  const existing = rows.find((row) => row.subdomain === summary.subdomain)
  if (existing === undefined) {
    return [
      ...rows,
      {
        subdomain: summary.subdomain,
        url: summary.url,
        expiresAt: summary.expiresAt,
        localPort: summary.localPort,
        connectionsUp: 0,
        status: "starting",
      },
    ]
  }

  return rows.map((row) =>
    row.subdomain === summary.subdomain
      ? { ...row, url: summary.url, expiresAt: summary.expiresAt, localPort: summary.localPort }
      : row,
  )
}

/**
 * Applies one event from the stream.
 *
 * Returns a new array; a row that did not change keeps its identity, so React can skip it.
 *
 * **An event for a subdomain that is not in the list is dropped**, except `provisioned` which
 * creates the row. That is not defensive padding: a `stopped` for a row already removed arrives
 * whenever two stops race, and treating it as a reason to resurrect the row would put a dead tunnel
 * back on screen.
 */
export function applyEvent(rows: TunnelRow[], subdomain: string, event: TunnelEvent): TunnelRow[] {
  if (event.type === "provisioned") {
    const seeded = upsertSummary(rows, {
      subdomain: event.subdomain,
      url: event.url,
      expiresAt: event.expiresAt,
      // Unknown from an event — `upsertSummary` fills it in when the command resolves, and it is
      // deliberately 0 rather than a guess so a row rendering `:0` is visibly wrong rather than
      // plausibly wrong.
      localPort: rows.find((row) => row.subdomain === event.subdomain)?.localPort ?? 0,
    })
    return seeded
  }

  // The tunnel is gone: its lease is released and nothing more will arrive for it.
  if (event.type === "stopped") {
    return rows.filter((row) => row.subdomain !== subdomain)
  }

  return rows.map((row) => {
    if (row.subdomain !== subdomain) return row

    switch (event.type) {
      case "connectionUp": {
        const connectionsUp = Math.min(row.connectionsUp + 1, CONNECTIONS)
        return { ...row, connectionsUp, status: statusFor(connectionsUp, row.status) }
      }
      case "connectionLost":
      case "connectionGaveUp": {
        const connectionsUp = Math.max(row.connectionsUp - 1, 0)
        return { ...row, connectionsUp, status: statusFor(connectionsUp, row.status) }
      }
      case "shuttingDown":
        return { ...row, status: "stopping" }
      default:
        // `connectionRetrying` changes nothing on the row — the count already dropped when the
        // connection was lost, and a retry is not a second loss.
        return row
    }
  })
}

/**
 * Status from the connection count, unless the tunnel is already on its way out.
 *
 * **`stopping` is sticky.** Connections drop as a tunnel drains, and recomputing from the count
 * would walk it back through `degraded` and `starting` on the way to zero — a row that reads
 * "starting" while it is shutting down.
 */
function statusFor(connectionsUp: number, current: TunnelStatus): TunnelStatus {
  if (current === "stopping") return "stopping"
  if (connectionsUp === 0) return "starting"
  return connectionsUp === CONNECTIONS ? "live" : "degraded"
}

/** How many tunnels are carrying traffic — what the toolbar's "N live" chip counts. */
export function liveCount(rows: TunnelRow[]): number {
  return rows.filter((row) => row.status === "live" || row.status === "degraded").length
}
