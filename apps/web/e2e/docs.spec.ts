import { expect, test } from "@playwright/test"

import { DOC_PAGES, docHref } from "../src/content/docs"
import { CLI, usage } from "../src/lib/cli-reference"

/**
 * `/docs` — the user documentation, and the page that finally renders the generated flag reference.
 *
 * The unit tests cover the registry and the JSON's shape. What only a request can show is that MDX
 * compiled, that `mdx-components.tsx` actually styled it, and that the flag table on the page is the
 * flags in `schema/cli.json` — three separate mechanisms, each able to be correct while the page is blank.
 */

test("every registered page is served and titled", async ({ page }) => {
  for (const doc of DOC_PAGES) {
    const response = await page.goto(docHref(doc.slug))
    expect(response?.status(), doc.slug).toBe(200)
    // The `<h1>` comes from the MDX body and the `<title>` from its `meta` export. Both being present is
    // what proves the compile step ran rather than the route rendering an empty shell.
    await expect(page.getByRole("heading", { level: 1 }), doc.slug).toBeVisible()
    await expect(page).toHaveTitle(/— NPort$/)
  }
})

test("an unregistered slug is a 404", async ({ page }) => {
  // `dynamicParams = false` plus `isDocSlug`. Without it the Worker would render any path under `/docs`.
  expect((await page.goto("/docs/not-a-page"))?.status()).toBe(404)
  // Two segments deep is not a doc page either, and the optional catch-all would happily match it.
  expect((await page.goto("/docs/cli/extra"))?.status()).toBe(404)
})

test("the CLI page lists exactly the flags the binary accepts", async ({ page }) => {
  await page.goto("/docs/cli")
  // `main`, not `table`: the page renders two — Arguments and Options — and a bare `table` locator is a
  // strict-mode violation rather than a useful assertion.
  const content = page.locator("main")

  // Every flag in the generated reference, in its rendered form. This is the assertion defect 38 was
  // really about: three files claimed a generated flag reference existed, and nothing rendered one. If
  // `args.rs` gains a flag and codegen runs, this passes without an edit; if the page is hand-maintained
  // again, it fails.
  for (const flag of CLI.flags) {
    await expect(content, flag.id).toContainText(usage(flag))
  }
  for (const positional of CLI.positionals) {
    await expect(content, positional.id).toContainText(`[${positional.valueName}]`)
  }
})

test("the CLI page shows no value for a switch", async ({ page }) => {
  await page.goto("/docs/cli")
  // `--quiet QUIET` is what an unbuilt clap walk produced. It would be a documented value the binary
  // rejects, so it is asserted on the rendered page as well as in the generator's own tests.
  await expect(page.locator("main")).not.toContainText("--quiet <")
})

test("markdown is styled rather than served raw", async ({ page }) => {
  await page.goto("/docs")

  // `mdx-components.tsx` is the docs' entire stylesheet — Tailwind's preflight strips heading sizes and
  // list markers, so an unstyled page looks like a broken build. Checking one computed style is enough to
  // tell "the mapping ran" from "the mapping was dropped".
  const heading = page.getByRole("heading", { level: 1 })
  await expect(heading).toBeVisible()
  const size = await heading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  )
  expect(size).toBeGreaterThan(20)

  // A fenced block became a real `pre`, which is the construct most likely to be lost in an MDX misconfig.
  await expect(page.locator("pre").first()).toBeVisible()
})

test("the docs are reachable from the home page", async ({ page }) => {
  // The discoverability half of the bug that left 33 error pages unreachable: a docs site with no entry
  // point is a docs site nobody reads. The navbar link is not in the mockup, and `sections/navbar.tsx`
  // says why.
  await page.goto("/")
  await page.getByLabel("Main").getByRole("link", { name: "Docs", exact: true }).click()
  await expect(page).toHaveURL(/\/docs$/)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
})

test("the sidebar marks the page you are on", async ({ page }) => {
  await page.goto("/docs/cli")
  const nav = page.getByLabel("Documentation")
  await expect(nav.locator('[aria-current="page"]')).toHaveText("CLI reference")

  await nav.getByRole("link", { name: "Getting started" }).click()
  await expect(page).toHaveURL(/\/docs$/)
})
