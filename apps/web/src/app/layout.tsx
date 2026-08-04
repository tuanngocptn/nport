import type { Metadata } from "next"
import type { ReactNode } from "react"

import "./globals.css"

export const metadata: Metadata = {
  title: "NPort",
  description: "Tunnel localhost to a public URL over Cloudflare's edge. No account, no config.",
}

/**
 * Sets `data-theme` before first paint.
 *
 * Inline and synchronous on purpose: anything deferred runs *after* the browser has painted, so the
 * page flashes dark then corrects itself — the one FOUC a user actually notices
 * (`apps/web/CLAUDE.md` § Gotchas). It reads the same `nport-theme` key the desktop app uses and
 * falls through to the OS preference, and it is wrapped in try/catch because `localStorage` throws
 * outright in a Safari private window rather than returning null.
 */
const THEME_SCRIPT = `try{
  var t = localStorage.getItem("nport-theme");
  if (t !== "dark" && t !== "light") {
    t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", t);
}catch(e){}`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline, and therefore `dangerouslySetInnerHTML`: the script must run before first paint,
            which rules out every deferred option. The content is the string constant above — no
            user input reaches it, so there is nothing here to inject. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
