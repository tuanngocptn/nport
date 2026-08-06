#!/usr/bin/env node
/**
 * Refuses a deploy whose environments have drifted apart.
 *
 * ## Why this exists
 *
 * Wrangler marks `vars` as **`notInheritable`**: an environment block *replaces* the top-level one
 * rather than merging with it. So adding `MAX_ACTIVE_TUNNELS` to the top level and forgetting the
 * `staging` block does not fail, and does not warn — staging simply deploys without it, `env.ts`
 * falls back or throws on first use, and `GET /v1/meta` answers with numbers that were never
 * configured. The Worker looks healthy the whole time.
 *
 * The same applies to Durable Object bindings and rate-limit bindings: a class added to one
 * environment and not the other produces a Worker that boots and then fails on the first request
 * that touches the missing namespace.
 *
 * This compares the *shape* of each environment against the top level — key names, binding names,
 * class names — and says nothing about values, which are meant to differ. Staging runs a shorter
 * lease and a cheaper proof of work on purpose.
 *
 * Run by `pnpm deploy:check`, and by the deploy workflow before it touches an account.
 */

import { loadWranglerConfig } from "./lib/wrangler-config.mjs"

/** The shape that must match across environments. Values are free to differ; names are not. */
function shapeOf(config) {
  return {
    vars: Object.keys(config.vars ?? {}).sort(),
    durableObjects: (config.durable_objects?.bindings ?? [])
      .map((binding) => `${binding.name}:${binding.class_name}`)
      .sort(),
    rateLimits: (config.ratelimits ?? []).map((limit) => limit.name).sort(),
    crons: (config.triggers?.crons ?? []).length,
  }
}

let problems = 0

function compare(label, top, env, envName) {
  for (const field of ["vars", "durableObjects", "rateLimits"]) {
    const missing = top[field].filter((key) => !env[field].includes(key))
    const extra = env[field].filter((key) => !top[field].includes(key))

    for (const key of missing) {
      console.error(`  ${label} env.${envName}: missing ${field} entry \`${key}\``)
      problems += 1
    }
    for (const key of extra) {
      console.error(
        `  ${label} env.${envName}: has ${field} entry \`${key}\` the top level does not`,
      )
      problems += 1
    }
  }

  if (top.crons !== env.crons) {
    console.error(
      `  ${label} env.${envName}: ${env.crons} cron trigger(s) against ${top.crons} at the top level`,
    )
    problems += 1
  }
}

for (const relative of ["apps/api/wrangler.jsonc", "apps/web/wrangler.jsonc"]) {
  const config = loadWranglerConfig(relative)
  const top = shapeOf(config)

  for (const [envName, env] of Object.entries(config.env ?? {})) {
    compare(relative, top, shapeOf(env), envName)

    if (typeof env.name !== "string" || env.name === config.name) {
      console.error(
        `  ${relative} env.${envName}: needs its own \`name\`, or it overwrites ${config.name}`,
      )
      problems += 1
    }
    if (!Array.isArray(env.routes) || env.routes.length === 0) {
      console.error(`  ${relative} env.${envName}: no routes — it would deploy with no hostname`)
      problems += 1
    }
  }
}

if (problems > 0) {
  console.error(
    `\ndeploy-check: ${problems} problem(s). Wrangler will not warn about any of these.\n`,
  )
  process.exit(1)
}

console.log("deploy-check: every environment matches the top level in shape\n")
