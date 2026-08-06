import { ERROR_CODES } from "@nport/contract"
import { expect, test } from "@playwright/test"

import { DOC_PAGES } from "../src/content/docs"

/**
 * The SEO surface, asserted against what the Worker actually serves.
 *
 * `src/lib/seo.test.ts` already asserts the *builders* — that `featureList` is derived, that no version
 * is hardcoded, that each page gets its own canonical. What no unit test can say is whether any of it
 * reaches the response: a JSON-LD block is emitted by a component, a canonical by Next's metadata layer,
 * and `sitemap.xml` by a route handler that only exists once built. Three different mechanisms, all of
 * which can be correct in isolation and absent from the page.
 */

const REQUIRED_BLOCKS = ["WebSite", "SoftwareApplication", "HowTo", "FAQPage"]

async function jsonLd(page: import("@playwright/test").Page) {
  const raw = await page.locator('script[type="application/ld+json"]').allTextContents()
  return raw.map((text) => JSON.parse(text) as Record<string, unknown>)
}

test("the home page serves all four JSON-LD blocks, and they parse", async ({ page }) => {
  await page.goto("/")
  // `JSON.parse` is the assertion as much as the count is: a block that a crawler cannot parse is a block
  // that is not there, and the escaping in `serializeJsonLd` is exactly the kind of thing that breaks it.
  const blocks = await jsonLd(page)
  expect(blocks.map((block) => block["@type"])).toEqual(REQUIRED_BLOCKS)
})

test("the FAQ questions in the markup are the questions on the page", async ({ page }) => {
  await page.goto("/")

  const faq = (await jsonLd(page)).find((block) => block["@type"] === "FAQPage")
  // Asserted rather than optional-chained: if the block is missing, the failure should say so, not throw
  // a TypeError from `.map` several lines later.
  expect(faq, "no FAQPage block on the page").toBeDefined()

  // Cast after the assertion rather than chaining through `?.`: the shape is this block's contract, and
  // `expect` above is what establishes it is there.
  const questions = (faq as { mainEntity: Array<{ name: string }> }).mainEntity
  const marked = questions.map((entry) => entry.name)
  expect(marked.length).toBeGreaterThan(0)

  // Google requires `FAQPage` content be visible on the page carrying it, and v2 shipped five questions
  // that were nowhere on it. This is the only check that can see the difference, because the markup and
  // the section are both correct on their own.
  for (const question of marked) {
    await expect(page.getByRole("heading", { name: question, exact: true })).toBeVisible()
  }
})

test("the software block advertises nothing the page does not", async ({ page }) => {
  await page.goto("/")
  const software = (await jsonLd(page)).find((block) => block["@type"] === "SoftwareApplication")
  const features = software?.featureList as string[]

  // Withheld claims, from `src/content/site.ts`. Named literally so this still bites if `featureList`
  // stops being derived — the unit test compares it to a function, and a function can be changed.
  for (const withheld of ["Live request inspector", "Replay any request", "Menu bar control"]) {
    expect(features, withheld).not.toContain(withheld)
  }
  for (const shipping of ["Custom subdomains", "Automatic HTTPS"]) {
    expect(features, shipping).toContain(shipping)
  }
})

test("each page declares itself canonical, not the home page", async ({ page }) => {
  // The bug `pageMetadata()` exists to prevent: a canonical inherited from the layout would name `/` as
  // the canonical version of all 33 error pages, quietly asking Google to drop the pages the product
  // deep-links to. Nothing renders a canonical tag, so this is the only place it is observable.
  for (const [path, expected] of [
    ["/", "https://nport.link"],
    ["/errors", "https://nport.link/errors"],
    ["/errors/subdomain-in-use", "https://nport.link/errors/subdomain-in-use"],
  ] as const) {
    await page.goto(path)
    await expect(page.locator('link[rel="canonical"]'), path).toHaveAttribute("href", expected)
  }
})

test("sitemap.xml lists every real page and no fragment", async ({ request }) => {
  const response = await request.get("/sitemap.xml")
  expect(response.status()).toBe(200)
  const xml = await response.text()

  const locations = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1] ?? "")
  // Home, the error index, one per code, and one per doc page.
  expect(locations).toHaveLength(2 + ERROR_CODES.length + DOC_PAGES.length)
  expect(locations).toContain("https://nport.link/")
  // v2 listed four `#fragment` URLs as separate documents; Google collapses them into one page.
  expect(locations.filter((location) => location.includes("#"))).toEqual([])
})

test("robots.txt allows everything and points at the sitemap", async ({ request }) => {
  const response = await request.get("/robots.txt")
  expect(response.status()).toBe(200)
  const text = await response.text()

  expect(text).toContain("Allow: /")
  expect(text).toContain("Sitemap: https://nport.link/sitemap.xml")
  expect(text.toLowerCase()).not.toContain("disallow")
})

test("the sitemap's own URLs resolve", async ({ request }) => {
  // A sitemap is a set of promises to a crawler. Nothing else in the repository checks that its entries
  // are pages rather than paths someone typed — and the error pages were 404ing while listed here.
  const xml = await (await request.get("/sitemap.xml")).text()
  const paths = [...xml.matchAll(/<loc>https:\/\/nport\.link(.*?)<\/loc>/g)].map(
    (match) => match[1] || "/",
  )

  const broken: string[] = []
  for (const path of paths) {
    const response = await request.get(path)
    if (response.status() !== 200) broken.push(`${path} -> ${response.status()}`)
  }
  expect(broken, `${broken.length} of ${paths.length} sitemap URLs do not resolve`).toEqual([])
})
