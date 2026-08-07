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
 * They are read from `apps/node/wrangler.jsonc` for the environment being verified. Hardcoding "16"
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
/**
 * Two configs, because ADR-0049 split the backend across three Workers and the hostname belongs to the
 * gateway.
 *
 * `/v1/meta` is the node's response, so its numbers come from the node's config — except
 * `MIN_CLIENT_VERSION`, which the **gateway** enforces and the node merely publishes. Reading the
 * floor from the gateway is what makes the User-Agent below the one the deployed gate will accept;
 * `pnpm deploy:check` separately holds the two configs' copies equal.
 */
const vars = varsFor(loadWranglerConfig("apps/node/wrangler.jsonc"), envName)
const gatewayVars = varsFor(loadWranglerConfig("apps/gateway/wrangler.jsonc"), envName)

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

/**
 * Every route but `/v1/health` is behind the client gate, which requires a `nport/<version>`
 * User-Agent (`apps/gateway/src/middleware/client-gate.ts`). Without one the API answers
 * `INVALID_REQUEST`, correctly — so this identifies itself like a real client or it cannot read
 * `/v1/meta` at all.
 *
 * The version sent is the **committed** minimum, not something arbitrarily high. If the deployed
 * Worker's floor is above it the gate answers `CLIENT_TOO_OLD`, and that is a genuine mismatch
 * between deployed and committed — exactly what this script exists to catch. A hardcoded
 * `999.0.0` would sail past it.
 */
const USER_AGENT = `nport/${gatewayVars.MIN_CLIENT_VERSION} (verify-deployment)`

/**
 * Retries only what waiting can fix.
 *
 * A custom domain takes a moment to route after a first deploy, so a 5xx or a connection failure is
 * worth another go. A 4xx is the Worker answering — it has an opinion, and it will have the same one
 * in ten seconds. Retrying those wasted a minute per deploy and reported `never answered: HTTP 400`,
 * which describes neither the refusal nor its cause.
 */
