/**
 * The sidebar, transcribed from `docs/mockup/handoff/desktop/index.html`.
 *
 * Top to bottom as drawn: the New Tunnel button, four nav items with counts, the donate card, the
 * tunnel-slots meter, and the version block.
 *
 * **The traffic lights are not rendered, and that is the design working.** The mockup draws them
 * because a design export has no window chrome; the real app sets `titleBarStyle: "Overlay"`, so
 * macOS draws its own over this space. `pt-10` is the room they need.
 */

import type { ServerLimits } from "../ipc/tunnels"

export type Screen = "tunnels" | "new" | "inspector" | "history" | "settings"

const NAV: { id: Screen; label: string; glyph: string }[] = [
  { id: "tunnels", label: "Tunnels", glyph: "◉" },
  { id: "inspector", label: "Inspector", glyph: "◫" },
  { id: "history", label: "History", glyph: "◷" },
  { id: "settings", label: "Settings", glyph: "⚙" },
]

export function Sidebar({
  screen,
  onNavigate,
  tunnelCount,
  limits,
}: {
  screen: Screen
  onNavigate: (screen: Screen) => void
  tunnelCount: number
  limits: ServerLimits | null
}) {
  return (
    <aside className="flex w-[224px] shrink-0 flex-col gap-4 border-hair border-r bg-sidebar p-3 pt-10">
      <button
        type="button"
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-green py-2 text-sm font-medium text-page shadow-green transition-opacity duration-200 ease-np hover:opacity-90"
        onClick={() => onNavigate("new")}
      >
        <span aria-hidden="true">＋</span> New Tunnel
      </button>

      <nav className="flex flex-col gap-0.5" aria-label="Sections">
        {NAV.map((item) => {
          const active = screen === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors duration-200 ease-np ${
                active ? "bg-chip text-text" : "text-muted hover:text-text"
              }`}
              onClick={() => onNavigate(item.id)}
            >
              <span aria-hidden="true" className="w-3.5 text-center text-[11px] opacity-70">
                {item.glyph}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.id === "tunnels" && tunnelCount > 0 && (
                <span className="rounded-pill bg-chip px-1.5 font-mono text-[10px] text-muted">
                  {tunnelCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="flex-1" />

      <a
        className="flex flex-col gap-1.5 rounded-lg border border-hair bg-card p-3 transition-colors duration-200 ease-np hover:bg-rim"
        href="https://buymeacoffee.com/tuanngocptn"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="text-[12px] text-text">Buy me a coffee</span>
        <span className="text-[11px] leading-relaxed text-muted">
          NPort is free. Your support pays for the servers that keep it running.
        </span>
        <span className="text-[11px] text-green">Support the project →</span>
      </a>

      <Slots used={tunnelCount} limits={limits} />

      <div className="flex items-center gap-2 px-0.5">
        <div className="flex flex-col leading-tight">
          <span className="text-[11px] text-text">Version {__APP_VERSION__}</span>
          <span className="text-[10px] text-muted">Desktop app</span>
        </div>
      </div>
    </aside>
  )
}

/**
 * The tunnel-slots meter.
 *
 * **The cap is the server's**, read from `GET /v1/meta`'s `maxConcurrentPerSource` — invariant 3
 * makes the server authoritative for limits and this is one. Before it answers there is no honest
 * number to draw, so the bar renders its unknown state rather than guessing three; a self-hoster who
 * raised the cap would see a meter that lies until it loads.
 */
function Slots({ used, limits }: { used: number; limits: ServerLimits | null }) {
  const total = limits?.maxConcurrentPerSource ?? null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-hair bg-card p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-muted">Tunnel slots</span>
        <span className="font-mono text-[11px] text-text">
          {total === null ? `${used}` : `${used} of ${total}`}
        </span>
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: total ?? Math.max(used, 1) }, (_, slot) => (
          <i
            key={slot}
            className={`h-1 flex-1 rounded-pill ${slot < used ? "bg-green" : "bg-idle"}`}
          />
        ))}
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted">
        Running on your own Cloudflare account.
      </p>
    </div>
  )
}
