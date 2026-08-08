import { TunnelCard } from "../components/tunnel-card"
import type { ServerLimits } from "../ipc/tunnels"
import type { TunnelRow } from "../lib/tunnel-state"

/**
 * The Tunnels screen, transcribed from `docs/mockup/handoff/desktop/index.html`.
 *
 * As drawn: the tunnel list, a "Start another tunnel" slot button below it, and a three-cell stat
 * grid — Requests today, Median latency, Edge region.
 *
 * **Two of the three stats are the inspector's**, and it is not enabled yet. They render as `—`
 * rather than as zeroes: "0 requests" and "0 ms" are claims about traffic, and both are false while
 * nothing is counting. Edge region is real — it comes from the colo the connections landed on.
 */
export function TunnelsView({
  tunnels,
  error,
  limits,
  onStop,
  onNew,
  onInspect,
}: {
  tunnels: TunnelRow[]
  error: string | null
  limits: ServerLimits | null
  onStop: (subdomain: string) => void
  onNew: () => void
  onInspect: () => void
}) {
  const free = limits === null ? null : Math.max(0, limits.maxConcurrentPerSource - tunnels.length)
  const regions = [...new Set(tunnels.map((row) => row.colo).filter((colo) => colo !== null))]

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
            {free === null ? "port, name, go" : `${free} ${free === 1 ? "slot" : "slots"} free`}
          </span>
        </button>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Requests today" value="—" title="Arrives with the traffic inspector" />
        <Stat label="Median latency" value="—" title="Arrives with the traffic inspector" />
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