async function getJson(path, { attempts = 6, waitMs = 10_000 } = {}) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`, { headers: { "user-agent": USER_AGENT } })
      if (response.ok) return await response.json()

      if (response.status >= 400 && response.status < 500 && response.status !== 404) {
        const body = await response.text()
        let detail = body.slice(0, 300)
        try {
          const { error } = JSON.parse(body)
          if (error?.code) detail = `${error.code} — ${JSON.stringify(error.details ?? {})}`
        } catch {
          // Not the error envelope; the raw body above is the best available detail.
        }
        throw new Error(`${path} refused with HTTP ${response.status}: ${detail}`)
      }

      last = `HTTP ${response.status}`
    } catch (error) {
      // A refusal is a verdict, not a hiccup — do not spend the retry budget on it.
      if (error instanceof Error && error.message.includes("refused with HTTP")) throw error
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

// The gateway answers this itself and never forwards it, so a 200 proves the front door and nothing
// behind it. That is the point of checking it first: it separates "the hostname is not routed" from
// "the hostname is routed and a binding is wrong", which are different incidents.
const health = await getJson("/v1/health")
console.log(`  health: ${JSON.stringify(health)}`)

/**
 * **The first request that crosses a service binding**, and therefore the real check that the three
 * Workers are wired together (ADR-0049). A gateway deployed against a binding that does not resolve
 * answers `/v1/health` cheerfully and `INTERNAL` here.
 */
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

/**
 * The registry's half of the path space, checked only where a registry is expected to exist.
 *
 * **Whether one does is a property of the gateway's config, not of this script**: a master deployment
 * binds `REGISTRY`, a node-only deployment does not, and on the latter `/v1/nodes` is *meant* to be
 * absent rather than broken. Reading the binding list is what lets one script verify both roles.
 *
 * A `nodes` array — even an empty one — proves the request reached the registry. Before node #1 has
 * registered, empty is the correct answer and a 200 is the whole assertion.
 */
if (
  (loadWranglerConfig("apps/gateway/wrangler.jsonc").services ?? []).some(
    (s) => s.binding === "REGISTRY",
  )
) {
  const directory = await getJson("/v1/nodes")
  if (Array.isArray(directory.nodes)) {
    console.log(`  ✓ /v1/nodes reaches the registry (${directory.nodes.length} node(s) listed)`)
  } else {
    console.error(`  ✗ /v1/nodes answered without a \`nodes\` array: ${JSON.stringify(directory)}`)
    failures += 1
  }

  /**
   * **A node listed as `down` whose own `/v1/meta` just answered is a contradiction**, and it is the
   * shape defect 41 took: the registry ages an entry the node stopped renewing, while the node itself
   * serves normally. Nothing noticed for hours, because each side looks healthy on its own — you have
   * to hold both up at once, which no check did until this one.
   *
   * Only this deployment's own node is checked, by `NODE_ID`. Other operators' nodes going quiet is
   * the directory working, not our deploy failing.
   *
   * **Absence is not a failure and staleness is.** Straight after a deploy the node has not had a cron
   * tick yet, so "not listed" is the expected transient — warned about, never failed. Listed-but-`down`
   * is different: something registered it and then stopped, which no amount of waiting fixes.
   */
  const nodeId = vars.NODE_ID
  const self = Array.isArray(directory.nodes)
    ? directory.nodes.find((node) => node.id === nodeId)
    : undefined

  /**
   * **Judged on `lastSeenAt`, not on `status`.**
   *
   * `status` is derived by the registry's own cron, so it lags reality by up to one sweep interval.
   * The first run of this check found the node reporting `up` with a last registration 625 seconds
   * old — past the 600-second threshold the sweep had not got to yet. Trusting the derived field left
   * a five-minute window where the fault is present, visible in the data this very response carries,
   * and reported healthy.
   *
   * The threshold is read from `apps/registry/wrangler.jsonc` for this environment rather than written
   * here, for the reason everything else in this script is: the registry decides what stale means, and
   * a second copy is a second thing to keep in step.
   */
  const downAfterSeconds = Number(
    varsFor(loadWranglerConfig("apps/registry/wrangler.jsonc"), envName)?.NODE_DOWN_AFTER_SECONDS,
  )
  const ageSeconds = self === undefined ? 0 : Math.round((Date.now() - self.lastSeenAt) / 1000)
  const stale = Number.isFinite(downAfterSeconds) && ageSeconds > downAfterSeconds

  if (nodeId === undefined) {
    console.log(
      "  – node listing not checked: this deployment sets no NODE_ID, so it never registers",
    )
  } else if (self === undefined) {
    console.log(
      `  ! \`${nodeId}\` is not listed yet — expected right after a deploy, since registration waits` +
        ` for the next cron tick. If it is still missing in ten minutes, that is defect 41`,
    )
  } else if (stale || self.status === "down") {
    console.error(
      `  ✗ \`${nodeId}\` last registered ${ageSeconds}s ago, stale past ${downAfterSeconds}s, and the` +
        ` registry reports \`${self.status}\` — while /v1/meta answered above. This node is serving` +
        ` while it has stopped registering (docs/ROADMAP.md defect 41)`,
    )
    failures += 1
  } else {
    console.log(
      `  ✓ \`${nodeId}\` is listed and ${self.status}, last registered ${ageSeconds}s ago` +
        ` (stale past ${downAfterSeconds}s)`,
    )
  }
} else {
  console.log(
    "  – /v1/nodes not checked: this deployment binds no REGISTRY, so it has no directory",
  )
}

if (failures > 0) {
  // **Does not name a cause.** It used to end with "the deploy did not carry the configuration in the
  // repository — check that `vars` is complete", which was right when every check here compared a
  // deployed var against a committed one. The node-listing check is not about `vars` at all, and a
  // summary that confidently misdiagnoses sends an operator to read the wrong file first. The
  // individual failures above each say what they mean.
  console.error(
    `\nverify-deployment: ${failures} problem(s) — see each line above.\n\n` +
      `  A var mismatch means env.${envName}'s \`vars\` block is incomplete: wrangler marks vars as\n` +
      `  notInheritable, so an environment replaces the top-level block rather than merging with it.\n`,
  )
  process.exit(1)
}

console.log("\nverify-deployment: the deployed backend matches the committed configuration\n")
