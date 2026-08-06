import { ImageResponse } from "next/og"

import { HERO } from "../content/site"
import { OG_GREEN, OG_PAGE, OG_TEXT } from "../lib/og-colours"

/**
 * `/opengraph-image` — the card every link to this site unfurls into.
 *
 * **Generated at build time, not per request.** The segment is static, so Next renders the PNG during the
 * build and the Worker serves 19 KB of bytes rather than running Satori on a request. Verified through the
 * built Worker rather than assumed: a valid 1200×630 PNG, and Next injects `og:image` into every page's
 * metadata from the file convention alone.
 *
 * **The words come from `src/content/site.ts`**, the same `HERO` the page renders. A social card is read
 * by more people than the page it links to and is checked by almost nobody, which puts it in the same
 * category as the JSON-LD blocks: derive it, or it eventually advertises something the product stopped
 * doing. The colours are copied rather than derived — Satori has no CSS pipeline — and
 * `src/lib/og-colours.test.ts` is what keeps the copy honest.
 *
 * Deliberately no logo: `docs/mockup/assets` holds one, but nothing in this app serves an image yet and a
 * card is not the place to introduce the first asset pipeline. Type on a dark field is what the mockup's
 * own aesthetic mostly is anyway.
 */

export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 80px",
        background: OG_PAGE,
        // Satori supports a single radial gradient here; the mockup's four-bloom wallpaper does not
        // survive the trip, so this is one green bloom in the corner the accent lives in.
        backgroundImage: `radial-gradient(70% 60% at 12% 8%, rgba(48, 209, 88, 0.22), transparent 70%)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {/* A dot rather than a mark. It is the "live" green the CLI prints and the site accents with. */}
        <div style={{ width: 20, height: 20, borderRadius: 999, background: OG_GREEN }} />
        <div style={{ fontSize: 32, color: OG_TEXT, letterSpacing: -0.5 }}>nport.link</div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 40,
          fontSize: 68,
          lineHeight: 1.1,
          letterSpacing: -2,
          color: OG_TEXT,
        }}
      >
        {/* One row per line, because the page breaks the headline in the same place. */}
        {HERO.headline.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          // Sized to its text, not to the card. A flex column stretches its children by default, which
          // made the box span all 1040px of content width and read as an empty bar with a word in it.
          alignSelf: "flex-start",
          marginTop: 48,
          padding: "16px 28px",
          borderRadius: 14,
          border: "1px solid rgba(255, 255, 255, 0.11)",
          background: "rgba(255, 255, 255, 0.07)",
          fontSize: 30,
          color: OG_TEXT,
        }}
      >
        <span style={{ color: OG_GREEN, marginRight: 12 }}>$</span>
        {HERO.command}
      </div>
    </div>,
    size,
  )
}
