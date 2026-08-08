import { useState } from "react"

import type { UiExchange } from "../ipc/exchanges"
import { FILTERS, type Filter, filterExchanges, path } from "../lib/exchange-state"

/**
 * The Inspector, transcribed from `docs/mockup/handoff/desktop/index.html`.
 *
 * As drawn: a segmented filter (All / API / Errors / Mutations), a Live toggle, the request list,
 * and a detail pane with a method tag, the path, Replay, a meta line and Request / Response / Timing
 * tabs over a key-value block and a body.
 *
 * **Replay is deferred** — `docs/FEATURES.md` §5 and `docs/ROADMAP.md` § Deferred both list it. The
 * button is drawn and inert with the reason on it, rather than deleted: the design is the authority
 * on what is there.
 *
 * **The list is not virtualized yet**, which `apps/desktop/CLAUDE.md` rule 11 requires before it
 * holds a thousand rows. TanStack Virtual is a dependency this app does not have, and adding it
 * blind — with no window to check the scroll in — is how a virtualizer ships subtly wrong. The
 * ceiling is a thousand and the rule is written down; it lands with the first run in a real window.
 */
export function InspectorView({
  exchanges,
  live,
  onToggleLive,
}: {
  exchanges: UiExchange[]
  live: boolean
  onToggleLive: () => void
}) {
  const [filter, setFilter] = useState<Filter>("All")
  const [selected, setSelected] = useState<number | null>(null)

  const shown = filterExchanges(exchanges, filter)
  const current = shown.find((row) => row.id === selected) ?? shown[0] ?? null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-hair border-b px-6 py-3">
        {/* Native radios rather than buttons with `role="radio"`, which is what the mockup's markup
            uses. The role is correct ARIA, but real inputs get arrow-key navigation and grouping
            from the platform instead of from us — and a segmented control is exactly a radio group.
            The input is visually hidden; the label is the segment. */}
        <fieldset className="flex rounded-md bg-seg p-0.5">
          <legend className="sr-only">Filter</legend>
          {FILTERS.map((option) => (
            <label
              key={option}
              className={`cursor-pointer rounded-[5px] px-3 py-1 text-[11.5px] transition-colors duration-200 ease-np has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-green ${
                filter === option ? "bg-chip text-text" : "text-muted hover:text-text"
              }`}
            >
              <input
                type="radio"
                name="inspector-filter"
                className="sr-only"
                checked={filter === option}
                onChange={() => setFilter(option)}
              />
              {option}
            </label>
          ))}
        </fieldset>

        <button
          type="button"
          className="flex items-center gap-2 rounded-pill border border-hair bg-chip px-3 py-1.5 text-[11.5px] text-text transition-colors duration-200 ease-np hover:bg-rim"
          onClick={onToggleLive}
        >
          <i
            aria-hidden="true"
            className={`size-1.5 rounded-pill ${live ? "bg-green shadow-green" : "bg-idle"}`}
          />
          {live ? "Live" : "Paused"}
        </button>
      </div>

      {exchanges.length === 0 ? (
        <Empty />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ol className="w-[46%] min-w-0 overflow-y-auto border-hair border-r">
            {shown.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={current?.id === row.id ? "true" : undefined}
                  className={`flex w-full items-center gap-2.5 border-hair border-b px-4 py-2 text-left transition-colors duration-200 ease-np ${
                    current?.id === row.id ? "bg-chip" : "hover:bg-card"
                  }`}
                  onClick={() => setSelected(row.id)}
                >
                  <MethodTag method={row.method} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text">
                    {path(row.url)}
                  </span>
                  <Status exchange={row} />
                  <span className="shrink-0 font-mono text-[10.5px] text-muted">
                    {row.durationMs} ms
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-4 py-6 text-center text-[12px] text-muted">
                Nothing matches {filter}.
              </li>
            )}
          </ol>

          {current !== null && <Detail exchange={current} />}
        </div>
      )}
    </div>
  )
}

function Empty() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-xs text-center">
        <p className="text-[13px] text-text">No traffic captured yet.</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          Every request through a running tunnel appears here — method, path, status and timing,
          with headers and bodies beside them.
        </p>
      </div>
    </div>
  )
}

