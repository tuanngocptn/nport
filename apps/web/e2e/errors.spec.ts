import { ERROR_CODES, ERRORS, errorSlug } from "@nport/contract"
import { expect, test } from "@playwright/test"

/**
 * `/errors/[code]` — the route every NPort failure message points at.
 *
 * **This spec exists because it caught the bug it was written to look for.** All 33 of these pages
 * returned 404 from the deployed Worker: `next build` prerendered every one, `src/lib/error-codes.test.ts`
 * asserted one page per code, and neither could see it, because the failure was in how the built Worker
 * reads its own prerendered output (`open-next.config.ts`). The home page and the `/errors` index worked
 * throughout — they are fully static — so the only broken routes were the ones nothing on the site links
 * to, which are also the only ones a user reaches from a terminal mid-failure.
 *
 * Checking every code rather than a sample: the pages are generated, so the interesting failure is never
 * "this page is wrong", it is "some subset of the registry did not make it into the build".
 */

test("every code in the registry resolves and renders its own content", async ({ page }) => {
  const failures: string[] = []

  for (const code of ERROR_CODES) {
    const slug = errorSlug(code)
    const response = await page.goto(`/errors/${slug}`)

    if (response?.status() !== 200) {
      failures.push(`${slug} -> HTTP ${response?.status()}`)
      continue
    }
    // The code itself is the `<h1>`, so this distinguishes "served a page" from "served *this* page" —
    // a fallback or a redirect to the index would pass a status check.
    const heading = await page.getByRole("heading", { level: 1 }).textContent()
    if (heading?.trim() !== code) {
      failures.push(`${slug} -> heading was ${JSON.stringify(heading)}`)
    }
  }

  expect(failures, `${failures.length} of ${ERROR_CODES.length} error pages are wrong`).toEqual([])
})

test("a page carries the registry's own cause and action", async ({ page }) => {
  // `SUBDOMAIN_IN_USE` is the code a user is most likely to meet, and it is a server code with details.
  const definition = ERRORS.SUBDOMAIN_IN_USE
  await page.goto("/errors/subdomain-in-use")

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SUBDOMAIN_IN_USE")
  await expect(page.getByText(definition.message)).toBeVisible()
  // Backticks in the registry's prose render as `<code>`, so match on the text either side rather than
  // the raw string — asserting the raw string would pass only while the prose happens to have no markup.
  await expect(page.locator("main")).toContainText(definition.cause.split("`")[0]?.trim() ?? "")
  await expect(page.getByText("What to do")).toBeVisible()
})

test("a slug that names nothing is a 404, not a rendered page", async ({ page }) => {
  // `dynamicParams = false` is what makes this a 404 rather than an on-demand render. Without it a Worker
  // will answer any path under `/errors/`, which is a page anyone can ask it to generate a million of.
  const response = await page.goto("/errors/not-a-real-code")
  expect(response?.status()).toBe(404)
})

test("the index links to every code", async ({ page }) => {
  await page.goto("/errors")

  for (const code of ERROR_CODES) {
    await expect(
      page.locator(`a[href="/errors/${errorSlug(code)}"]`),
      `no link to ${code}`,
    ).toHaveCount(1)
  }
})

test("a code page links back to the index", async ({ page }) => {
  await page.goto("/errors/pow-invalid")
  await page.getByRole("link", { name: /all error codes/i }).click()
  await expect(page).toHaveURL(/\/errors$/)
})
