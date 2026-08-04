import { defineCloudflareConfig } from "@opennextjs/cloudflare"

/**
 * OpenNext's Cloudflare adapter.
 *
 * **No incremental cache on purpose.** The site is static content plus `/errors/[code]` pages
 * generated from the contract at build time; there is no ISR and nothing to revalidate, so a KV or
 * R2 cache would be a binding to provision, pay for, and reason about for no behaviour. Add one only
 * when a route genuinely needs revalidation (`apps/web/wrangler.jsonc`).
 */
export default defineCloudflareConfig()
