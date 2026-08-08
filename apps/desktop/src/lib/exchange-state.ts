import type { UiExchange } from "../ipc/exchanges"

/**
 * The inspector's list, as a pure function of what has been captured.
 *
 * `docs/FEATURES.md` §5. In `lib/` so the filtering and the bound are tested without a renderer —
 * the same arrangement as `tunnel-state.ts`.
 */

/**
 * How many exchanges the window keeps.
 *
 * **Matches `core::inspector`'s `DEFAULT_CAPACITY`.** The ring in Rust is already the thing that
 * bounds memory; this bounds the *renderer*, which has its own reason to care — TanStack Virtual
 * handles a thousand rows, and an unbounded array behind it grows for as long as the app is open.
 * Keeping the two numbers equal means the screen shows what the ring holds rather than a different
 * window onto it.
 */
export const KEEP = 1000

/** The mockup's four filters. */
export const FILTERS = ["All", "API", "Errors", "Mutations"] as const
export type Filter = (typeof FILTERS)[number]

/**
 * Adds one exchange, newest first, bounded.
 *
 * Newest first because that is the order the mockup's list reads and the order somebody debugging
 * wants: the request they just made is the one they are looking for.
 */
export function addExchange(exchanges: UiExchange[], next: UiExchange): UiExchange[] {
  return [next, ...exchanges].slice(0, KEEP)
}

/**
 * The mockup's filters, as predicates.
 *
 * *API* is a path prefix, *Errors* is a status class, and *Mutations* is anything that is not a
 * `GET` — which is what the mockup's own demo does, and the useful reading: `HEAD` and `OPTIONS` are
 * rare enough in a tunnel that grouping them with writes costs nothing, while excluding `DELETE`
 * from "mutations" would be surprising.
 */
export function matches(exchange: UiExchange, filter: Filter): boolean {
  switch (filter) {
    case "All":
      return true
    case "API":
      return path(exchange.url).startsWith("/api")
    case "Errors":
      // A failed exchange has no status at all — it never reached the origin — and belongs here
      // more than anything with one does.
      return exchange.failure !== null || (exchange.status ?? 0) >= 400
    case "Mutations":
      return exchange.method.toUpperCase() !== "GET"
  }
}

export function filterExchanges(exchanges: UiExchange[], filter: Filter): UiExchange[] {
  return exchanges.filter((exchange) => matches(exchange, filter))
}

/**
 * The path of a captured URL, for display and for the API filter.
 *
 * **Falls back to the raw string rather than throwing.** `Exchange::url` is "the full URL the edge
 * asked for", and an origin can send something `URL` will not parse; a list that crashed on one odd
 * request would lose the other 999.
 */
export function path(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    // Not a URL. If it looks like a bare path, it already is one.
    return url.startsWith("/") ? url : url
  }
}

/** Requests seen since midnight — the Tunnels screen's "Requests today". */
export function requestsToday(exchanges: UiExchange[], now: number): number {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return exchanges.filter((exchange) => exchange.at >= midnight.getTime()).length
}

/**
 * The median round trip — the Tunnels screen's "Median latency".
 *
 * Median rather than mean, as the mockup labels it: one slow request skews a mean and the stat is
 * there to describe the typical one. `null` for an empty list, because a zero would read as "very
 * fast" rather than "nothing measured".
 */
export function medianLatencyMs(exchanges: UiExchange[]): number | null {
  if (exchanges.length === 0) return null

  const sorted = exchanges.map((exchange) => exchange.durationMs).sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? null)
}
