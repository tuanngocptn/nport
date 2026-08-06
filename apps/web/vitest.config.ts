import { defineConfig } from "vitest/config"

/**
 * Vitest's boundary against the Playwright tier.
 *
 * Without this, Vitest's default `include` picks up `e2e/*.spec.ts` and every one fails with
 * "Playwright Test did not expect test() to be called here" — two runners fighting over the same glob.
 * The failure is loud, but it is also easy to miss: `pnpm --filter @nport/web test` reports the unit
 * tests as passing on the same screen, so the count looks right while five files error.
 *
 * `include` is stated positively rather than adding `e2e/**` to `exclude`, because the rule worth writing
 * down is which files this runner owns: colocated `*.test.ts` next to the module under test. Anything in
 * `e2e/` belongs to `playwright.config.ts`, and a third naming convention arriving later should have to
 * pick a side rather than land in both.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
