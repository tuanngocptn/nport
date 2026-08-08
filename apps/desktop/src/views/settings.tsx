import { useEffect, useState } from "react"

import { readSettings, type Settings, writeSettings } from "../ipc/settings"

/**
 * Settings, transcribed from `docs/mockup/handoff/desktop/index.html`.
 *
 * As drawn: a Backend field, a Preferences list of four switches, a Support block, and a Language
 * segmented control.
 *
 * **`docs/FEATURES.md` §10 adjudicates four disagreements between the design and the product**, and
 * the doc wins each time — `docs/mockup/README.md` rule 4 says the design is not the authority on
 * behaviour:
 *
 * - The hint says the file is `~/.nport/config.json`. **It is `config.toml`** — the CLI's format,
 *   and now literally the same file (ADR-0051).
 * - The language switch offers two. **The CLI ships three** (`en`, `vi`, `es`), and shipping two
 *   here would be a regression against a product that already speaks the third.
 * - *Anonymous analytics*, "equivalent to `NPORT_ANALYTICS` in the CLI". **There is no such thing.**
 *   ADR-0015 and rule 5 forbid telemetry in this app, and no CLI env var by that name exists. A
 *   switch is not drawn for something that must never be built.
 * - The three remaining preferences — launch at login, keep the menu bar icon, notify before
 *   cleanup — are **§9's**, and belong to the tray and the updater. They are drawn inert here rather
 *   than deleted, because the design is the authority on what is on the screen.
 */
export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    readSettings()
      .then(setSettings)
      .catch((cause: unknown) => setError(String(cause)))
  }, [])

  async function save(next: Settings) {
    setSettings(next)
    setError(null)
    try {
      await writeSettings(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 1400)
    } catch (cause: unknown) {
      setError(errorText(cause))
    }
  }

  if (settings === null) {
    return <p className="p-6 text-[12px] text-muted">{error ?? "Reading your settings…"}</p>
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <section className="flex flex-col gap-2">
        <label className="text-[10.5px] uppercase tracking-wide text-muted" htmlFor="backend">
          Backend
        </label>
        <input
          id="backend"
          type="url"
          placeholder="https://api.nport.link"
          className="rounded-md border border-hair bg-field px-3 py-2 font-mono text-[12.5px] text-text placeholder:text-muted"
          value={settings.backend ?? ""}
          onChange={(event) => setSettings({ ...settings, backend: event.target.value || null })}
          onBlur={() => void save(settings)}
        />
        <p className="text-[11.5px] leading-relaxed text-muted">
          Point this at your own Cloudflare Worker to run every tunnel on infrastructure you
          control. Saved to <code className="font-mono text-text">~/.nport/config.toml</code>, the
          same file the <code className="font-mono text-text">nport</code> command reads.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-[10.5px] uppercase tracking-wide text-muted">Preferences</span>
        <div className="flex flex-col gap-1.5">
          <Preference
            title="Launch at login"
            description="Start NPort in the menu bar when you log in."
            unavailable="Arrives with the menu bar"
          />
          <Preference
            title="Keep the menu bar icon"
            description="Close the window without stopping tunnels."
            unavailable="Arrives with the menu bar"
          />
          <Preference
            title="Notify before auto-cleanup"
            description="Warn before the lease ends."
            unavailable="Arrives with notifications"
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          The design also draws an anonymous-analytics switch. There is none, and there will not be:
          this app sends nothing anywhere (ADR-0015).
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-[10.5px] uppercase tracking-wide text-muted">Language</span>
        <div className="flex w-fit rounded-md bg-seg p-0.5">
          {LANGUAGES.map((language) => {
            const active = (settings.lang ?? "en") === language.code
            return (
              <button
                key={language.code}
                type="button"
                aria-pressed={active}
                className={`rounded-[5px] px-3 py-1 text-[11.5px] transition-colors duration-200 ease-np ${
                  active ? "bg-chip text-text" : "text-muted hover:text-text"
                }`}
                onClick={() => void save({ ...settings, lang: language.code })}
              >
                {language.label}
              </button>
            )
          })}
        </div>
        <p className="text-[11.5px] text-muted">
          Three, not two: the <code className="font-mono text-text">nport</code> command already
          speaks all three, and the window offering fewer would be a step back. The window itself is
          not translated yet — this sets the CLI's default.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-[10.5px] uppercase tracking-wide text-muted">Support</span>
        <div className="flex flex-col gap-2 rounded-lg border border-hair bg-card p-4">
          <span className="text-[12.5px] text-text">NPort is free and open source</span>
          <span className="text-[11.5px] leading-relaxed text-muted">
            Maintained by one developer, paid for out of pocket. A coffee keeps it going.
          </span>
          <div className="mt-1 flex items-center gap-2">
            <a
              className="rounded-md border border-hair bg-chip px-3 py-1.5 text-[11.5px] text-text transition-colors duration-200 ease-np hover:bg-rim"
              href="https://buymeacoffee.com/tuanngocptn"
              target="_blank"
              rel="noopener noreferrer"
            >
              Buy me a coffee
            </a>
            <a
              className="rounded-md border border-hair bg-chip px-3 py-1.5 text-[11.5px] text-muted transition-colors duration-200 ease-np hover:text-text"
              href="https://github.com/tuanngocptn/nport"
              target="_blank"
              rel="noopener noreferrer"
            >
              ★ Star on GitHub
            </a>
          </div>
        </div>
      </section>

      <p className="h-4 text-[11.5px] text-muted">
        {error !== null ? <span className="text-red">{error}</span> : saved ? "Saved" : ""}
      </p>
    </div>
  )
}

/** The three the CLI ships. `docs/FEATURES.md` §10: two here would be a regression. */
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "es", label: "Español" },
] as const

function Preference({
  title,
  description,
  unavailable,
}: {
  title: string
  description: string
  unavailable: string
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-md border border-hair bg-card px-3 py-2.5 opacity-45"
      title={unavailable}
    >
      <span className="flex-1">
        <span className="block text-[12.5px] text-text">{title}</span>
        <span className="block text-[11px] text-muted">{unavailable}</span>
      </span>
      <span
        aria-hidden="true"
        className="flex h-[18px] w-[30px] shrink-0 items-center rounded-pill bg-idle p-0.5"
      >
        <i className="size-[14px] rounded-pill bg-text shadow-knob" />
      </span>
      <span className="sr-only">{description}</span>
    </div>
  )
}

function errorText(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return String((cause as { code: unknown }).code)
  }
  return String(cause)
}
