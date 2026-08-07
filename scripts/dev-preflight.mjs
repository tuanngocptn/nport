/**
 * Runs before `turbo run dev` and does the three things that otherwise cost a confused ten minutes.
 *
 * 1. **Creates each Worker's `.dev.vars`, or reports a stale one.** Without the secrets a Worker
 *    starts and then fails every gated route with `INTERNAL` while `/v1/health` stays green — about
 *    the least diagnosable shape a misconfiguration can take (`apps/node/src/env.ts`). The *stale*
 *    case is the one that actually happens, and it happened while writing this file. Two Workers
 *    need one now: the node and the gateway (ADR-0049).
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
import { connect } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Everything `pnpm dev` starts, in the order the banner lists them.
 *
 * **The gateway keeps 8787**, because that is the address every doc and `pnpm dev:cli` already point
 * at and it is the one a client should use — the node and the registry are behind it (ADR-0049).
 * Ports are pinned in each app's `dev` script rather than left to wrangler's default, which is 8787
 * for all three: the second and third to start would fail to bind, and `turbo run dev` starts them
 * concurrently so which two fail is a race.
 */
const SURFACES = [
  {
    name: "gateway",
    port: 8787,
    inspector: 9227,
    url: "http://localhost:8787",
    note: "wrangler dev · the front door — point clients here",
  },
  {
    name: "node",
    port: 8788,
    inspector: 9228,
    url: "http://localhost:8788",
    note: "wrangler dev · provisioning",
  },
  {
    name: "registry",
    port: 8789,
    inspector: 9229,
    url: "http://localhost:8789",
    note: "wrangler dev · the directory",
  },
  { name: "web", port: 3000, url: "http://localhost:3000", note: "next dev · the site" },
  { name: "desktop", port: 1420, url: "native window", note: "tauri dev · first build is slow" },
]

/**
 * The Workers that refuse to serve without a `.dev.vars`. **All three of them.**
 *
 * The registry was missing from this list and had no `.dev.vars.example` at all, which went unnoticed
 * because it was not in the dev stack until it was given a port. The symptom is the one this whole
 * function exists to prevent: the Worker starts, `/v1/health` answers 200, and every `/v1/nodes`
 * request fails with a logged `INTERNAL` because `POW_SECRET` is unset.
 *
 * `pnpm smoke` does not cover it either — it boots gateway and node on its own ports and never starts a
 * registry — so the whole gate stayed green. Exactly the hazard `apps/node/CLAUDE.md` records about
 * `src/cloudflare/dev-fake.ts`, one directory over.
 */
const NEEDS_DEV_VARS = ["node", "gateway", "registry"]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Is anything listening on `port`?
 *
 * **A connect, not a bind**, and both address families. Two things defeat the obvious
 * try-to-bind-it version, and this check had each of them in turn:
 *
 * - Vite listens on `[::1]` **only**, while reporting `http://localhost:1420`. A probe against
 *   `127.0.0.1` alone finds the port free while Vite is very much on it — and `strictPort` then
 *   kills the desktop task rather than shifting, so the Tauri window points at nothing.
 * - libuv sets `SO_REUSEADDR` on every TCP server it opens, so on macOS binding `127.0.0.1:3000`
 *   **succeeds** while another process holds `0.0.0.0:3000`. A bind-based check therefore reported
 *   a running Next dev server as free, which is worse than not checking: a false "free" is a
 *   warning that will not appear when it matters.
 *
 * Connecting sidesteps both. If something answers, the port is taken, whatever it bound to.
 */
