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

import { existsSync, readdirSync, readFileSync } from "node:fs"
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

/**
 * Every deployable Worker, **discovered rather than listed**.
 *
 * This was a two-entry array, which made it the shape `docs/ROADMAP.md`'s defects 22, 25 and 29 are
 * all about: a hand-kept list standing behind a guarantee, correct until somebody adds an app. Adding
 * `apps/registry` would have silently left it unchecked, and the failure mode is precisely the one
 * this script exists to catch — an environment missing a var, deploying happily, answering with
 * numbers nobody configured.
 */
function wranglerConfigs() {
  return readdirSync(join(ROOT, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}/wrangler.jsonc`)
    .filter((relative) => existsSync(join(ROOT, relative)))
    .sort()
}

const configs = wranglerConfigs()
if (configs.length === 0) {
  console.error("  no apps/*/wrangler.jsonc found — this check is looking in the wrong place")
  problems += 1
}
console.log(`checking ${configs.length} wrangler config(s): ${configs.join(", ")}`)

for (const relative of configs) {
  const config = loadWranglerConfig(relative)
  const top = shapeOf(config)

  for (const [envName, env] of Object.entries(config.env ?? {})) {
    compare(relative, top, shapeOf(env), envName)

    // **Every environment deploys under the same Worker name, and must say so explicitly.**
    //
    // Environments are separate Cloudflare accounts (ADR-0038), so the account is the isolation and
    // there is nothing for a matching name to collide with. Keeping them identical is what makes
    // the dashboards, logs and runbooks read the same everywhere.
    //
    // The check is here because wrangler defaults an unset environment `name` to `<name>-<env>`.
    // Delete the line and staging silently becomes `nport-api-staging`: the deploy still succeeds,
    // the old Worker keeps serving the custom domain, and the only symptom is a second Worker in
    // the dashboard that nothing routes to.
    if (env.name !== config.name) {
      const actual = typeof env.name === "string" ? env.name : `${config.name}-${envName}`
      console.error(
        `  ${relative} env.${envName}: deploys as ${actual}, not ${config.name}` +
          (typeof env.name === "string" ? "" : " — an unset `name` is suffixed with the env name"),
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

/**
 * The secrets the deploy workflow merges in rather than reading from Terraform.
 *
 * `CF_API_TOKEN` is the Worker's own Cloudflare credential. It is created by hand and delivered as
 * a GitHub secret so that nothing Terraform runs can mint Cloudflare authority (ADR-0043), which is
 * what lets the CI token stay free of `User → API Tokens → Edit`.
 *
 * Listing it here is not enough on its own — a name in this array with nothing in the workflow to
 * supply it would mean the Worker starts and refuses every request. So the workflow is checked too.
 */
const SUPPLIED_BY_WORKFLOW = ["CF_API_TOKEN"]

function workflowSuppliesSecret(name) {
  const source = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8")
  return source.includes(`secrets["${name}"]`)
}

{
  const required = namesInRequiredSecrets()
  const emitted = namesInTerraformOutput()
  const provided = [...emitted, ...SUPPLIED_BY_WORKFLOW]

  if (required.length === 0 || emitted.length === 0) {
    console.error("  could not read one of the secret lists — the patterns in this check are stale")
    problems += 1
  }
  for (const name of required.filter((n) => !provided.includes(n))) {
    console.error(`  env.ts requires \`${name}\` and nothing in the deploy provides it`)
    problems += 1
  }
  for (const name of provided.filter((n) => !required.includes(n))) {
    console.error(`  the deploy sets \`${name}\` and env.ts does not require it`)
    problems += 1
  }
  for (const name of SUPPLIED_BY_WORKFLOW.filter((n) => !workflowSuppliesSecret(n))) {
    console.error(
      `  \`${name}\` is listed as workflow-supplied, but deploy.yml never writes it into the bulk` +
        ` file — the Worker would deploy green and refuse every request`,
    )
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
