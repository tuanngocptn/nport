import type { Screen } from "./sidebar"

/**
 * The content toolbar, from `docs/mockup/handoff/desktop/index.html`.
 *
 * Title, subtitle, a Buy me a coffee button and a live-count chip — shared across every screen, with
 * the title and subtitle bound per screen exactly as the mockup's `data-bind="title"` and
 * `subtitle` are.
 */

/** The mockup's own strings, except where a number belongs to the server. */
const TITLES: Record<Screen, string> = {
  tunnels: "Tunnels",
  new: "New Tunnel",
  inspector: "Inspector",
  history: "History",
  settings: "Settings",
}

export function Toolbar({
  screen,
  live,
  leaseHours,
}: {
  screen: Screen
  live: number
  leaseHours: number | null
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-hair border-b bg-toolbar px-6 py-4">
      <div className="min-w-0">
        <h1 className="font-display text-[19px] tracking-tight text-text">{TITLES[screen]}</h1>
        <p className="mt-0.5 text-[12px] text-muted">{subtitle(screen, leaseHours)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <a
          className="rounded-pill border border-hair bg-chip px-3 py-1.5 text-[11.5px] text-text transition-colors duration-200 ease-np hover:bg-rim"
          href="https://buymeacoffee.com/tuanngocptn"
          target="_blank"
          rel="noopener noreferrer"
        >
          Buy me a coffee
        </a>
        <span className="flex items-center gap-2 rounded-pill border border-hair bg-chip px-3 py-1.5">
          <i
            aria-hidden="true"
            className={`size-1.5 rounded-pill ${live > 0 ? "bg-green shadow-green" : "bg-idle"}`}
          />
          <span className="font-mono text-[11px] text-muted">{live} live</span>
        </span>
      </div>
    </header>
  )
}

/**
 * The mockup's subtitle for Tunnels is "Up to three at once · auto-cleanup after 4 hours".
 *
 * **Both numbers are the server's**, so both come from `GET /v1/meta` and neither is written here.
 * Until it answers the sentence states only what is known — the alternative is printing "4 hours" to
 * a self-hoster whose leases last a day.
 */
function subtitle(screen: Screen, leaseHours: number | null): string {
  switch (screen) {
    case "tunnels":
      return leaseHours === null
        ? "The server closes each tunnel when its lease ends"
        : `Auto-cleanup after ${leaseHours} ${leaseHours === 1 ? "hour" : "hours"}`
    case "new":
      return "Port, name, go"
    case "inspector":
      return "Live traffic through your tunnels"
    case "history":
      return "Presets and recent tunnels"
    case "settings":
      return "Backend, preferences and language"
  }
}
