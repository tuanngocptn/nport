import { JsonLd } from "../components/json-ld"
import { Compare } from "../components/sections/compare"
import { Download } from "../components/sections/download"
import { Faq } from "../components/sections/faq"
import { Features } from "../components/sections/features"
import { Footer } from "../components/sections/footer"
import { Hero } from "../components/sections/hero"
import { HowItWorks } from "../components/sections/how-it-works"
import { Navbar } from "../components/sections/navbar"
import { PoweredBy } from "../components/sections/powered-by"
import { homeJsonLd, pageMetadata, SITE_DESCRIPTION } from "../lib/seo"

export const metadata = pageMetadata({
  path: "/",
  // v2's title, whose shape is the reason it ranked: the brand, then the query people actually type.
  title: "NPort — free ngrok alternative for tunnelling localhost",
  description: SITE_DESCRIPTION,
})

/**
 * The marketing page. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * **The section order is fixed** and carried from v2 because it converts (`apps/web/CLAUDE.md` rule 1):
 * navbar → hero → how-it-works → features → powered-by → CTA → footer. `#compare` is the mockup's sixth
 * section, which that order has no slot for; it sits between features and download, which is where the
 * design puts it and where a comparison does the most work — see `sections/compare.tsx`.
 *
 * `#faq` is the eighth section and is **not** in the mockup: rule 3 requires a `FAQPage` JSON-LD block,
 * and that block is only valid if the questions are visible on the page carrying it. It is appended
 * after the CTA rather than inserted into the sequence — `sections/faq.tsx` carries the reasoning.
 *
 * Every section is a server component. Nothing here needs `"use client"`: the only interactivity is
 * anchor links, the native `<details>` in the FAQ, and the theme script in `layout.tsx`.
 *
 * The four JSON-LD blocks are emitted here rather than from `layout.tsx` because three of the four
 * describe *this* page's content — `HowTo` points at `#how` and `FAQPage` at the section below.
 *
 * **What this page does not yet have**, all of it Phase 2c and none of it blocking the above: an
 * OpenGraph image, the MDX docs, and the Playwright tier that would assert any of it visually.
 */
export default function Home() {
  return (
    <>
      <JsonLd blocks={homeJsonLd()} />
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <PoweredBy />
        <Compare />
        <Download />
        <Faq />
      </main>
      <Footer />
    </>
  )
}
