/**
 * The three colours the OpenGraph card paints with, as literals.
 *
 * **Rule 4 says colours come from `packages/design-tokens`, and this file looks like a violation of it.**
 * It is the one place that cannot comply directly: `src/app/opengraph-image.tsx` renders through Satori,
 * which has no CSS pipeline — no Tailwind, no custom properties, no `var()`. It takes inline styles with
 * literal values or it renders nothing.
 *
 * So the rule is kept the way `crates/contract/src/subdomain.rs` keeps its rule: the values are copied,
 * and **`og-colours.test.ts` parses `tokens.css` and fails if the copy drifts**. A comment saying "keep
 * these in sync" would be the version of this that stops being true.
 */

/** `--np-page` in the dark theme: the opaque page every glass surface composites over. */
export const OG_PAGE = "#07070a"

/** `--np-green`: the primary accent, and the only colour on the card that is not black or white. */
export const OG_GREEN = "#30d158"

/** `--np-text` in the dark theme. Not quite white on purpose — the tokens are not, either. */
export const OG_TEXT = "rgba(255, 255, 255, 0.94)"

/** What the test checks, so the mapping lives beside the values rather than in the test file. */
export const OG_TOKEN_SOURCES = {
  "--np-page": OG_PAGE,
  "--np-green": OG_GREEN,
  "--np-text": OG_TEXT,
} as const
