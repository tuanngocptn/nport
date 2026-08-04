import { useEffect, useState } from "react"

import { greet } from "./ipc/health"

/**
 * The development window.
 *
 * **This is not the app.** The real one is Phase 4, built from `docs/mockup/NPort Desktop.dc.html`:
 * a sidebar over five screens, a first-run overlay, and a menu-bar popover. What this proves is that
 * the scaffold works — React mounts in the WebView, the design tokens resolve, and an IPC call
 * reaches Rust and comes back.
 *
 * The IPC round-trip is the part worth having early. It is the boundary that generates
 * `src/generated/bindings.ts` in Phase 4, and the one most likely to be misconfigured: a command
 * missing from `capabilities/default.json` is denied at runtime with a message that does not say so
 * (`apps/desktop/CLAUDE.md` rule 4).
 */
export function App() {
  const [backend, setBackend] = useState<string>("…")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    greet()
      .then(setBackend)
      .catch((cause: unknown) => setError(String(cause)))
  }, [])

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-window border border-hair bg-window p-8 shadow-window backdrop-blur-3xl">
        <div className="flex items-center gap-3">
          <span className="size-2.5 rounded-pill bg-green shadow-green" />
          <span className="font-mono text-sm text-green">nport · desktop</span>
        </div>

        <h1 className="font-display text-3xl tracking-tight text-text">The window is up.</h1>

        <p className="text-sm leading-relaxed text-muted">
          Scaffold only — the app is Phase 4. This window exists so{" "}
          <code className="font-mono text-text">pnpm dev</code> brings every surface up together.
        </p>

        <div className="rounded-md bg-field p-4 font-mono text-xs">
          {error ? (
            <span className="text-red">IPC failed: {error}</span>
          ) : (
            <span className="text-muted">rust says: {backend}</span>
          )}
        </div>
      </div>
    </div>
  )
}
