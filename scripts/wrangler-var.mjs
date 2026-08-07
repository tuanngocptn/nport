/**
 * Prints one resolved `vars` value from an app's `wrangler.jsonc`, for a shell to read.
 *
 *   node scripts/wrangler-var.mjs --app node --env staging --var NODE_ID
 *
 * ## Why this exists
 *
 * **So that a value defined in `wrangler.jsonc` reaches Terraform without being typed a second time.**
 *
 * `infra/terraform` publishes the `_nport-node` TXT record that proves a zone to the node directory,
 * and the record's content is `nport-node=<NODE_ID>` — where `NODE_ID` is a `vars` entry the node
 * Worker also reads at runtime to register itself. If those two disagree the proof names one node and
 * the registration another, the registry refuses `proof-missing`, and the node swallows the failure by
 * design: an empty directory and a log line nobody is reading. That is not a hypothetical, it is what
 * staging did on its first deploy of ADR-0049's design.
 *
 * A third home for the value — a workflow input, a `.tfvars` committed alongside — would be a third
 * thing to keep in step. Reading the one that already exists is cheaper than checking three.
 *
 * `pnpm deploy:check` separately holds Terraform's *format string* equal to the contract's, so the
 * pieces cannot drift either: this script carries the value, that check carries the shape.
 *
 * Exits non-zero with a message on stderr if the var is absent, because a shell substituting an empty
 * string into `-var "node_id="` would fail Terraform's own validation several steps later with an
 * error about a regex rather than about a missing key.
 */

import { loadWranglerConfig, varsFor } from "./lib/wrangler-config.mjs"

function argOf(name) {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const app = argOf("app")
const envName = argOf("env")
const name = argOf("var")

if (app === undefined || name === undefined) {
  console.error("usage: wrangler-var.mjs --app <dir> --var <NAME> [--env <wrangler env>]")
  process.exit(2)
}

const relative = `apps/${app}/wrangler.jsonc`
const vars = varsFor(loadWranglerConfig(relative), envName)
const value = vars?.[name]

if (value === undefined || value === "") {
  console.error(
    `${relative}${envName ? ` env.${envName}` : ""}: no \`${name}\` in vars.` +
      ` Wrangler marks vars as notInheritable, so an environment block replaces the top-level one` +
      ` rather than merging — check that env.${envName} lists it too.`,
  )
  process.exit(1)
}

process.stdout.write(String(value))
