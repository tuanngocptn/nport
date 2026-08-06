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
        // No `isolatedStorage` here: the option **does not exist in 0.20** — it is absent from the
        // package's dist and from its own v3→v4 codemod — and passing it is silently ignored, which
        // is how it survived here unnoticed. Durable Object state therefore leaks between tests, and
        // every suite that writes any must call `reset()` from `cloudflare:test` in an `afterEach`
        // (`apps/api/CLAUDE.md` § Gotchas).
        bindings: {
          // Test-only. Real values are set with `wrangler secret put` and never live in a config
          // file — but the Worker needs *something* here, and a test that shares a production
          // secret is a test that leaks it.
          POW_SECRET: "test-pow-secret",
          IP_HASH_SECRET: "test-ip-hash-secret",
          // Never reach a network: every Cloudflare call is answered by `test/fake-cloudflare.ts`,
          // which throws on any request to a host it does not recognise. A test that accidentally
          // escapes the fake fails loudly rather than talking to a real account.
          CF_API_TOKEN: "test-cf-api-token",
          CF_ACCOUNT_ID: "test-account",
          CF_ZONE_ID: "test-zone",
          // `.test` is reserved by RFC 2606, so a leaked request cannot resolve to anything real.
          CF_DOMAIN: "nport.test",
          // **Pinned so a developer's `.dev.vars` cannot change what the tests mean.** The pool
          // reads that file alongside `wrangler.jsonc`, so `FAKE_CLOUDFLARE=1` — which every local
          // dev session sets — would otherwise route the saga through `src/cloudflare/dev-fake.ts`
          // and straight past `test/fake-cloudflare.ts`. That is not a hypothetical: adding the
          // flag broke 36 tests here, and the failures pointed at the saga rather than at the
          // config. Anything the suite depends on belongs in this block, set explicitly.
          FAKE_CLOUDFLARE: "",
          MIN_CLIENT_VERSION: "3.0.0",
          // Loosened from the deployed floor of 20 bits: 4 bits exercises the identical code path but
          // does not make every create-path test hostage to a loaded CI runner's CPU.
          POW_DIFFICULTY_BITS: 4,
          // **Federation off, or the suite talks to the internet.**
          //
          // `test/reconcile.test.ts` drives the real `scheduled` handler, which now also calls
          // `registerWithRegistry` — so with `REGISTRY_URL` reaching the isolate from
          // `wrangler.jsonc`, those tests fetched `https://registry.nport.link` for real. It did not
          // fail, and that is the worrying part: registration swallows every error by design, so the
          // escape was completely silent. Exactly the hazard the `FAKE_CLOUDFLARE` note above
          // describes, in the other direction — a var added to the config quietly changed what an
          // unrelated suite does.
          //
          // `test/register.test.ts` supplies these itself, with a fake registry.
          NODE_ID: "",
          PUBLIC_URL: "",
          REGISTRY_URL: "",
          NODE_VERSION: "",
        },
      },
    }),
  ],
})
