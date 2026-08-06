import { defineCloudflareConfig } from "@opennextjs/cloudflare"
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache"

/**
 * OpenNext's Cloudflare adapter.
 *
 * **The incremental cache is where prerendered pages live, not just where revalidated ones go.**
 * That distinction cost this app all 33 `/errors/[code]` pages. This file previously configured no
 * cache at all, reasoning that "there is no ISR and nothing to revalidate, so a KV or R2 cache would
 * be a binding to provision, pay for, and reason about for no behaviour" — true about revalidation and
 * wrong about serving. A route prerendered through `generateStaticParams` is written to the incremental
 * cache at build time and **read back from it on every request**, so with no cache the Worker threw
 * `NoFallbackError` and returned 404 for every one of them.
 *
 * Nothing local caught it. `next build` prerendered all 33, Vitest asserted one page per code, and the
 * home page and `/errors` index both worked because they are fully static and get inlined — so the only
 * broken routes were the ones nothing on the site links to. They are also the ones that matter most:
 * every error envelope `apps/api` returns points a user at one (`src/app/errors/[code]/page.tsx`).
 *
 * `staticAssetsIncrementalCache` keeps the original intent intact. It serves the prerendered payloads
 * out of Workers Static Assets — the `.open-next/assets` directory this app already deploys — so there
 * is still no namespace, no bucket and no binding to provision. It is **read-only** by construction:
 * `set` and `delete` log an error rather than writing. That is a constraint, not a limitation, and it is
 * the right one here — it means a route that starts wanting real revalidation fails loudly instead of
 * silently serving a stale page, at which point the honest answer is a KV or R2 cache and an ADR.
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
})
