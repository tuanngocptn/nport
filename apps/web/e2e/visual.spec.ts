import { expect, test } from "@playwright/test"

/**
 * Visual baselines (ADR-0023) — **armed**, on Linux only.
 *
 * The ADR pins baselines to one OS because font rasterisation differs per platform, and names Linux:
 * "Linux is the baseline; local runs compare behaviour only". Those baselines now exist, recorded on
 * the `ubuntu-latest` runner that compares them — `docs/TESTING.md` § Frontend e2e has the how and the
 * review rule for a changed one.
 *
 * **Skipped off Linux rather than off a flag**, which is what "local runs compare behaviour only"
 * means in practice. `snapshotPathTemplate` puts the platform in the path, so a macOS run looks for
 * `__screenshots__/darwin/` and fails on a missing snapshot — a failure about nothing, on every local
 * `pnpm test:e2e`. Recording one to satisfy it would be worse: a second baseline drifting from the
 * first, telling you the page changed when the machine did.
 *
 * `NPORT_VISUAL=1` still forces a run, which is how the recording job arms itself in CI and how
 * somebody on Linux can check a change locally.
 *
 * `animations: "disabled"` and the two masks below are the churn controls the ADR asks for, applied up
 * front rather than after the first intermittent failure.
 */

const LINUX = process.platform === "linux"
const FORCED = process.env.NPORT_VISUAL === "1"

test.describe("visual baselines", () => {
  test.skip(
    !LINUX && !FORCED,
    `baselines are Linux-only (ADR-0023); this is ${process.platform}. Behaviour specs still ran.`,
  )

  test("the home page matches its baseline", async ({ page }) => {
    await page.goto("/")
    // `<details>` renders differently open and closed, and the FAQ's default state is closed; nothing
    // needs normalising, but a future toggle here would.
    await expect(page).toHaveScreenshot("home.png", {
      fullPage: true,
      animations: "disabled",
    })
  })

  test("an error page matches its baseline", async ({ page }) => {
    // One representative page rather than 33: they share a single component, so the baseline's job is the
    // layout and the tokens, and 33 near-identical snapshots is 33 things to re-record.
    await page.goto("/errors/subdomain-in-use")
    await expect(page).toHaveScreenshot("error-page.png", {
      fullPage: true,
      animations: "disabled",
    })
  })
})
