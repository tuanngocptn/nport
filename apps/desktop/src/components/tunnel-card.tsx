import { useState } from "react"

import type { TunnelRow } from "../lib/tunnel-state"

/**
 * One tunnel in the list, from `docs/mockup/handoff/desktop/index.html`.
 *
 * The mockup's card carries: a status dot, the URL with a Copy button, a meta row of
 * `target · node · requests · time left`, an Inspect and a Stop button, and a progress bar for the
 * lease.
 *
 * **Two of those are not rendered, because nothing real is behind them yet.** *Requests* comes from
 * `core::inspector`, which the app does not enable yet, and *Inspect* would navigate to a screen
 * that does not exist. The mockup is the authority on what the app looks like when it is finished,
 * not a licence to draw numbers the app cannot compute — a card showing "0 requests" next to a
 * tunnel serving traffic is worse than a card that does not mention requests. Both land with the
 * inspector.
 *
 * The relay-node chip is absent for the same reason in a different shape: there is one node, and
 * `TunnelSummary` does not carry which one served the lease.
 */

/** Colour and label per status. `degraded` is amber and not red — the edge recycles connections. */
const STATUS = {
  starting: { dot: "bg-idle", label: "starting" },
  live: { dot: "bg-green shadow-green", label: "live" },
  degraded: { dot: "bg-yellow shadow-yellow", label: "degraded" },
  stopping: { dot: "bg-idle", label: "stopping" },
} as const

export function TunnelCard({
  tunnel,
  onStop,
}: {
  tunnel: TunnelRow
  onStop: (subdomain: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const status = STATUS[tunnel.status]

  async function copy() {
    await navigator.clipboard.writeText(tunnel.url)
    setCopied(true)
    // The mockup's own timing. Long enough to read, short enough that the button is not stuck.
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <article className="rounded-lg border border-hair bg-card p-4 shadow-card">
      <div className="flex items-start gap-3">
        {/* The dot is decoration; the status travels as text. `aria-label` on a bare span is not
            exposed by assistive tech at all — it needs a role — so the label is a real node that
            happens to be visually hidden, which also survives a stylesheet failing to load. */}
        <span className={`mt-1.5 size-2 shrink-0 rounded-pill ${status.dot}`} aria-hidden="true" />
        <span className="sr-only">{status.label}</span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a
              className="truncate font-mono text-sm text-text hover:underline"
              href={tunnel.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {tunnel.url}
            </a>
            <button
              type="button"
              className="shrink-0 rounded-pill border border-hair bg-chip px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-200 ease-np hover:text-text"
              onClick={() => void copy()}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
            <span>localhost:{tunnel.localPort}</span>
            <span>{tunnel.connectionsUp} of 4 connections</span>
            <TimeLeft expiresAt={tunnel.expiresAt} />
          </div>
        </div>

        <button
          type="button"
          className="shrink-0 rounded-md border border-hair bg-chip px-3 py-1.5 text-xs text-text transition-colors duration-200 ease-np hover:bg-rim"
          onClick={() => onStop(tunnel.subdomain)}
          disabled={tunnel.status === "stopping"}
        >
          {tunnel.status === "stopping" ? "Stopping…" : "Stop"}
        </button>
      </div>
    </article>
  )
}

/**
 * Time until the server drops the lease.
 *
 * **Rendered from the server's `expiresAt`, never from a client-side countdown** (invariant 3): the
 * server is authoritative for time limits and the client only displays them. Computed at render
 * rather than ticked, so a clock that never re-renders shows a stale value instead of a wrong one
 * that keeps counting after the tunnel is gone.
 */
function TimeLeft({ expiresAt }: { expiresAt: number }) {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return <span>expired</span>

  const minutes = Math.floor(remaining / 60_000)
  const hours = Math.floor(minutes / 60)

  return <span>{hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`} left</span>
}
