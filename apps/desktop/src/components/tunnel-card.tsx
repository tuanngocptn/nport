import { useEffect, useRef, useState } from "react"

import type { TunnelRow } from "../lib/tunnel-state"

/**
 * One tunnel, transcribed from `docs/mockup/handoff/desktop/index.html`.
 *
 * As drawn: a live dot, the URL with a Copy button, a meta row of `target · node · requests · time
 * left`, Inspect and Stop buttons, and a progress bar for the lease.
 *
 * **The relay-node chip shows the colo the connections landed on**, which is the closest true thing
 * to the mockup's `⬡ node name`: there is one node today, and `TunnelSummary` does not carry which
 * one served the lease, but `ConnectionUp` carries the Cloudflare colo — which is what a user would
 * actually want from that chip.
 *
 * **The request count is the inspector's**, and the inspector is not enabled yet, so it reads `—`
 * rather than `0`. A zero is a claim that no traffic has arrived; an em dash says nobody is counting.
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
  leaseMs,
  onStop,
  onInspect,
}: {
  tunnel: TunnelRow
  leaseMs: number | null
  onStop: (subdomain: string) => void
  onInspect: () => void
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const resetAt = useRef<ReturnType<typeof setTimeout>>(undefined)
  const status = STATUS[tunnel.status]

  // The reset would otherwise fire into a component that is gone — a stopped tunnel unmounts its
  // card 1.4 s after somebody copies its URL, which is well inside the window.
  useEffect(() => () => clearTimeout(resetAt.current), [])

  async function copy() {
    // **`navigator.clipboard` is not guaranteed in a WebView.** It needs a secure context, and a
    // Tauri app is served from a custom protocol whose treatment differs across WKWebView,
    // WebView2 and WebKitGTK. Unhandled, the promise rejects and the button silently does nothing
    // on the most-used control here. `@tauri-apps/plugin-clipboard-manager` is the real fix and
    // needs a running window to evaluate.
    try {
      await navigator.clipboard.writeText(tunnel.url)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
    clearTimeout(resetAt.current)
    // The mockup's own timing. Long enough to read, short enough that the button is not stuck.
    resetAt.current = setTimeout(() => setCopyState("idle"), 1400)
  }

  return (
    <article className="overflow-hidden rounded-lg border border-hair bg-card shadow-card">
      <div className="flex items-start gap-3 p-4">
        {/* The dot is decoration; the status travels as text. `aria-label` on a bare span is not
            exposed by assistive tech at all — it needs a role — so the label is a real node that
            happens to be visually hidden. */}
        <span className={`mt-1.5 size-2 shrink-0 rounded-pill ${status.dot}`} aria-hidden="true" />
        <span className="sr-only">{status.label}</span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a
              className="truncate font-mono text-[13.5px] text-text hover:underline"
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
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select it" : "Copy"}
            </button>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
            <span>localhost:{tunnel.localPort}</span>
            {tunnel.colo !== null && <span title="Edge location">⬡ {tunnel.colo}</span>}
            <span>{tunnel.connectionsUp} of 4 connections</span>
            <TimeLeft expiresAt={tunnel.expiresAt} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="rounded-md border border-hair bg-chip px-3 py-1.5 text-[12px] text-muted transition-colors duration-200 ease-np hover:text-text"
            onClick={onInspect}
          >
            Inspect
          </button>
          <button
            type="button"
            className="rounded-md border border-hair bg-chip px-3 py-1.5 text-[12px] text-text transition-colors duration-200 ease-np hover:bg-rim disabled:opacity-40"
            onClick={() => onStop(tunnel.subdomain)}
            disabled={tunnel.status === "stopping"}
          >
            {tunnel.status === "stopping" ? "Stopping…" : "Stop"}
          </button>
        </div>
      </div>

      <LeaseBar expiresAt={tunnel.expiresAt} leaseMs={leaseMs} />
    </article>
  )
}

/**
 * How much of the lease is left, as the mockup's bar.
 *
 * The full width is the **server's** lease duration, not a constant here: the mockup divides by
 * 14400 seconds because its demo runs four-hour leases, and a self-hoster's are whatever they set.
 * Without that denominator the bar does not draw, rather than drawing a wrong fraction.
 */
function LeaseBar({ expiresAt, leaseMs }: { expiresAt: number; leaseMs: number | null }) {
  if (leaseMs === null || leaseMs <= 0) return null

  const remaining = Math.max(0, expiresAt - Date.now())
  const fraction = Math.min(1, remaining / leaseMs)

  return (
    <div className="h-0.5 w-full bg-idle" aria-hidden="true">
      <div
        className="h-full bg-green transition-[width] duration-500 ease-np"
        style={{ width: `${(fraction * 100).toFixed(2)}%` }}
      />
    </div>
  )
}

/**
 * Time until the server drops the lease.
 *
 * **Rendered from the server's `expiresAt`, never from a client-side countdown** (invariant 3): the
 * server is authoritative for time limits and the client only displays them.
 */
function TimeLeft({ expiresAt }: { expiresAt: number }) {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return <span>expired</span>

  const minutes = Math.floor(remaining / 60_000)
  const hours = Math.floor(minutes / 60)

  return <span>{hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`} left</span>
}
