import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { DOC_PAGES, docHref, isDocSlug } from "./docs"

/**
 * The registry and the directory must describe the same set of pages.
 *
 * `docs.ts` has to be a hand-kept list — the route needs `generateStaticParams` at build time and a
 * Worker has no filesystem — and a hand-kept list is exactly the shape this repository has been bitten by
 * four times (defects 34, 35, 37, 38). So the check is mechanical: read the directory, compare.
 *
 * Both directions matter and they fail differently. An `.mdx` file missing from the registry is a page
 * nobody can reach, which is how 33 error pages went unnoticed. A registry entry with no file is a build
 * failure — but only once someone builds, and this says which slug immediately.
 */

const DOCS_DIR = join(import.meta.dirname, "docs")

/** `index.mdx` is the `""` slug; every other `<name>.mdx` is `<name>`. */
function slugsOnDisk(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((entry) => entry.endsWith(".mdx"))
    .map((entry) => entry.replace(/\.mdx$/, ""))
    .map((name) => (name === "index" ? "" : name))
    .sort()
}

describe("the docs registry", () => {
  it("lists every page on disk, and no page that is not", () => {
    const registered = DOC_PAGES.map((page) => page.slug).sort()
    expect(registered).toEqual(slugsOnDisk())
  })

  it("has an index page", () => {
    // `/docs` is linked from the navbar and the footer. Without a `""` slug it would 404, and the only
    // symptom would be a dead nav item.
    expect(DOC_PAGES.some((page) => page.slug === "")).toBe(true)
  })

  it("gives every page a nav label", () => {
    for (const page of DOC_PAGES) {
      expect(page.label.length, `slug ${JSON.stringify(page.slug)}`).toBeGreaterThan(0)
    }
  })

  it("uses no duplicate slug", () => {
    const slugs = DOC_PAGES.map((page) => page.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

describe("docHref", () => {
  it("maps the index to /docs with no trailing slash", () => {
    // A trailing slash here would make the sitemap advertise `/docs/` while the nav links `/docs`, which
    // is two URLs for one page — the mistake the sitemap already avoids for fragments.
    expect(docHref("")).toBe("/docs")
  })

  it("maps a page to /docs/<slug>", () => {
    expect(docHref("cli")).toBe("/docs/cli")
  })
})

describe("isDocSlug", () => {
  it("accepts what is registered and rejects what is not", () => {
    expect(isDocSlug("")).toBe(true)
    expect(isDocSlug("cli")).toBe(true)
    expect(isDocSlug("not-a-page")).toBe(false)
    // The route's own guard against a path that looks plausible: `dynamicParams = false` stops most of
    // it, and this is what makes the check a value rather than a Next configuration flag.
    expect(isDocSlug("index")).toBe(false)
  })
})
