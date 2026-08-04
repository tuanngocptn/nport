/**
 * The one place a `CloudflareClient` is built.
 *
 * Both callers — the provisioning saga in `SubdomainLease` and the reconciliation cron — need the
 * same four secrets and the same decision about which `fetch` to use. Having that decision in two
 * places is how one of them ends up talking to the real API while the other does not.
 */

import type { Env } from "../types"
import { CloudflareClient } from "./client"
import { devFetch, useDevFake } from "./dev-fake"

/**
 * A client for this environment.
 *
 * In production, and in any dev session with a real token, this is the ordinary client over
 * `globalThis.fetch`. Under `wrangler dev` with `FAKE_CLOUDFLARE=1` in `apps/api/.dev.vars` it is
 * the same client over an in-memory fake, so `pnpm dev` can provision without credentials — see
 * `./dev-fake.ts` for exactly how far that goes and where it stops.
 */
export function cloudflareFor(env: Env): CloudflareClient {
  const config = {
    apiToken: env.CF_API_TOKEN,
    accountId: env.CF_ACCOUNT_ID,
    zoneId: env.CF_ZONE_ID,
    domain: env.CF_DOMAIN,
  }
  // `undefined` rather than `globalThis.fetch`: the constructor's own default resolves it, and
  // naming it here would be a second place that has to be kept in step.
  return new CloudflareClient(config, useDevFake(env) ? devFetch : undefined)
}
