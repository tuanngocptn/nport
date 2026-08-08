import { useCallback, useEffect, useRef, useState } from "react"
import type { UiExchange } from "../ipc/exchanges"
import { onExchange } from "../ipc/exchanges"
import { addExchange } from "./exchange-state"

/**
 * Captured traffic, kept current from the exchange stream.
 *
 * Lives beside `useTunnels` and for the same reason: the Tunnels screen's stat grid needs the same
 * data the Inspector does, and two subscriptions to one stream is two chances to disagree.
 */
export function useExchanges(): {
  exchanges: UiExchange[]
  live: boolean
  toggleLive: () => void
} {
  const [exchanges, setExchanges] = useState<UiExchange[]>([])
  const [live, setLive] = useState(true)
  // Read inside the listener, which is registered once — a `live` captured in the closure would
  // freeze at its first value and the toggle would do nothing.
  const liveRef = useRef(live)
  liveRef.current = live

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    onExchange((message) => {
      // **Paused drops rather than buffers.** The mockup's toggle is there so a list stops moving
      // while somebody reads a row; a buffer that replayed everything on resume would undo that at
      // the moment they finished reading. `core`'s ring keeps them either way.
      if (liveRef.current) {
        setExchanges((rows) => addExchange(rows, message.exchange))
      }
    })
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => {})

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const toggleLive = useCallback(() => setLive((on) => !on), [])

  return { exchanges, live, toggleLive }
}
