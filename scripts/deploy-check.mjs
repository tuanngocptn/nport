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
    // Delete the line and staging silently becomes `nport-node-staging`: the deploy still succeeds,
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
    checkReachability(relative, env, `env.${envName}`)
  }

  checkReachability(relative, config, "top level")
}

/**
 * **Exactly one Worker per deployment is publicly reachable, and it is the gateway** (ADR-0049).
 *
 * This is the check the comment in `apps/gateway/src/types.ts` claimed existed before it did, which is
 * the shape `docs/ROADMAP.md` has spent this phase removing — a stated guarantee with nothing behind
 * it. It is worth having behind something, because it is load-bearing in a way nothing else in the
 * pipeline notices.
 *
 * `apps/node` and `apps/registry` trust `x-nport-source-hash` on every request, and their entire reason
 * for trusting it is that no request can reach them except through the gateway's service binding.
 * **Add a `routes` entry or leave `workers_dev` unset on either, and that stops being true silently.**
 * Every deploy still succeeds, every test still passes, and any caller who found the hostname could
 * choose their own source identity — walking past the concurrency cap, the hourly quota and the rate
 * limiter at once, for every source, because they would all be whatever the caller sent.
 *
 * The inverse matters too and is the ordinary mistake: a gateway with no route deploys to no hostname
 * and the deployment answers nothing at all.
 *
 * **Which Workers are internal is read from their source, not listed here.** A hand-kept list is the
 * shape this function exists to replace, and the honest key is already in the code: a Worker is
 * internal exactly when it reads a forwarded identity it did not compute, and `readForwarded` from
 * `@nport/worker-kit` is the only way to do that.
 *
 * **Not `FORWARDED_SOURCE_HASH`**, which was the first attempt and does not distinguish the two sides:
 * the gateway imports that constant to *write* the header, so keying on it made the gateway look
 * internal and failed its own route. Reading is the verb that matters.
 *
 * So a fourth backend Worker that trusts the gateway is covered the moment it imports the thing that
 * makes it trust the gateway. Getting this wrong in the other direction — a Worker that *stops*
 * reading the header and keeps its private config — is harmless, because it then has no identity to
 * have forged.
 */
function checkReachability(relative, config, where) {
  const routes = Array.isArray(config.routes) ? config.routes : []

  if (!trustsForwardedIdentity(relative)) {
    // A public Worker — the gateway, or the site. The ordinary mistake here is the opposite one: no
    // route means it deploys to no hostname and answers nothing at all.
    if (routes.length === 0) {
      console.error(`  ${relative} ${where}: no routes — it would deploy with no hostname`)
      problems += 1
    }
    return
  }

  if (routes.length > 0) {
    console.error(
      `  ${relative} ${where}: reads a forwarded identity and declares ${routes.length} route(s).` +
        ` Only apps/gateway may have one — a reachable internal Worker lets any caller set their own` +
        ` x-nport-source-hash (ADR-0049)`,
    )
    problems += 1
  }
  if (config.workers_dev !== false) {
    console.error(
      `  ${relative} ${where}: reads a forwarded identity and workers_dev is not \`false\`. The` +
        ` default is on, so it would answer on a workers.dev hostname and trust an identity nobody` +
        ` set (ADR-0049)`,
    )
    problems += 1
  }
}

/**
 * Whether an app's `src/` reads an identity the gateway computed — which is what makes it internal.
 *
 * Grepping the source rather than parsing it: `readForwarded` is exported from one module and imported
 * by name, so a substring match has no realistic false positive. A false *negative* would need someone
 * to read the header without it — retyping the string, or calling `headers.get` directly — which is
 * exactly what `packages/worker-kit/src/forwarded.ts` exists to stop and which nothing here now does.
 */
function trustsForwardedIdentity(relative) {
  const src = join(ROOT, relative.replace(/\/wrangler\.jsonc$/, "/src"))
  if (!existsSync(src)) return false
  return readdirSync(src, { recursive: true, withFileTypes: true }).some((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return false
    const source = readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8")
    return source.includes("readForwarded(")
  })
}

