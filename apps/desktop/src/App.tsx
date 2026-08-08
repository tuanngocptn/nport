import { useEffect, useState } from "react"

import { type Screen, Sidebar } from "./components/sidebar"
import { Toolbar } from "./components/toolbar"
import { type ServerLimits, serverLimits } from "./ipc/tunnels"
import { liveCount } from "./lib/tunnel-state"
import { useExchanges } from "./lib/use-exchanges"
import { useTunnels } from "./lib/use-tunnels"
import { ComingSoonView } from "./views/coming-soon"
import { InspectorView } from "./views/inspector"
import { NewTunnelView } from "./views/new-tunnel"
import { TunnelsView } from "./views/tunnels"

/**
 * The window: a sidebar, a toolbar, and one screen at a time — the shell
 * `docs/mockup/handoff/desktop/index.html` draws.
 *
 * All five screens are reachable, because the mockup's nav has all five. Three of them say what
 * they will hold rather than pretending to hold it.
 *
 * The tunnel subscription and the server's limits both live here: the sidebar counts tunnels and
 * meters slots, the toolbar states the lease, and the cards draw a bar against it. Two subscriptions
 * to one stream would be two chances to disagree.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>("tunnels")
  const { tunnels, error, stop } = useTunnels()
  const limits = useServerLimits()
  const { exchanges, live, toggleLive } = useExchanges()

  return (
    <div className="flex h-full">
      <Sidebar
        screen={screen}
        onNavigate={setScreen}
        tunnelCount={tunnels.length}
        limits={limits}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          screen={screen}
          live={liveCount(tunnels)}
          leaseHours={limits === null ? null : Math.round(limits.tunnelDurationMs / 3_600_000)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {screen === "tunnels" && (
            <TunnelsView
              tunnels={tunnels}
              error={error}
              limits={limits}
              exchanges={exchanges}
              onStop={stop}
              onNew={() => setScreen("new")}
              onInspect={() => setScreen("inspector")}
            />
          )}
          {screen === "new" && <NewTunnelView onDone={() => setScreen("tunnels")} />}
          {screen === "inspector" && (
            <InspectorView exchanges={exchanges} live={live} onToggleLive={toggleLive} />
          )}
          {(screen === "history" || screen === "settings") && <ComingSoonView screen={screen} />}
        </div>
      </main>
    </div>
  )
}

/**
 * The server's limits, fetched once when the window opens.
 *
 * **A failure is not surfaced**, and that is deliberate: every consumer takes `null` and renders
 * without the number rather than wrongly. A banner saying the limits could not be read would be
 * alarming about something the user cannot act on and which stops nothing from working — the
 * tunnels list, starting and stopping all work without it.
 */
function useServerLimits(): ServerLimits | null {
  const [limits, setLimits] = useState<ServerLimits | null>(null)

  useEffect(() => {
    let cancelled = false
    serverLimits()
      .then((fetched) => {
        if (!cancelled) setLimits(fetched)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return limits
}
