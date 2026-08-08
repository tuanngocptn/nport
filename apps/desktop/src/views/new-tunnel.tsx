import { useState } from "react"

import { startTunnel } from "../ipc/tunnels"
import {
  canStart,
  checkPort,
  checkRequestedSubdomain,
  equivalentCommand,
  type NewTunnelForm,
} from "../lib/new-tunnel"

/**
 * The New tunnel screen, from `docs/mockup/handoff/desktop/index.html`.
 *
 * The mockup's form is: a port field with quick-pick chips, a subdomain field with an availability
 * hint, three option toggles, Start and Cancel, and an *Equivalent command* panel beside it.
 *
 * **Three of those are not built, and each for its own reason.**
 *
 * *Require basic auth* is in `docs/ROADMAP.md` § Deferred — "tunnel password protection", explicitly
 * out of scope for 3.0 and needing its own ADR. A toggle for it would promise a feature the server
 * cannot honour.
 *
 * *Open inspector on start* would navigate to a screen that does not exist yet; it lands with the
 * inspector.
 *
 * The *availability* hint is the interesting one: the mockup says "northloop.nport.link is
 * available", and **nothing in the contract can answer that**. There is no availability endpoint,
 * and inventing one would be a free subdomain-enumeration oracle on an account-free service. So the
 * hint says what can be known for certain without asking anyone — whether the name is *valid* — and
 * the server remains the only thing that can say whether it is free.
 *
 * The mockup's static `.nport.link` suffix is left off for a related reason: this app talks to
 * whichever backend it is pointed at, and a self-hoster's zone is not ours to print.
 *
 * `onDone` fires on both Start and Cancel, and is named for that. It was `onStarted`, which was a
 * lie on the Cancel path — the sort a later reader believes when hanging a toast or an analytics
 * call off it.
 */

const QUICK_PORTS = ["3000", "5173", "8080", "4000"] as const

/** Why a name was refused, in words. Codes come from `packages/contract`. */
const REJECTION: Record<string, string> = {
  empty: "Enter a name, or leave it blank for a generated one",
  "too-short": "Too short — at least 3 characters",
  "too-long": "Too long — at most 63 characters",
  "invalid-characters": "Letters, numbers and hyphens only",
  "leading-or-trailing-hyphen": "Cannot start or end with a hyphen",
  "double-hyphen-prefix": "Cannot start with two hyphens in the third and fourth position",
  reserved: "That name is reserved",
  "reserved-prefix": "That prefix is reserved",
}

export function NewTunnelView({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<NewTunnelForm>({ port: "3000", subdomain: "" })
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const port = checkPort(form.port)
  const subdomain = checkRequestedSubdomain(form.subdomain)
  const ready = canStart(form) && !starting

  async function start() {
    if (!port.ok) return
    setStarting(true)
    setError(null)
    try {
      await startTunnel({
        localPort: port.port,
        // Sent **raw**. The server normalizes and owns the lease key; normalizing here would put a
        // second authority on the path (defect 36).
        subdomain: form.subdomain.trim() === "" ? undefined : form.subdomain.trim(),
      })
      onDone()
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="flex h-full gap-6 p-6">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <header>
          <h1 className="font-display text-2xl tracking-tight text-text">New tunnel</h1>
          <p className="mt-1 text-sm text-muted">Port, name, go</p>
        </header>

        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted" htmlFor="port">
            Local port
          </label>
          <div className="flex items-center gap-2">
            <input
              id="port"
              type="text"
              inputMode="numeric"
              className="w-24 rounded-md border border-hair bg-field px-3 py-2 font-mono text-sm text-text"
              value={form.port}
              onChange={(event) => setForm({ ...form, port: event.target.value })}
            />
            {QUICK_PORTS.map((quick) => (
              <button
                key={quick}
                type="button"
                className="rounded-pill border border-hair bg-chip px-2.5 py-1 font-mono text-[11px] text-muted transition-colors duration-200 ease-np hover:text-text"
                onClick={() => setForm({ ...form, port: quick })}
              >
                :{quick}
              </button>
            ))}
          </div>
          {!port.ok && form.port.trim() !== "" && (
            <p className="text-xs text-red">
              {port.reason === "out-of-range" ? "Ports run from 1 to 65535" : "Not a port number"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted" htmlFor="subdomain">
            Public subdomain
          </label>
          <input
            id="subdomain"
            type="text"
            placeholder="auto-generated"
            className="rounded-md border border-hair bg-field px-3 py-2 font-mono text-sm text-text placeholder:text-muted"
            value={form.subdomain}
            onChange={(event) => setForm({ ...form, subdomain: event.target.value })}
          />
          <p className="text-xs text-muted">
            {subdomain.state === "generated" && "A name will be generated for you"}
            {subdomain.state === "ok" && (
              <>
                Will be claimed as{" "}
                <span className="font-mono text-text">{subdomain.subdomain}</span>
                {" — the server decides if it is free"}
              </>
            )}
            {subdomain.state === "rejected" && (
              <span className="text-red">{REJECTION[subdomain.reason] ?? "Not a valid name"}</span>
            )}
          </p>
        </div>

        {error !== null && (
          <p className="rounded-md border border-hair bg-card p-3 font-mono text-xs text-red">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-green px-4 py-2 text-sm font-medium text-page shadow-green transition-opacity duration-200 ease-np disabled:opacity-40"
            disabled={!ready}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : "Start tunnel"}
          </button>
          <button
            type="button"
            className="rounded-md border border-hair bg-chip px-4 py-2 text-sm text-text transition-colors duration-200 ease-np hover:bg-rim"
            onClick={onDone}
          >
            Cancel
          </button>
        </div>
      </div>

      <aside className="w-72 shrink-0 rounded-lg border border-hair bg-card p-4">
        <span className="text-[10.5px] uppercase tracking-wide text-muted">Equivalent command</span>
        <pre className="mt-2 overflow-x-auto rounded-md bg-field p-3 font-mono text-[11px] text-text">
          <span className="text-muted">$ </span>
          {equivalentCommand(form)}
        </pre>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Every control maps to a CLI flag. Copy this into CI, a Makefile, or a teammate's terminal.
        </p>
      </aside>
    </section>
  )
}

/**
 * A `CommandError` from Rust, or whatever else was thrown.
 *
 * The code is shown rather than translated, because the app has no catalogue yet — and a code is
 * still actionable: it is the same string as `nport.link/errors/<slug>`. Translating it is the
 * WebView's job when the catalogue lands, exactly as it is `crates/cli`'s for the terminal.
 */
function errorText(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return String((cause as { code: unknown }).code)
  }
  return String(cause)
}