// ── Terraform emits exactly the secrets the Worker requires ────────────────────────────
//
// Two files have to agree and neither imports the other: `REQUIRED_SECRETS` in `apps/node/src/env.ts`
// is what the Worker refuses to start without, and the `worker_secrets` output in
// `infra/terraform/outputs.tf` is what the deploy actually sets (ADR-0040). Add a secret to the code
// and forget the output and every request fails after a green deploy — the Worker is up, correctly
// refusing, and nothing in the pipeline said so.
//
// Read with regexes rather than parsed, because one side is TypeScript and the other is HCL. Both
// patterns are anchored tightly enough that a miss shows up as an empty set, which fails loudly
// below rather than passing vacuously.
// ── Every service binding names a Worker that exists ──────────────────────────────────
//
// **Cloudflare rejects a deploy whose `services` binding names a script that is not there**, and the
// gateway's bindings are the only thing connecting a deployment together (ADR-0049). Finding that out
// from the API means finding it after the node and the registry have already deployed — the world is
// changed and the hostname answers nothing.
//
// It has already happened once: the gateway shipped bound to `nport-node` while the node's script is
// still `nport-node`, because the role and the script name are not the same string and the rename is
// owed. A check is cheaper than remembering.
//
// Only bindings to Workers *in this repo* are checked. A binding to somebody else's script is a thing
// wrangler supports and this cannot verify, so an unknown name that is not one of ours is left alone —
// which does mean a typo in a foreign name still reaches Cloudflare. The alternative is refusing a
// configuration the platform allows.
{
  const deployed = new Set(configs.map((relative) => loadWranglerConfig(relative).name))
  const roleNames = new Set(
    configs.map((relative) => relative.split("/")[1]).map((d) => `nport-${d}`),
  )

  for (const relative of configs) {
    const config = loadWranglerConfig(relative)
    for (const [where, block] of [
      ["top level", config],
      ...Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}`, env]),
    ]) {
      for (const binding of block.services ?? []) {
        if (deployed.has(binding.service)) continue
        // A name shaped like one of ours but deployed by nothing — `nport-node` while the script was
        // still `nport-api`, which is the case that produced this check.
        // Worth naming precisely, because "did you mean the script name rather than the role" is the
        // whole diagnosis.
        const looksLikeOurs = roleNames.has(binding.service) || binding.service.startsWith("nport-")
        if (!looksLikeOurs) continue
        console.error(
          `  ${relative} ${where}: binding \`${binding.binding}\` names service` +
            ` \`${binding.service}\`, which no wrangler.jsonc in this repo deploys. Deployed names:` +
            ` ${[...deployed].sort().join(", ")}`,
        )
        problems += 1
      }
    }
  }
}

// ── One fact in two configs: the client-version floor ──────────────────────────────────
//
// **`apps/gateway` enforces `MIN_CLIENT_VERSION`; `apps/node` publishes it on `GET /v1/meta`.** Both
// need the value and neither can read the other's config, so it is written twice — and a client
// discovers its floor from the one that does not enforce it (ADR-0037: clients discover limits rather
// than hardcoding them).
//
// If the two drift, the failure is quiet and confusing in both directions. Gateway higher than node:
// a client reads `3.0.0`, believes it qualifies, and is refused `CLIENT_TOO_OLD` by a floor it was
// never told about. Gateway lower: `/v1/meta` tells users to upgrade for no reason. Nothing else in
// the pipeline compares them, and no test can — they live in two configs, not in code.
//
// Per environment, because staging deliberately runs `0.0.0` and production `3.0.0`; what must match
// is the pair within one environment.
{
  const resolve = (relative, envName) => {
    const config = loadWranglerConfig(relative)
    const vars = envName === null ? config.vars : (config.env?.[envName]?.vars ?? {})
    return vars?.MIN_CLIENT_VERSION
  }

  const environments = [
    null,
    ...Object.keys(loadWranglerConfig("apps/gateway/wrangler.jsonc").env ?? {}),
  ]
  for (const envName of environments) {
    const where = envName === null ? "top level" : `env.${envName}`
    const gateway = resolve("apps/gateway/wrangler.jsonc", envName)
    const node = resolve("apps/node/wrangler.jsonc", envName)

    if (gateway === undefined || node === undefined) {
      console.error(
        `  ${where}: MIN_CLIENT_VERSION is missing from ${gateway === undefined ? "apps/gateway" : "apps/node"}` +
          ` — the gateway enforces it and the node publishes it, so both need it`,
      )
      problems += 1
      continue
    }
    if (gateway !== node) {
      console.error(
        `  ${where}: apps/gateway enforces MIN_CLIENT_VERSION ${gateway} and apps/node publishes` +
          ` ${node}. A client would be refused by a floor GET /v1/meta never told it about`,
      )
      problems += 1
    }
  }
}

/**
 * Each Worker's `REQUIRED_SECRETS`, keyed by the Worker name its `wrangler.jsonc` deploys as.
 *
 * **Per Worker, not unioned**, and that matters here in a way it usually does not: `apps/node` and
 * `apps/registry` both require a secret called `POW_SECRET` and the two values must *differ*
 * (ADR-0049). A union would be satisfied by Terraform emitting one `POW_SECRET`, which is precisely the
 * configuration where a challenge issued by a node is redeemable at the registry.
 *
 * It read `apps/node/src/env.ts` alone until ADR-0049, which was already wrong: `apps/registry` has
 * required its own `POW_SECRET` since it was written, and `IP_HASH_SECRET` moved to the gateway. The
 * direction that matters is an app requiring a secret the deploy never sets — the Worker comes up
 * green and refuses every request.
 *
 * A missing `REQUIRED_SECRETS` in an app that has an `env.ts` is a hard error rather than an empty
 * list: either the array was renamed or this pattern rotted, and both are worth a red deploy.
 */
