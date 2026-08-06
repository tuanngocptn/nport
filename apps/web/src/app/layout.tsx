import type { Metadata } from "next"
import type { ReactNode } from "react"

import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_URL } from "../lib/seo"

import "./globals.css"

/**
 * Only what is true of every route. The JSON-LD is per-page and lives in `page.tsx`.
 *
 * `metadataBase` belongs here and nowhere else: it is what resolves each page's relative canonical and
 * OpenGraph URLs to absolute ones, and without it Next emits relative OG tags no crawler follows.
 *
 * **Deliberately no `alternates` and no `openGraph` here.** Next lets a page inherit whatever the layout
 * declared, so a `canonical: "/"` at this level would put `<link rel="canonical" href="https://nport.link/">`
 * on all 33 error pages and ask Google to drop every one of them — the pages every error message in the
 * product links to. Each page states its own through `pageMetadata()` instead, which is a function a test
 * can check rather than an inheritance rule someone has to remember.
 *
 * The `title` and `description` below are a fallback for a route that sets neither, not the home page's:
 * `page.tsx` states its own.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "NPort",
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: "NPort",
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
