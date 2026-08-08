/**
 * The sidebar, from `docs/mockup/handoff/desktop/index.html`.
 *
 * The mockup's has: traffic lights, a New Tunnel button, four nav items with counts, a Buy me a
 * coffee card, a tunnel-slots meter, and a version block.
 *
 * **Two destinations, not four.** Inspector and History are not built; a nav item that navigates
 * nowhere is worse than one that is absent, because it reads as a broken app rather than an
 * unfinished one. They arrive with their screens.
 *
 * **No slots meter.** It shows "2 of 3", and the cap is the *server's* — `maxConcurrentPerSource`
 * from `GET /v1/meta`, which this app does not read yet. Hardcoding 3 would be a client asserting a
 * limit the server owns (invariant 3), and it is wrong the moment a self-hoster tunes it.
 *
 * **No traffic lights.** They are drawn because the mockup simulates a window; the real one is
 * `titleBarStyle: "Overlay"`, so macOS draws its own and Linux and Windows draw theirs.
 *
 * The donate card stays: it is real, it is the project's only funding, and `apps/web` carries the
 * same link.
 */

export type Screen = "tunnels" | "new"

const NAV: { id: Screen; label: string; glyph: string }[] = [
  { id: "tunnels", label: "Tunnels", glyph: "◉" },
  { id: "new", label: "New tunnel", glyph: "＋" },
]

export function Sidebar({
  screen,
  onNavigate,
  tunnelCount,
}: {
  screen: Screen
  onNavigate: (screen: Screen) => void
  tunnelCount: number
}) {
  return (
    <aside className="flex w-52 shrink-0 flex-col gap-4 border-hair border-r bg-sidebar p-3 pt-10">
      <nav className="flex flex-col gap-1" aria-label="Sections">
        {NAV.map((item) => {
          const active = screen === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-200 ease-np ${
                active ? "bg-chip text-text" : "text-muted hover:text-text"
              }`}
              onClick={() => onNavigate(item.id)}
            >
              <span aria-hidden="true" className="text-xs opacity-70">
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
        <span className="text-xs text-text">Buy me a coffee</span>
        <span className="text-[11px] leading-relaxed text-muted">
          NPort is free. Your support pays for the servers that keep it running.
        </span>
      </a>
    </aside>
  )
}