/** Method colours follow the mockup: writes stand out, reads do not. */
function MethodTag({ method }: { method: string }) {
  const upper = method.toUpperCase()
  const tone =
    upper === "GET"
      ? "text-muted"
      : upper === "DELETE"
        ? "text-red"
        : upper === "POST"
          ? "text-green"
          : "text-orange"

  return (
    <span className={`w-11 shrink-0 font-mono text-[10px] tracking-wide ${tone}`}>{upper}</span>
  )
}

/**
 * The status, or the failure that means there is none.
 *
 * A failed exchange never reached the origin — showing a blank where a status goes would read as
 * "still running", so it says what happened instead.
 */
function Status({ exchange }: { exchange: UiExchange }) {
  if (exchange.status === null) {
    return <span className="shrink-0 font-mono text-[10.5px] text-red">failed</span>
  }

  const tone =
    exchange.status >= 500 ? "text-red" : exchange.status >= 400 ? "text-orange" : "text-green"

  return <span className={`shrink-0 font-mono text-[10.5px] ${tone}`}>{exchange.status}</span>
}

const TABS = ["Request", "Response", "Timing"] as const

function Detail({ exchange }: { exchange: UiExchange }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Request")

  const rows =
    tab === "Request"
      ? exchange.requestHeaders.map((header) => [header.name, header.value] as const)
      : tab === "Response"
        ? exchange.responseHeaders.map((header) => [header.name, header.value] as const)
        : timing(exchange)

  const body = tab === "Response" ? exchange.responseBody : exchange.requestBody

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-hair border-b p-4">
        <div className="flex items-center gap-2">
          <MethodTag method={exchange.method} />
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text">
            {path(exchange.url)}
          </span>
          <button
            type="button"
            disabled
            title="Deferred — docs/ROADMAP.md § Deferred"
            className="shrink-0 rounded-md border border-hair bg-chip px-2.5 py-1 text-[11px] text-muted opacity-45"
          >
            Replay
          </button>
        </div>
        <div className="font-mono text-[10.5px] text-muted">
          {new Date(exchange.at).toLocaleTimeString()} · {exchange.durationMs} ms ·{" "}
          {formatBytes(exchange.responseBody.total)}
          {exchange.failure !== null && ` · ${exchange.failure}`}
        </div>
        <div className="flex w-fit rounded-md bg-seg p-0.5" role="tablist">
          {TABS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={tab === option}
              className={`rounded-[5px] px-2.5 py-1 text-[11px] transition-colors duration-200 ease-np ${
                tab === option ? "bg-chip text-text" : "text-muted hover:text-text"
              }`}
              onClick={() => setTab(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <dl className="flex flex-col gap-1">
          {rows.map(([name, value]) => (
            <div key={name} className="flex gap-3 font-mono text-[11px]">
              <dt className="w-40 shrink-0 truncate text-muted">{name}</dt>
              <dd className="min-w-0 flex-1 break-all text-text">{value}</dd>
            </div>
          ))}
          {rows.length === 0 && <p className="font-mono text-[11px] text-muted">No headers.</p>}
        </dl>

        {tab !== "Timing" && body.total > 0 && (
          <pre className="mt-4 overflow-x-auto rounded-md bg-field p-3 font-mono text-[11px] text-text">
            {pretty(body.text)}
            {body.truncated && (
              <span className="text-muted">{`\n\n… truncated · ${formatBytes(body.total)} total`}</span>
            )}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * The Timing tab.
 *
 * The mockup breaks the round trip into five hops — edge → tunnel, tunnel → localhost, handler,
 * response → edge, region. **`Exchange` measures one number**: the whole exchange including the
 * origin's own time. The rest would each need their own instrument in `core`, and inventing a
 * plausible split of one measurement across five rows is the kind of chart that gets believed.
 */
function timing(exchange: UiExchange): (readonly [string, string])[] {
  return [
    ["total", `${exchange.durationMs} ms`],
    ["request body", formatBytes(exchange.requestBody.total)],
    ["response body", formatBytes(exchange.responseBody.total)],
    ["started", new Date(exchange.at).toLocaleString()],
  ]
}

/** JSON gets pretty-printed; anything else is shown as it arrived. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function formatBytes(total: number): string {
  if (total < 1024) return `${total} B`
  if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`
  return `${(total / (1024 * 1024)).toFixed(1)} MB`
}
