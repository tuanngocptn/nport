import { TunnelCard } from "../components/tunnel-card"
import { liveCount, type TunnelRow } from "../lib/tunnel-state"

/**
 * The Tunnels screen — the first of the five in `docs/mockup/README.md`.
 *
 * Presentational: the subscription is `useTunnels`, the reducing is `lib/tunnel-state.ts`, and both
 * live outside this file so the state can be tested without a renderer.
 */
export function TunnelsView({
  tunnels,
  error,
  onStop,
  onNew,
}: {
  tunnels: TunnelRow[]
  error: string | null
  onStop: (subdomain: string) => void
  onNew: () => void
}) {
  const live = liveCount(tunnels)

  return (
    <section className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-text">Tunnels</h1>
          <p className="mt-1 text-sm text-muted">The server closes each one when its lease ends</p>
        </div>
        <span className="flex items-center gap-2 rounded-pill border border-hair bg-chip px-3 py-1.5">
          <i
            className={`size-1.5 rounded-pill ${live > 0 ? "bg-green shadow-green" : "bg-idle"}`}
          />
          <span className="font-mono text-[11px] text-muted">{live} live</span>
        </span>
      </header>

      {error !== null && (
        <p className="rounded-md border border-hair bg-card p-3 font-mono text-xs text-red">
          {error}
        </p>
      )}

      {tunnels.length === 0 ? (
        <EmptyState onNew={onNew} />
      ) : (
        <div className="flex flex-col gap-3">
          {tunnels.map((tunnel) => (
            <TunnelCard key={tunnel.subdomain} tunnel={tunnel} onStop={onStop} />
          ))}
        </div>
      )}
    </section>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-lg border border-hair border-dashed bg-card/40">
      <div className="max-w-xs text-center">
        <p className="text-sm text-text">No tunnels running.</p>
        <button
          type="button"
          className="mt-3 rounded-md bg-green px-4 py-2 text-sm font-medium text-page shadow-green"
          onClick={onNew}
        >
          Start one
        </button>
      </div>
    </div>
  )
}
