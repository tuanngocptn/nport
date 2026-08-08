import type { Screen } from "../components/sidebar"

/**
 * The three screens the mockup draws that are not built yet.
 *
 * **They are in the nav because the mockup puts them there**, and a nav that silently omits half the
 * app is a worse map of it than one that says "not yet". What each screen will hold is stated from
 * the design rather than invented, so this reads as a plan rather than an apology.
 *
 * Each is replaced wholesale by its real screen; none of this markup survives.
 */

const PLANNED: Record<string, { headline: string; detail: string }> = {
  inspector: {
    headline: "Live traffic, request by request",
    detail:
      "Method, path, status and timing for every request through your tunnels, with the body and headers beside them — and Replay. It reads `core::inspector`, which the app does not enable yet.",
  },
  history: {
    headline: "Pinned presets and recent tunnels",
    detail:
      "The tunnels you start often, one click away, and a table of the ones you have run before.",
  },
  settings: {
    headline: "Backend, preferences and language",
    detail:
      "Point the app at your own Cloudflare Worker, choose what happens when the window closes, and switch language.",
  },
}

export function ComingSoonView({ screen }: { screen: Screen }) {
  const planned = PLANNED[screen]
  if (planned === undefined) return null

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <h2 className="font-display text-[17px] tracking-tight text-text">{planned.headline}</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{planned.detail}</p>
        <p className="mt-4 font-mono text-[10.5px] text-muted">Arriving in Phase 4</p>
      </div>
    </div>
  )
}
