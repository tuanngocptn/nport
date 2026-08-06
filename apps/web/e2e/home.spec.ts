import { expect, test } from "@playwright/test"

/**
 * The marketing page: the sections, their order, and the copy that must not appear.
 *
 * The order is `apps/web/CLAUDE.md` rule 1 and is carried from v2 because it converts. Asserting it in a
 * browser rather than by reading `page.tsx` is the difference between "the JSX lists them in this order"
 * and "the document does" — the two diverge the moment a section becomes conditional.
 */

const SECTIONS = ["how", "features", "compare", "download", "faq"]

test("every section is present, in the order rule 1 fixes", async ({ page }) => {
  await page.goto("/")

  const found = await page.evaluate((ids) => {
    const positions = ids
      .map((id) => {
        const element = document.getElementById(id)
        return element ? { id, top: element.getBoundingClientRect().top + window.scrollY } : null
      })
      .filter((entry): entry is { id: string; top: number } => entry !== null)
    return positions.sort((a, b) => a.top - b.top).map((entry) => entry.id)
  }, SECTIONS)

  expect(found).toEqual(SECTIONS)
})

test("the navbar's anchors reach the sections they name", async ({ page }) => {
  await page.goto("/")

  // Scoped to the nav's `aria-label`: the footer links to the same sections, so an unscoped locator is
  // ambiguous — which is Playwright telling us the labels are duplicated on purpose, not a bug.
  const nav = page.getByLabel("Main")

  for (const [name, id] of [
    ["How it works", "how"],
    ["Features", "features"],
    ["vs ngrok", "compare"],
  ] as const) {
    await nav.getByRole("link", { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#${id}$`))
    await expect(page.locator(`#${id}`)).toBeInViewport()
  }
})

test("no withheld claim reaches the page", async ({ page }) => {
  await page.goto("/")
  const text = (await page.locator("body").textContent()) ?? ""

  // The four features and one comparison row `src/content/site.ts` holds back, plus the third step the
  // design specifies. `site.test.ts` asserts the data; this asserts the rendered document, which is what
  // a reader and a crawler see. Both are worth having: the filter could be right and the component could
  // hardcode the design's copy anyway.
  for (const claim of [
    "Replay any request",
    "Live request inspector",
    "Menu bar control",
    "Presets and history",
    "Watch the traffic",
  ]) {
    expect(text, claim).not.toContain(claim)
  }
})

test("the FAQ answers are in the HTML whether or not they are open", async ({ page }) => {
  await page.goto("/")

  // `<details>` keeps its content in the document when closed, which is what makes the `FAQPage` markup
  // honest — a crawler and a screen reader both find the answer. A client-side accordion would not.
  const answer = page.getByText(/no signup, no API key and no dashboard/i)
  await expect(answer).toBeAttached()

  const question = page.getByRole("heading", { name: "Do I need an account?", exact: true })
  await question.click()
  await expect(answer).toBeVisible()
})

test("the install command is one line a reader can copy", async ({ page }) => {
  await page.goto("/")
  // The CTA's whole job. `$` is a `select-none` affordance, so the copyable text must not include it.
  await expect(page.locator("#download code")).toContainText("npx nport 3000")
})