function requiredSecretsByWorker() {
  const byWorker = new Map()
  for (const relative of configs) {
    const envFile = join(ROOT, relative.replace(/\/wrangler\.jsonc$/, "/src/env.ts"))
    if (!existsSync(envFile)) continue
    const source = readFileSync(envFile, "utf8")
    const block = source.match(/const REQUIRED_SECRETS = \[([\s\S]*?)\] as const/)
    if (block === null) {
      throw new Error(`${envFile}: no REQUIRED_SECRETS array — this check has rotted`)
    }
    const names = [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]).sort()
    byWorker.set(loadWranglerConfig(relative).name, names)
  }
  return byWorker
}

/**
 * The `worker_secrets` output's keys, per Worker name.
 *
 * Parsed by brace depth rather than by regex, because the output is now nested one level and a
 * `[A-Z0-9_]+ =` pattern over the whole body cannot tell which Worker a key belongs to — which is the
 * one thing this check needs to know.
 */
function terraformSecretsByWorker() {
  const source = readFileSync(join(ROOT, "infra/terraform/outputs.tf"), "utf8")
  const block = source.match(/output "worker_secrets"[\s\S]*?jsonencode\(\{([\s\S]*?)\n {2}\}\)/)
  if (block === null) {
    throw new Error("outputs.tf: no worker_secrets output — this check has rotted")
  }

  const byWorker = new Map()
  let current = null
  for (const line of block[1].split("\n")) {
    const opening = line.match(/^\s*"([a-z0-9-]+)"\s*=\s*\{/)
    if (opening) {
      current = opening[1]
      byWorker.set(current, [])
      continue
    }
    if (/^\s*\}\s*$/.test(line)) {
      current = null
      continue
    }
    const key = line.match(/^\s*([A-Z0-9_]+)\s*=/)
    if (key && current !== null) {
      byWorker.get(current).push(key[1])
    }
  }
  for (const names of byWorker.values()) names.sort()
  return byWorker
}

/**
 * The secrets the deploy workflow merges in rather than reading from Terraform, and which Worker gets
 * them.
 *
 * `CF_API_TOKEN` is the node's own Cloudflare credential. It is created by hand and delivered as a
 * GitHub secret so that nothing Terraform runs can mint Cloudflare authority (ADR-0043), which is what
 * lets the CI token stay free of `User → API Tokens → Edit`. **Only the node gets it** — the gateway
 * terminates every public request and must not be able to provision.
 *
 * Listing it here is not enough on its own: a name in this map with nothing in the workflow to supply
 * it would mean the Worker starts and refuses every request. So the workflow is checked too.
 */
const SUPPLIED_BY_WORKFLOW = { "nport-node": ["CF_API_TOKEN"] }

function workflowSuppliesSecret(name) {
  const source = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8")
  return source.includes(`secrets["${name}"]`)
}

{
  const required = requiredSecretsByWorker()
  const emitted = terraformSecretsByWorker()

  if (required.size === 0 || emitted.size === 0) {
    console.error("  could not read one of the secret lists — the patterns in this check are stale")
    problems += 1
  }

  for (const [worker, names] of required) {
    const provided = [...(emitted.get(worker) ?? []), ...(SUPPLIED_BY_WORKFLOW[worker] ?? [])]
    for (const name of names.filter((n) => !provided.includes(n))) {
      console.error(
        `  ${worker}: env.ts requires \`${name}\` and nothing in the deploy provides it`,
      )
      problems += 1
    }
    for (const name of provided.filter((n) => !names.includes(n))) {
      console.error(`  ${worker}: the deploy sets \`${name}\` and env.ts does not require it`)
      problems += 1
    }
  }

  for (const worker of [...emitted.keys()].filter((w) => !required.has(w))) {
    console.error(
      `  terraform emits secrets for \`${worker}\`, which is not a Worker in this repo — either the` +
        ` name drifted or the Worker was removed and its secrets were left behind`,
    )
    problems += 1
  }

  // **The node's `POW_SECRET` must not be the registry's.** Both require a secret of that name and the
  // whole point is that the values differ, so the check is that Terraform derives them from two
  // different resources — a single `random_password` referenced twice would satisfy every check above
  // and silently make a node's challenge redeemable at the registry (ADR-0049).
  {
    const source = readFileSync(join(ROOT, "infra/terraform/outputs.tf"), "utf8")
    const references = [...source.matchAll(/POW_SECRET\s*=\s*(random_password\.\w+)/g)].map(
      (match) => match[1],
    )
    if (references.length > 1 && new Set(references).size !== references.length) {
      console.error(
        `  both POW_SECRETs come from ${references[0]} — they must be independent values, or a` +
          ` challenge issued by a node is redeemable at the registry (ADR-0049)`,
      )
      problems += 1
    }
  }

  for (const [worker, names] of Object.entries(SUPPLIED_BY_WORKFLOW)) {
    for (const name of names.filter((n) => !workflowSuppliesSecret(n))) {
      console.error(
        `  ${worker}: \`${name}\` is listed as workflow-supplied, but deploy.yml never writes it into` +
          ` the bulk file — the Worker would deploy green and refuse every request`,
      )
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
