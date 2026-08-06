import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

import { OG_TOKEN_SOURCES } from "./og-colours"

/**
 * The OpenGraph card's colours are the design tokens' colours.
 *
 * `src/lib/og-colours.ts` copies three values out of `tokens.css` because Satori cannot resolve a CSS
 * custom property, and a copy without a check is how `apps/web`'s page background ended up as two hex
 * literals in `globals.css` in the first place. This reads the token file and compares.
 *
 * Only the **dark** block is read. `:root` is dark by default and the card has one appearance — a social
 * card has no viewer preference to respond to.
 */

/** Resolved through Node rather than by relative path, so moving this file cannot silently break it. */
function tokensCss(): string {
  const require = createRequire(import.meta.url)
  return readFileSync(require.resolve("@nport/design-tokens/tokens.css"), "utf8")
}

/** The `:root` block only — `[data-theme="light"]` redefines the same names. */
function darkBlock(css: string): string {
  const start = css.indexOf(":root {")
  expect(start, ":root block not found in tokens.css").toBeGreaterThan(-1)
  const end = css.indexOf("\n}", start)
  return css.slice(start, end)
}

describe("the card's colours", () => {
  it("match the tokens they are copied from", () => {
    const block = darkBlock(tokensCss())

    for (const [token, expected] of Object.entries(OG_TOKEN_SOURCES)) {
      const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block)
      expect(match, `${token} is not defined in tokens.css :root`).not.toBeNull()
      // Whitespace-insensitive: `rgba(255, 255, 255, 0.94)` and `rgba(255,255,255,0.94)` are the same
      // colour, and CSS formatting is Biome's business rather than this test's.
      const actual = (match?.[1] ?? "").trim().replace(/\s+/g, "")
      expect(actual, token).toBe(expected.replace(/\s+/g, ""))
    }
  })

  it("checks every colour the card uses", () => {
    // Guards the failure mode this test cannot otherwise see: a fourth colour added to the card and not
    // added to `OG_TOKEN_SOURCES` would be unchecked, and the test would still pass.
    expect(Object.keys(OG_TOKEN_SOURCES)).toHaveLength(3)
  })
})
