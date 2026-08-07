/**
 * Asserts the **deployed** site serves what it built.
 *
 *   node scripts/verify-site.mjs --host nport.online
 *
 * ## Why this exists
 *
 * `pnpm test:e2e` already drives the built Worker under `preview` and checks far more than this does
 * (ADR-0048). It runs on a runner, against a build made three minutes ago, on localhost. This runs
 * against the artifact that deployed, on the hostname users type — one layer further out, and the
 * only layer that has ever actually broken.
 *
 * It has broken exactly this way once: **all 33 `/errors/<slug>` pages returned 404 from the Worker**
 * while `next build` prerendered every one of them and the unit tests passed. What made that survive
 * was that the home page was fine, and the home page was all anything checked. The deploy pipeline's
 * site check was `curl /` until this file replaced it.
 *
 * ## What it checks, and why each one
 *
 * - **Every error slug**, read from `schema/errors.json` rather than listed here. A code added to the
 *   contract without a page is a 404 handed to somebody already debugging, and `apps/node` puts that
 *   URL in the error envelope itself. Reading the registry is also what keeps this file from becoming
 *   the sixth instance of the repo's recurring defect: a document asserting a set it does not own.
 * - **`/docs/cli`**, the optional catch-all, which additionally proves `schema/cli.json` survived the
 *   build — the page renders from it.
 * - **`/sitemap.xml`**, a generated non-HTML route.
 * - **One slug that must 404.** This is the check that gives the others meaning. A Worker misrouted to
 *   serve a single fallback document answers 200 for every path above, so a run with no negative
 *   proves only that something is listening. `errors.spec.ts` asserts the same property for the same
 *   reason.
 *
 * Deliberately *not* here: JSON-LD, canonicals, the OpenGraph bytes, the flag table matching the
 * binary. Those are `web-e2e`'s, they run on every push rather than on deploys, and duplicating them
 * would mean two places to update when the site changes.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const host = argOf("host")
if (host === undefined) {
  console.error("usage: verify-site.mjs --host <hostname>")
  process.exit(2)
}

const origin = host.startsWith("http") ? host : `https://${host}`

/** @type {Record<string, {slug: string}>} */
const errors = JSON.parse(readFileSync(join(root, "schema/errors.json"), "utf8")).errors
const slugs = Object.values(errors).map((entry) => entry.slug)

if (slugs.length === 0) {
  console.error("schema/errors.json listed no codes — the registry cannot be empty")
  process.exit(1)
}

/** Paths that must answer 200, and what a failure on each one would mean. */
const mustServe = [
  ["/", "the app does not boot"],
  ...slugs.map((slug) => [`/errors/${slug}`, "a prerendered error page did not reach the assets"]),
  ["/docs/cli", "the docs catch-all, or schema/cli.json, did not survive the build"],
  ["/sitemap.xml", "a generated non-HTML route is missing"],
]

/**
 * A slug that names no code. Suffixed rather than invented so it cannot collide with a real one added
 * later — `not-a-real-code` would be a genuine slug the day someone adds `NOT_A_REAL_CODE`.
 */
const mustNotServe = "/errors/zzz-nport-verify-site-no-such-code"

async function status(path) {
  try {
    // `redirect: "manual"` so a 301 to a page that then 404s cannot pass as a 200. The site does
    // redirect www → apex, and following that quietly would test a hostname nobody asked about.
    const response = await fetch(`${origin}${path}`, { redirect: "manual" })
    return response.status
  } catch (cause) {
    return `unreachable (${cause instanceof Error ? cause.message : cause})`
  }
}

let failed = 0
const width = Math.max(...mustServe.map(([path]) => path.length), mustNotServe.length)

for (const [path, meaning] of mustServe) {
  const code = await status(path)
  const ok = code === 200
  if (!ok) failed++
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${path.padEnd(width)} ${code}${ok ? "" : `  — ${meaning}`}`,
  )
}

const negative = await status(mustNotServe)
const negativeOk = negative === 404
if (!negativeOk) failed++
console.log(
  `  ${negativeOk ? "ok  " : "FAIL"} ${mustNotServe.padEnd(width)} ${negative}` +
    `${negativeOk ? "  (404, as it must be)" : "  — want 404; a 200 here means the checks above proved nothing"}`,
)

console.log(
  `\n${mustServe.length + 1} routes checked on ${origin} ` +
    `(${slugs.length} error pages, from schema/errors.json)`,
)

if (failed > 0) {
  console.error(`\n${failed} route(s) are not serving what the repository built`)
  process.exit(1)
}
