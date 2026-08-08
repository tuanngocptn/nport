import { useState } from "react"

import { type Screen, Sidebar } from "./components/sidebar"
import { useTunnels } from "./lib/use-tunnels"
import { NewTunnelView } from "./views/new-tunnel"
import { TunnelsView } from "./views/tunnels"

/**
 * The window: a sidebar and one screen at a time.
 *
 * **Two of the five screens** (`docs/mockup/README.md`). Inspector, History and Settings arrive with
 * the features behind them; a nav item that goes nowhere reads as a broken app rather than an
 * unfinished one.
 *
 * The tunnel subscription lives here rather than in the Tunnels screen because the sidebar shows a
 * count from it, and two subscriptions to one stream is two chances to disagree.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>("tunnels")
  const { tunnels, error, stop } = useTunnels()

  return (
    <div className="flex h-full">
      <Sidebar screen={screen} onNavigate={setScreen} tunnelCount={tunnels.length} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        {screen === "tunnels" ? (
          <TunnelsView
            tunnels={tunnels}
            error={error}
            onStop={stop}
            onNew={() => setScreen("new")}
          />
        ) : (
          <NewTunnelView onDone={() => setScreen("tunnels")} />
        )}
      </main>
    </div>
  )
}
