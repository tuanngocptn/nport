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

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { loadWranglerConfig, ROOT } from "./lib/wrangler-config.mjs"

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

// ── Terraform emits exactly the secrets the Worker requires ────────────────────────────
//
// Two files have to agree and neither imports the other: `REQUIRED_SECRETS` in `apps/api/src/env.ts`
// is what the Worker refuses to start without, and the `worker_secrets` output in
// `infra/terraform/outputs.tf` is what the deploy actually sets (ADR-0040). Add a secret to the code
// and forget the output and every request fails after a green deploy — the Worker is up, correctly
// refusing, and nothing in the pipeline said so.
//
// Read with regexes rather than parsed, because one side is TypeScript and the other is HCL. Both
// patterns are anchored tightly enough that a miss shows up as an empty set, which fails loudly
// below rather than passing vacuously.
function namesInRequiredSecrets() {
  const source = readFileSync(join(ROOT, "apps/api/src/env.ts"), "utf8")
  const block = source.match(/const REQUIRED_SECRETS = \[([\s\S]*?)\] as const/)
  if (block === null) throw new Error("env.ts: no REQUIRED_SECRETS array — this check has rotted")
  return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]).sort()
}

function namesInTerraformOutput() {
  const source = readFileSync(join(ROOT, "infra/terraform/outputs.tf"), "utf8")
  const block = source.match(/output "worker_secrets"[\s\S]*?jsonencode\(\{([\s\S]*?)\}\)/)
  if (block === null)
    throw new Error("outputs.tf: no worker_secrets output — this check has rotted")
  return [...block[1].matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((match) => match[1]).sort()
}

{
  const required = namesInRequiredSecrets()
  const emitted = namesInTerraformOutput()

  if (required.length === 0 || emitted.length === 0) {
    console.error("  could not read one of the secret lists — the patterns in this check are stale")
    problems += 1
  }
  for (const name of required.filter((n) => !emitted.includes(n))) {
    console.error(`  env.ts requires \`${name}\` and infra/terraform/outputs.tf does not emit it`)
    problems += 1
  }
  for (const name of emitted.filter((n) => !required.includes(n))) {
    console.error(`  infra/terraform/outputs.tf emits \`${name}\` and env.ts does not require it`)
    problems += 1
  }
}

if (problems > 0) {
  console.error(
    `\ndeploy-check: ${problems} problem(s). Wrangler will not warn about any of these.\n`,
  )
  process.exit(1)
}

console.log("deploy-check: every environment matches the top level in shape\n")
