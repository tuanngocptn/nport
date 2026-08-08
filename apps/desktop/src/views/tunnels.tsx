import { TunnelCard } from "../components/tunnel-card"
import type { UiExchange } from "../ipc/exchanges"
import type { ServerLimits } from "../ipc/tunnels"
import { medianLatencyMs, requestsToday } from "../lib/exchange-state"
import type { TunnelRow } from "../lib/tunnel-state"

/**
 * The Tunnels screen, transcribed from `docs/mockup/handoff/desktop/index.html`.
 *
 * As drawn: the tunnel list, a "Start another tunnel" slot button below it, and a three-cell stat
 * grid — Requests today, Median latency, Edge region.
 *
 * All three stats are real. Requests and latency come from the inspector's captures, and Edge
 * region from the colo the connections landed on. Each still reads `—` rather than `0` until there
 * is something to count: a zero is a claim that no traffic arrived, which is a different statement
 * from "nothing measured yet".
 */
export function TunnelsView({
  tunnels,
  error,
  limits,
  exchanges,
  onStop,
  onNew,
  onInspect,
}: {
  tunnels: TunnelRow[]
  error: string | null
  limits: ServerLimits | null
  exchanges: UiExchange[]
  onStop: (subdomain: string) => void
  onNew: () => void
  onInspect: () => void
}) {
  const free = limits === null ? null : Math.max(0, limits.maxConcurrentPerSource - tunnels.length)
  const regions = [...new Set(tunnels.map((row) => row.colo).filter((colo) => colo !== null))]
  const today = requestsToday(exchanges, Date.now())
  const median = medianLatencyMs(exchanges)

  return (
    <div className="flex flex-col gap-4 p-6">
      {error !== null && (
        <p className="rounded-md border border-hair bg-card p-3 font-mono text-xs text-red">
          {error}
        </p>
      )}

      {tunnels.length > 0 && (
        <div className="flex flex-col gap-3">
          {tunnels.map((tunnel) => (
            <TunnelCard
              key={tunnel.subdomain}
              tunnel={tunnel}
              leaseMs={limits?.tunnelDurationMs ?? null}
              onStop={onStop}
              onInspect={onInspect}
            />
          ))}
        </div>
      )}

      {(free === null || free > 0) && (
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-lg border border-hair border-dashed bg-card/40 py-7 transition-colors duration-200 ease-np hover:bg-card"
          onClick={onNew}
        >
          <span className="text-[13px] text-text">
            {tunnels.length === 0 ? "Start your first tunnel" : "Start another tunnel"}
          </span>
          <span className="font-mono text-[10.5px] text-muted">
            {free === null || limits === null
              ? "port, name, go"
              : `${free} of ${limits.maxConcurrentPerSource} ${free === 1 ? "slot" : "slots"} remaining`}
          </span>
        </button>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Requests today"
          value={today === 0 ? "—" : today.toLocaleString()}
          title="Captured through this app's tunnels since midnight"
        />
        <Stat
          label="Median latency"
          value={median === null ? "—" : `${median} ms`}
          title="The typical round trip, including your server's own time"
        />
        <Stat
          label="Edge region"
          value={regions.length === 0 ? "—" : regions.join(" · ")}
          title="The Cloudflare colo your connections landed on"
        />
      </div>
    </div>
  )
}

function Stat({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hair bg-card p-3" title={title}>
      <span className="text-[10.5px] text-muted">{label}</span>
      <span className="font-mono text-[15px] text-text">{value}</span>
    </div>
  )
}
