import { defineConfig } from "vitest/config"

/**
 * The desktop app's first test tier — pure logic, no DOM.
 *
 * `docs/TESTING.md` had `apps/desktop` down as untested and waiting on Phase 4; this is Phase 4
 * paying that off for the half that does not need a WebView. What lives here is the state that turns
 * an event stream into rendered rows, which is where the interesting mistakes are and which needs no
 * renderer to exercise.
 *
 * **Component and end-to-end coverage is still owed.** Driving a Tauri WebView needs `tauri-driver`
 * with WebdriverIO, and no amount of jsdom substitutes for the three engines this app ships against.
 * `include` is stated positively so a browser tier arriving later has to pick its own glob rather
 * than landing in this runner by accident — the same rule `apps/web/vitest.config.ts` sets out.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
