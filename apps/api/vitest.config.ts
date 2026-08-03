import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Tests run in **real `workerd`**, not a mock.
 *
 * Non-negotiable per `docs/TESTING.md`: the whole design rests on Durable Object storage and alarm
 * semantics, and a mocked DO proves nothing about either.
 *
 * Shape note for anyone following an older tutorial: `@cloudflare/vitest-pool-workers` 0.20 removed
 * the `/config` subpath and `defineWorkersProject`. Configuration is now a Vite **plugin**,
 * `cloudflareTest(...)`, taking what used to be `test.poolOptions.workers`. The package ships a
 * codemod (`./codemods/vitest-v3-to-v4`) that performs exactly this transformation.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Without per-test isolation, DO state leaks between cases and you get failures that
        // depend on test order (`apps/api/CLAUDE.md` § Gotchas).
        isolatedStorage: true,
        bindings: {
          // Test-only. Real values are set with `wrangler secret put` and never live in a config
          // file — but the Worker needs *something* here, and a test that shares a production
          // secret is a test that leaks it.
          POW_SECRET: "test-pow-secret",
          IP_HASH_SECRET: "test-ip-hash-secret",
        },
      },
    }),
  ],
})
