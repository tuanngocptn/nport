import { Compare } from "../components/sections/compare"
import { Download } from "../components/sections/download"
import { Features } from "../components/sections/features"
import { Footer } from "../components/sections/footer"
import { Hero } from "../components/sections/hero"
import { HowItWorks } from "../components/sections/how-it-works"
import { Navbar } from "../components/sections/navbar"
import { PoweredBy } from "../components/sections/powered-by"

/**
 * The marketing page. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * **The section order is fixed** and carried from v2 because it converts (`apps/web/CLAUDE.md` rule 1):
 * navbar → hero → how-it-works → features → powered-by → CTA → footer. `#compare` is the mockup's sixth
 * section, which that order has no slot for; it sits between features and download, which is where the
 * design puts it and where a comparison does the most work — see `sections/compare.tsx`.
 *
 * Every section is a server component. Nothing here needs `"use client"`: the only interactivity is
 * anchor links and the theme script in `layout.tsx`, which runs before first paint.
 *
 * **What this page does not yet have**, all of it Phase 2c and none of it blocking the above: the four
 * JSON-LD blocks (rule 2, `src/lib/seo.ts`), `sitemap.ts` and `robots.ts`, an OpenGraph image, the MDX
 * docs, and the Playwright tier that would assert any of it visually.
 */
export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <PoweredBy />
        <Compare />
        <Download />
      </main>
      <Footer />
    </>
  )
}
