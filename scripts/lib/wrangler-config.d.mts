/**
 * Types for `wrangler-config.mjs`, which is plain JavaScript because it is run by `node` directly
 * from CI with no build step.
 *
 * It exists because `apps/gateway/vitest.config.ts` imports the loader to size its rate-limit tests
 * from the limiter's real ceiling, and `noImplicitAny` will not let a `.ts` file import an untyped
 * `.mjs`. Hand-written rather than generated: the surface is three functions that have not changed
 * since they were extracted, and a build step for one import would cost more than it saves.
 *
 * `WranglerConfig` is deliberately loose. These files carry far more than this — Durable Object
 * migrations, asset bindings, observability — and enumerating all of it here would be a second,
 * worse copy of wrangler's own schema that drifts the first time Cloudflare adds a field. What is
 * named is what this repository's scripts actually read; the index signature carries the rest.
 */

export interface RateLimitBinding {
  name: string
  namespace_id: string
  simple: { limit: number; period: number }
}

export interface ServiceBinding {
  binding: string
  service: string
}

export interface WranglerConfig {
  name: string
  vars?: Record<string, string>
  routes?: { pattern: string; custom_domain?: boolean }[]
  services?: ServiceBinding[]
  ratelimits?: RateLimitBinding[]
  workers_dev?: boolean
  env?: Record<string, WranglerConfig>
  [key: string]: unknown
}

/** The repository root, resolved from this module's own location. */
export const ROOT: string

/** Strips `//` and block comments from JSONC without eating them inside strings. */
export function stripJsonc(text: string): string

/** Parses a `wrangler.jsonc` at a repo-relative path. Throws if the comment stripper mangled it. */
export function loadWranglerConfig(relative: string): WranglerConfig

/**
 * The `vars` a named environment actually deploys with — **not** merged with the top level, because
 * wrangler does not merge them. Throws if the environment does not exist.
 */
export function varsFor(config: WranglerConfig, envName?: string): Record<string, string>
