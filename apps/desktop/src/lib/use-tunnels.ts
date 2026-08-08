import { useCallback, useEffect, useState } from "react"

import { listTunnels, onTunnelEvent, stopTunnel } from "../ipc/tunnels"
import { applyEvent, type TunnelRow, upsertSummary } from "./tunnel-state"

/**
 * The running tunnels, kept current from the event stream.
 *
 * Lifted out of the Tunnels screen because the sidebar needs the count too, and two subscriptions to
 * one stream is two chances to disagree about what is running.
 *
 * The reducing is `tunnel-state.ts`, which is where the tests are. This is only the subscription and
 * its lifetime — the parts that need React and cannot be tested without a renderer.
 */
export function useTunnels(): {
  tunnels: TunnelRow[]
  error: string | null
  stop: (subdomain: string) => void
} {
  const [tunnels, setTunnels] = useState<TunnelRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    async function start() {
      // **Subscribe before seeding.** A tunnel started between the two would otherwise be missed by
      // both: absent from the list, and its `provisioned` fired before anything was listening. In
      // this order the worst case is an event for a row that arrives a moment later, which
      // `applyEvent` drops.
      const stopListening = await onTunnelEvent((message) => {
        setTunnels((rows) => applyEvent(rows, message.subdomain, message.event))
      })
      if (cancelled) {
        stopListening()
        return
      }
      unlisten = stopListening

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

  const stop = useCallback((subdomain: string) => {
    // The row leaves the list on `stopped`, not here: the lease is not released until the drain
    // finishes, and removing it early would show a tunnel as gone while it is still serving.
    void stopTunnel(subdomain).catch((cause: unknown) => {
      setError(String(cause))
    })
  }, [])

  return { tunnels, error, stop }
}
