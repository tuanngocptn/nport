import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Tests run in **real `workerd`**, for the same reason `apps/node`'s do: the directory is a Durable
 * Object with SQLite storage and an alarm-free cron, and a mocked DO proves nothing about either.
 * `docs/TESTING.md`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only. Real values come from Terraform and `wrangler secret bulk` (ADR-0040), and a
          // test sharing a production secret is a test that leaks it.
          //
          // **Deliberately not the same value `apps/node`'s tests use.** The two services sign
          // challenges with different secrets, and a shared test value would let a mistake that
          // crossed them pass here (ADR-0047).
          POW_SECRET: "test-registry-pow-secret",
          IP_HASH_SECRET: "test-registry-ip-hash-secret",
          // **Pinned so a developer's `.dev.vars` cannot change what the tests mean**, exactly as
          // `apps/node`'s config warns: the pool reads that file alongside `wrangler.jsonc`.
          MIN_CLIENT_VERSION: "3.0.0",
          // Loosened from the deployed floor of 20 bits. 4 bits exercises the identical code path
          // without making every registration test hostage to a loaded runner's CPU — a 20-bit solve
          // is ~1M `crypto.subtle.digest` awaits in `workerd`, which times out at 5 s. Found the
          // honest way: the first run of these tests hit exactly that.
          POW_DIFFICULTY_BITS: 4,
        },
        // No outbound network. Every DNS lookup and every node probe is answered by
        // `test/fake-upstream.ts`, which throws on a host it does not recognise — so a test that
        // escapes the fake fails loudly rather than resolving someone's real domain.
        //
        // Same warning as `apps/node`: `isolatedStorage` does not exist in vitest-pool-workers 0.20
        // and is silently ignored, so any suite writing DO state must `reset()` in an `afterEach`.
      },
    }),
  ],
})
