import { useEffect, useState } from "react"

import { TunnelCard } from "../components/tunnel-card"
import { listTunnels, onTunnelEvent, stopTunnel } from "../ipc/tunnels"
import { applyEvent, liveCount, type TunnelRow, upsertSummary } from "../lib/tunnel-state"

/**
 * The Tunnels screen — the first of the five in `docs/mockup/README.md`.
 *
 * All the state lives in `lib/tunnel-state.ts`, which is where it is tested. This file is the wiring:
 * subscribe, seed, render.
 */
export function TunnelsView() {
  const [tunnels, setTunnels] = useState<TunnelRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    async function start() {
      // **Subscribe before seeding, not after.** A tunnel started between the two would otherwise be
      // missed by both: absent from the list, and its `provisioned` fired before anything was
      // listening. Seeding second means the worst case is applying an event to a row that arrives a
      // moment later, which `applyEvent` drops, rather than losing the row entirely.
      const stop = await onTunnelEvent((message) => {
        setTunnels((rows) => applyEvent(rows, message.subdomain, message.event))
      })
      if (cancelled) {
        stop()
        return
      }
      unlisten = stop

      const running = await listTunnels()
      setTunnels((rows) => running.reduce(upsertSummary, rows))
    }

    start().catch((cause: unknown) => {
      setError(String(cause))
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const live = liveCount(tunnels)

  return (
    <section className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-text">Tunnels</h1>
          <p className="mt-1 text-sm text-muted">
            Up to three at once · the server closes them after their lease
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-pill border border-hair bg-chip px-3 py-1.5">
          <i
            className={`size-1.5 rounded-pill ${live > 0 ? "bg-green shadow-green" : "bg-idle"}`}
          />
          <span className="font-mono text-[11px] text-muted">{live} live</span>
        </span>
      </header>

      {error !== null && (
        <p className="rounded-md border border-hair bg-card p-3 font-mono text-xs text-red">
          {error}
        </p>
      )}

      {tunnels.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3">
          {tunnels.map((tunnel) => (
            <TunnelCard
              key={tunnel.subdomain}
              tunnel={tunnel}
              onStop={(subdomain) => {
                void stopTunnel(subdomain).catch((cause: unknown) => {
                  setError(String(cause))
                })
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * What the screen says with nothing running.
 *
 * The mockup draws a "Start another tunnel" button here that navigates to the *New tunnel* screen.
 * That screen is not built, so this states the situation rather than offering a control that goes
 * nowhere — a dead button is a worse first impression than an honest empty state.
 */
function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center rounded-lg border border-hair border-dashed bg-card/40">
      <div className="max-w-xs text-center">
        <p className="text-sm text-text">No tunnels running.</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          The New tunnel screen arrives with the rest of Phase 4. Until then the CLI starts one:{" "}
          <code className="font-mono text-text">nport 3000</code>
        </p>
      </div>
    </div>
  )
}
