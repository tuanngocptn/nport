#!/usr/bin/env node
/**
 * Asserts that a deployed control plane matches the configuration that was committed.
 *
 *   node scripts/verify-deployment.mjs --host api.nport.online --env staging
 *
 * ## Why this rather than a health check
 *
 * `GET /v1/health` returning 200 proves a Worker is running. It does not prove the *right* Worker is
 * running, or that it got its configuration: wrangler's `vars` are `notInheritable`, so an
 * environment block missing a key deploys clean and serves `/v1/meta` with numbers nobody chose.
 * v2's smoke test made exactly this mistake — it checked that a process stayed alive and would have
 * passed while serving an empty site (`docs/TESTING.md`).
 *
 * ## Why the expectations are not written here
 *
 * They are read from `apps/api/wrangler.jsonc` for the environment being verified. Hardcoding "16"
 * in a workflow would duplicate a number that already lives in the config, and the copy would be
 * wrong the first time somebody tuned the original — the same duplication this repository avoids
 * everywhere else by generating rather than restating. So this compares *deployed against
 * committed*, and works for any environment without being told what to expect.
 */

import { loadWranglerConfig, varsFor } from "./lib/wrangler-config.mjs"

function argOf(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const host = argOf("host")
const envName = argOf("env")

if (host === undefined) {
  console.error("usage: verify-deployment.mjs --host <hostname> [--env <wrangler env>]")
  process.exit(2)
}

// A bare hostname gets https, which is what CI passes. A full URL is accepted so this can be aimed
// at a local server — a check nobody can run against anything but production is a check nobody runs.
const base = host.includes("://") ? host.replace(/\/$/, "") : `https://${host}`
const vars = varsFor(loadWranglerConfig("apps/api/wrangler.jsonc"), envName)

/**
 * Each `/v1/meta` field, and the var it is built from in `src/routes/meta.ts`.
 *
 * `heartbeatIntervalMs` is deliberately absent: the route derives it from the grace period rather
 * than reading a var, so asserting it here would be asserting the route's arithmetic, which its own
 * tests already cover.
 */
const EXPECTATIONS = [
  ["minClientVersion", (v) => String(v.MIN_CLIENT_VERSION)],
  ["tunnelDurationMs", (v) => Number(v.LEASE_TTL_SECONDS) * 1000],
  ["powDifficulty", (v) => Number(v.POW_DIFFICULTY_BITS)],
  ["maxConcurrentPerSource", (v) => Number(v.MAX_CONCURRENT_PER_SOURCE)],
  ["maxCreatesPerHourPerSource", (v) => Number(v.MAX_CREATES_PER_HOUR_PER_SOURCE)],
]

/** A custom domain can take a moment to route after a first deploy; a 502 then is not a failure. */
async function getJson(path, { attempts = 6, waitMs = 10_000 } = {}) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`)
      if (response.ok) return await response.json()
      last = `HTTP ${response.status}`
    } catch (error) {
      last = String(error)
    }
    if (attempt < attempts) {
      console.log(`  ${path}: ${last} — retrying (${attempt}/${attempts})`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
  throw new Error(`${path} never answered: ${last}`)
}

let failures = 0

console.log(`verifying ${base}${envName ? ` against env.${envName}` : ""}\n`)

const health = await getJson("/v1/health")
console.log(`  health: ${JSON.stringify(health)}`)

const meta = await getJson("/v1/meta")

for (const [field, expected] of EXPECTATIONS) {
  const want = expected(vars)
  const got = meta[field]
  if (got === want) {
    console.log(`  ✓ ${field} = ${JSON.stringify(got)}`)
  } else {
    console.error(
      `  ✗ ${field} is ${JSON.stringify(got)}, the committed config says ${JSON.stringify(want)}`,
    )
    failures += 1
  }
}

if (failures > 0) {
  console.error(
    `\nverify-deployment: ${failures} mismatch(es). The deploy did not carry the configuration in the` +
      ` repository — check that env.${envName}'s \`vars\` is complete, since wrangler does not inherit it.\n`,
  )
  process.exit(1)
}

console.log("\nverify-deployment: the deployed control plane matches the committed configuration\n")
