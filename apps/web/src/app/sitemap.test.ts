import { ERROR_CODES } from "@nport/contract"
import { describe, expect, it } from "vitest"

import { everySlug } from "../lib/error-codes"
import { SITE_URL } from "../lib/seo"
import robots from "./robots"
import sitemap from "./sitemap"

/**
 * The sitemap and `robots.txt`, tested directly.
 *
 * Both are plain `.ts` route handlers rather than components, so a test can import and call them — which
 * is the whole reason the error slugs are read from `src/lib/error-codes.ts` instead of being listed
 * here. The property that matters is coverage: `/errors/<slug>` pages have **no inbound link anywhere on
 * the site**, because the only thing that links to them is an error message in somebody's terminal. If
 * the sitemap misses them, they are never crawled at all.
 */

describe("the sitemap", () => {
  it("lists the home page, the error index, and every error code", () => {
    const urls = sitemap().map((entry) => entry.url)

    expect(urls).toContain(`${SITE_URL}/`)
    expect(urls).toContain(`${SITE_URL}/errors`)
    expect(urls).toHaveLength(2 + ERROR_CODES.length)

    for (const slug of everySlug()) {
      expect(urls, slug).toContain(`${SITE_URL}/errors/${slug}`)
    }
  })

  it("lists no fragment URL", () => {
    // v2's sitemap declared `/#features`, `/#how-it-works`, `/#architecture` and `/#get-started` as four
    // separate entries with their own priorities. Google collapses all of them into the one document
    // they are part of, so v2 asked for five URLs and had one (`apps/web/CLAUDE.md` § Gotchas).
    for (const entry of sitemap()) {
      expect(entry.url, entry.url).not.toContain("#")
    }
  })

  it("declares no lastModified it cannot substantiate", () => {
    // The only value available at build time is "now", which would claim all 35 pages changed on every
    // unrelated rebuild. Absent beats wrong; it returns when the MDX docs bring real front-matter dates.
    for (const entry of sitemap()) {
      expect(entry.lastModified, entry.url).toBeUndefined()
    }
  })

  it("ranks the home page above the reference pages", () => {
    const [home] = sitemap()
    expect(home?.priority).toBe(1)
    for (const entry of sitemap().slice(1)) {
      expect(entry.priority ?? 0).toBeLessThan(1)
    }
  })

  it("uses absolute URLs on the production origin", () => {
    // A relative `<loc>` is invalid in a sitemap, and an origin from anywhere but `SITE_URL` would
    // publish a preview hostname.
    for (const entry of sitemap()) {
      expect(entry.url.startsWith(`${SITE_URL}/`), entry.url).toBe(true)
    }
  })
})

describe("robots.txt", () => {
  it("allows everything and points at the sitemap", () => {
    const result = robots()
    expect(result.sitemap).toBe(`${SITE_URL}/sitemap.xml`)
    expect(result.rules).toEqual([{ userAgent: "*", allow: "/" }])
  })

  it("disallows nothing, because there is nothing to disallow", () => {
    // There are no accounts (ADR-0007), so no authenticated surface, no search endpoint and no per-user
    // page exists to hide. A `Disallow` appearing here would be evidence one had.
    expect(JSON.stringify(robots().rules)).not.toContain("disallow")
  })
})
