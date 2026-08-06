import { expect, test } from "@playwright/test"

/**
 * The theme, which is set by an inline script before first paint.
 *
 * **There is no theme toggle.** `docs/TESTING.md` used to require that "the dark-mode toggle persists
 * across a reload", and no such control exists: `docs/mockup/NPort Site.dc.html` does not draw one, and
 * the mockup is the authority on UI. What the site actually does is honour the OS preference and a
 * `nport-theme` key that `apps/desktop` writes — so that, not a toggle, is what is asserted here.
 *
 * The script is the one piece of client JavaScript on the page and it exists for a single reason: run it
 * late and the page paints dark then corrects itself, which is the one flash a user notices.
 *
 * That timing is not directly observable, so the last two tests approach it from both sides — one blocks
 * every stylesheet and checks the attribute is set by `domcontentloaded`, the other checks the served HTML
 * puts an inline, synchronous script in `<head>`. Neither alone is the guarantee; together they are, and
 * the second one's comment records two earlier attempts that looked stronger and were not.
 */

test("dark is the default when nothing says otherwise", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark" })
  const page = await context.newPage()
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  // The page background comes from `--np-page` in `packages/design-tokens`, not from a hex value in
  // `globals.css`. Both themes are asserted because the token is the only thing switching them now —
  // there is no `[data-theme="light"] body` rule left to catch a mistake in one direction.
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(7, 7, 10)")
  await context.close()
})

test("an OS light preference is honoured", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "light" })
  const page = await context.newPage()
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  // Not just the attribute: the tokens have to switch with it, or half the palette follows one signal.
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(242, 242, 246)")
  await context.close()
})

test("a stored preference wins over the OS", async ({ browser }) => {
  // The key `apps/desktop` writes. A user who chose light there and then opens the site should not be
  // handed dark because their OS says so.
  const context = await browser.newContext({ colorScheme: "dark" })
  await context.addInitScript(() => localStorage.setItem("nport-theme", "light"))
  const page = await context.newPage()
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await context.close()
})

test("garbage in storage falls through to the OS rather than breaking", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "light" })
  await context.addInitScript(() => localStorage.setItem("nport-theme", "chartreuse"))
  const page = await context.newPage()
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await context.close()
})

test("the attribute is set without waiting for a stylesheet or a hydration pass", async ({
  page,
}) => {
  // Block every stylesheet and stop at `domcontentloaded`: the attribute must already be there. This rules
  // out the theme being applied from a React effect or an external script, but **not** a script placed
  // late in the document — an inline script at the end of `<body>` still runs before this point, which is
  // why the next test exists.
  await page.route("**/*.css", (route) => route.abort())
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(dark|light)$/)
})

test("the theme script is inline, synchronous, and inside <head>", async ({ request }) => {
  // The anti-FOUC guarantee, asserted as the three properties that actually produce it: an inline script
  // with no `src`, no `defer` and no `async`, in `<head>`, runs while the parser is still in the head and
  // therefore before anything is painted. That is the whole mechanism.
  //
  // Read from the **served HTML**, not the DOM. Two earlier attempts at this test compared the script's
  // position to the first stylesheet's and were wrong twice over: Next hoists stylesheets to the top of
  // `<head>` via `data-precedence`, so the script does not precede them and does not need to — paint is
  // blocked on the stylesheet *loading*, which the parser reaching an inline script always beats. And
  // querying `document` raced React's float management, so the same code passed and failed on consecutive
  // runs. A flaky test here is worse than none (ADR-0023); the server's bytes do not race.
  const html = await (await request.get("/")).text()

  const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"))
  const scripts = [...head.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  const theme = scripts.find(([, , body]) => body?.includes("nport-theme"))

  expect(theme, "no inline script in <head> reads nport-theme").toBeDefined()
  const attributes = theme?.[1] ?? ""
  expect(attributes).not.toMatch(/\bsrc=/)
  expect(attributes).not.toMatch(/\bdefer\b/)
  expect(attributes).not.toMatch(/\basync\b/)
})