async function inUse(port) {
  const reachable = (host) =>
    new Promise((resolve) => {
      const socket = connect({ port, host })
      const done = (result) => {
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(400, () => done(false))
      socket.once("connect", () => done(true))
      socket.once("error", () => done(false))
    })

  const results = await Promise.all([reachable("127.0.0.1"), reachable("::1")])
  return results.some(Boolean)
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
 * Creates `apps/node/.dev.vars`, or reports what a **stale** one is missing.
 *
 * The stale case is the one that actually bites, and it bit during this script's own development:
 * a `.dev.vars` written before `CF_*` was added to the example still exists, so nothing creates it,
 * and every gated route answers `INTERNAL` while `/v1/health` stays green. The Worker logs which
 * binding is absent — `apps/node/src/env.ts` exists for exactly this — but only once a request has
 * already failed, which is several confused minutes later than here.
 *
 * Reported rather than merged. Appending to a file holding someone's real Cloudflare token is not a
 * thing a preflight should do unasked.
 */
async function checkDevVars(app) {
  const target = join(ROOT, `apps/${app}/.dev.vars`)
  const example = join(ROOT, `apps/${app}/.dev.vars.example`)

  if (!(await exists(target))) {
    await copyFile(example, target)
    return `created apps/${app}/.dev.vars from the example — local values only, and gitignored`
  }

  const expected = keysIn(await readFile(example, "utf8"))
  const actual = keysIn(await readFile(target, "utf8"))
  const missing = [...expected].filter((name) => !actual.has(name))
  if (missing.length === 0) {
    return null
  }
  return `apps/${app}/.dev.vars is missing ${missing.join(", ")} — every gated route will answer INTERNAL until you add them from .dev.vars.example`
}

const notices = []

for (const app of NEEDS_DEV_VARS) {
  const notice = await checkDevVars(app)
  if (notice) {
    notices.push(notice)
  }
}

/**
 * **The inspector ports count, and leaving them out cost half an hour.**
 *
 * Each `wrangler dev` binds two: the service port and a devtools inspector, pinned here so three
 * concurrent sessions cannot collide on the 9229 default. A leaked `workerd` holding only an inspector
 * port produces the least helpful failure in this whole stack — the preflight reports every port free,
 * and wrangler then dies with `Address already in use (127.0.0.1:9227)` naming a port nothing told you
 * about. `workerd` outlives the `wrangler` wrapper that spawned it, so this happens whenever a dev
 * session is killed rather than stopped, which is most of the time.
 */
const busy = []
for (const surface of SURFACES) {
  const ports = [surface.port, surface.inspector].filter((port) => port !== undefined)
  const held = []
  for (const port of ports) {
    if (await inUse(port)) {
      held.push(port)
    }
  }
  if (held.length > 0) {
    busy.push({ ...surface, held })
  }
}

console.log("")
console.log("  nport · starting every surface")
console.log("")
for (const surface of SURFACES) {
  const clashing = busy.find((entry) => entry.name === surface.name)
  const clash = clashing ? `  ← in use: ${clashing.held.join(", ")}` : ""
  console.log(`    ${surface.name.padEnd(8)} ${surface.url.padEnd(24)} ${surface.note}${clash}`)
}
console.log("")
console.log("    then, in another terminal:")
console.log("      pnpm dev:cli            # tunnel the local site through the local gateway")
console.log("")
// Said here rather than discovered later: a run that ends in retries and TUNNEL_LOST reads like a
// genuine incident if you do not already know the credential is a fake.
console.log("    with FAKE_CLOUDFLARE=1 the CLI provisions for real — challenge, claim, saga, URL,")
console.log("    heartbeats — then dials Cloudflare's edge, which refuses the fake credential with")
console.log("    EDGE_REGISTRATION_REFUSED. It retries, gives up, and releases the lease. That is")
console.log("    the expected ending. For a real tunnel, put a real token in apps/node/.dev.vars.")
console.log("")
for (const notice of notices) {
  console.log(`    note: ${notice}`)
}
if (busy.length > 0) {
  console.log(
    `    note: ${busy.flatMap((surface) => surface.held).join(", ")} already in use — stop the other` +
      ` process, or that surface will fail to start. An inspector port (92xx) is usually a leaked` +
      ` \`workerd\` from a killed dev session: pkill -9 -f workerd`,
  )
}
if (notices.length > 0 || busy.length > 0) {
  console.log("")
}
