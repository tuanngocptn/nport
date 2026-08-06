import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ERROR_CODES, errorSlug } from "@nport/contract"
import { describe, expect, it } from "vitest"

import { DOC_PAGES, docHref } from "./docs"

/**
 * Every internal link in the MDX docs resolves to a route this app serves.
 *
 * The docs link error codes by slug — `/errors/local-request-failed` and eight others — and a slug with a
 * typo is a 404 handed to somebody who is already debugging. That is defect 37 with the arrow reversed:
 * there, 33 real pages were unreachable; here, the risk is a link to a page that was never real.
 *
 * `cargo xtask verify-docs` checks relative links in `docs/`, but these are absolute site routes in MDX,
 * which it does not read. This is the same guarantee for the other half of the documentation.
 */

const DOCS_DIR = join(import.meta.dirname, "docs")

/** Markdown links only: `](/path)`. An external `https://` link has no leading slash to match. */
const INTERNAL_LINK = /\]\((\/[^)\s]*)\)/g

interface Link {
  readonly file: string
  readonly href: string
}

function internalLinks(): Link[] {
  const links: Link[] = []
  for (const file of readdirSync(DOCS_DIR).filter((entry) => entry.endsWith(".mdx"))) {
    const body = readFileSync(join(DOCS_DIR, file), "utf8")
    for (const match of body.matchAll(INTERNAL_LINK)) {
      links.push({ file, href: match[1] ?? "" })
    }
  }
  return links
}

/** Every path the app serves that a doc could reasonably link to. */
function servedRoutes(): Set<string> {
  return new Set([
    "/",
    "/errors",
    ...ERROR_CODES.map((code) => `/errors/${errorSlug(code)}`),
    ...DOC_PAGES.map((page) => docHref(page.slug)),
  ])
}

describe("the docs' internal links", () => {
  it("all resolve to a served route", () => {
    const routes = servedRoutes()
    const broken = internalLinks()
      .filter((link) => !routes.has(link.href))
      .map((link) => `${link.file} → ${link.href}`)

    expect(broken, `${broken.length} broken internal link(s)`).toEqual([])
  })

  it("are actually being checked", () => {
    // A regex that stopped matching would make the test above pass on any input. The docs link plenty, so
    // finding nothing means the scanner broke rather than that the docs are clean.
    expect(internalLinks().length).toBeGreaterThan(5)
  })

  it("include at least one error page, since that is the link most likely to rot", () => {
    const errorLinks = internalLinks().filter((link) => link.href.startsWith("/errors/"))
    expect(errorLinks.length).toBeGreaterThan(0)
  })
})
