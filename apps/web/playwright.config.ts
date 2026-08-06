import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright for `apps/web` (ADR-0023).
 *
 * ## What this drives is the Worker, not `next dev`
 *
 * `webServer` builds through OpenNext and serves `.open-next/worker.js` in `workerd` — the artifact that
 * actually deploys. That is slower than `next dev` and it is the entire reason this tier exists: the
 * first thing it found was that **all 33 `/errors/[code]` pages returned 404 from the Worker** while
 * `next build` prerendered every one of them and the unit tests passed. `apps/web/CLAUDE.md` warns that
 * a mistake in this layer "deploys an empty site that returns 200"; nothing that runs `next dev` or reads
 * `.next/` can see it, because the bug is in how the built Worker reads its own output.
 *
 * `preview` is used rather than `wrangler dev` because it runs `populateCache` first, which is the step
 * that copies prerendered pages into the assets directory. Skipping it reproduces the same 404s against a
 * build that is actually fine — a false alarm that cost an investigation, so it is worth stating here.
 *
 * ## Visual baselines are not armed yet
 *
 * ADR-0023 pins baselines to **one OS** because font rasterisation differs per platform, and names Linux.
 * There is no Linux baseline in the repository yet and one cannot honestly be recorded on macOS, so the
 * snapshot spec is skipped unless `NPORT_VISUAL=1`. `docs/TESTING.md` § Frontend e2e says how to record
 * it. Everything else here is behavioural and runs everywhere.
 */

const PORT = 3100

export default defineConfig({
  testDir: "./e2e",
  // The site is static: no test mutates server state, so there is nothing to serialise.
  fullyParallel: true,
  // A `.only` left in a spec silently narrows CI to one test while still reporting green.
  forbidOnly: !!process.env.CI,
  // No retries anywhere. A test that passes on the second attempt against a static site is a test with a
  // race in it, and retries would hide exactly the flake ADR-0023 says makes a tier worthless.
  retries: 0,
  // `github` annotates the failing line in the PR diff; `html` is what CI uploads on failure, and
  // without it the artifact step in `ci.yml` would upload an empty directory. `open: "never"` because a
  // CI runner has no browser to open it in.
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // The platform is in the **path**, not just the filename, so ADR-0023's "Linux is the baseline" is
  // visible in the tree: a snapshot recorded on macOS lands in `__screenshots__/darwin/` and cannot be
  // mistaken for the committed Linux one, and a review can see at a glance which platform a diff is from.
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",

  webServer: {
    // Two steps, because `preview` alone would serve whatever was last built — including a build from
    // before the change under test.
    command: `pnpm exec opennextjs-cloudflare build && pnpm exec opennextjs-cloudflare preview -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    // The OpenNext build is a full Next build plus a bundle step; 40 s is typical and CI is slower.
    timeout: 240_000,
    // Locally, reuse a server someone already has up. In CI there is never one to reuse, and silently
    // testing against a stale process is worse than starting one.
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
})
