/**
 * Runs before `turbo run dev` and does the three things that otherwise cost a confused ten minutes.
 *
 * 1. **Creates `apps/api/.dev.vars`, or reports a stale one.** Without the secrets the Worker starts
 *    and then fails every gated route with `INTERNAL` while `/v1/health` stays green — about the
 *    least diagnosable shape a misconfiguration can take (`apps/api/src/env.ts`). The *stale* case
 *    is the one that actually happens, and it happened while writing this file.
 * 2. **Says which ports are already in use** rather than letting each dev server fail differently.
 *    Vite is the sharp one: `strictPort` means it exits, and the Tauri window then points at
 *    nothing.
 * 3. **Prints what is starting and what to do next.** Four surfaces come up at once and none of
 *    them announces the others.
 *
 * It never fails the run. A preflight that refuses to start the stack over a warning is a preflight
 * people route around with `turbo run dev` — and then they lose the warnings entirely.
 */

import { access, copyFile, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Everything `pnpm dev` starts, in the order the banner lists them. */
const SURFACES = [
  { name: "api", port: 8787, url: "http://localhost:8787", note: "wrangler dev · control plane" },
  { name: "web", port: 3000, url: "http://localhost:3000", note: "next dev · the site" },
  { name: "desktop", port: 1420, url: "native window", note: "tauri dev · first build is slow" },
]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Is anything listening on `port`? A bind, not a connect — nothing is meant to be up yet. */
function inUse(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(true))
    server.once("listening", () => server.close(() => resolve(false)))
    server.listen(port, "127.0.0.1")
  })
}

/** The `NAME=` keys a dotenv-style file declares, ignoring comments and blank lines. */
function keysIn(text) {
  return new Set(
    text
      .split("\n")
      .map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1])
      .filter((name) => name !== undefined),
  )
}

/**
 * Creates `apps/api/.dev.vars`, or reports what a **stale** one is missing.
 *
 * The stale case is the one that actually bites, and it bit during this script's own development:
 * a `.dev.vars` written before `CF_*` was added to the example still exists, so nothing creates it,
 * and every gated route answers `INTERNAL` while `/v1/health` stays green. The Worker logs which
 * binding is absent — `apps/api/src/env.ts` exists for exactly this — but only once a request has
 * already failed, which is several confused minutes later than here.
 *
 * Reported rather than merged. Appending to a file holding someone's real Cloudflare token is not a
 * thing a preflight should do unasked.
 */
async function checkDevVars() {
  const target = join(ROOT, "apps/api/.dev.vars")
  const example = join(ROOT, "apps/api/.dev.vars.example")

  if (!(await exists(target))) {
    await copyFile(example, target)
    return "created apps/api/.dev.vars from the example — local values only, and gitignored"
  }

  const expected = keysIn(await readFile(example, "utf8"))
  const actual = keysIn(await readFile(target, "utf8"))
  const missing = [...expected].filter((name) => !actual.has(name))
  if (missing.length === 0) {
    return null
  }
  return `apps/api/.dev.vars is missing ${missing.join(", ")} — every gated route will answer INTERNAL until you add them from .dev.vars.example`
}

const notices = []

const devVars = await checkDevVars()
if (devVars) {
  notices.push(devVars)
}

const busy = []
for (const surface of SURFACES) {
  if (await inUse(surface.port)) {
    busy.push(surface)
  }
}

console.log("")
console.log("  nport · starting every surface")
console.log("")
for (const surface of SURFACES) {
  const clash = busy.includes(surface) ? "  ← port already in use" : ""
  console.log(`    ${surface.name.padEnd(8)} ${surface.url.padEnd(24)} ${surface.note}${clash}`)
}
console.log("")
console.log("    then, in another terminal:")
console.log("      pnpm dev:cli            # tunnel the local site through the local control plane")
console.log("")
// Said here rather than discovered later. With FAKE_CLOUDFLARE the CLI provisions for real and
// then cannot connect, and the code it prints — EDGE_PROTOCOL_ERROR, "please upgrade, then report
// it" — reads like a genuine incident if you do not already know why.
console.log("    with FAKE_CLOUDFLARE=1 the CLI provisions for real (challenge, claim, saga, URL)")
console.log("    and then stops at EDGE_PROTOCOL_ERROR: the token is a fake, so no QUIC session")
console.log("    can open. Put a real Cloudflare token in apps/api/.dev.vars for an actual tunnel.")
console.log("")
for (const notice of notices) {
  console.log(`    note: ${notice}`)
}
if (busy.length > 0) {
  console.log(
    `    note: ${busy.map((s) => s.port).join(", ")} already in use — stop the other process, or that surface will fail to start`,
  )
}
if (notices.length > 0 || busy.length > 0) {
  console.log("")
}
