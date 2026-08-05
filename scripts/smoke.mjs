/**
 * The local end-to-end smoke test: `pnpm smoke`.
 *
 * ## Why this exists when `pnpm test` already passes
 *
 * `pnpm test` runs `apps/api` inside real `workerd`, which is a lot — but it never starts
 * `wrangler dev`, never runs the `nport` binary, and never touches `src/cloudflare/dev-fake.ts`.
 * Three things therefore had **no coverage at all** until this script:
 *
 * 1. **The dev fake.** `test/fake-cloudflare.ts` is a different file with a different shape. A
 *    change to the dev fake could break `pnpm dev` for everyone while the whole gate stayed green
 *    — which is exactly what nearly happened when the connector token moved to its own endpoint
 *    (ADR-0032).
 * 2. **The CLI as a process.** Argument parsing, the banner on stdout, signal handling, and the
 *    exit code are properties of a binary, not of a library, and `cargo test` drives the library.
 * 3. **The seam between them.** Proof of work, the claim, the saga, the URL, the heartbeat and the
 *    release only line up in one direction when a real client talks to a real Worker.
 *
 * ## What it deliberately does not cover
 *
 * **The credential is fake, so the edge refuses registration — on purpose.** That is the honest
 * boundary: everything up to and including the lease is real, and the QUIC dial to Cloudflare's
 * actual edge genuinely happens and is genuinely refused. So this exercises the retry ladder and
 * the release, and it cannot exercise a tunnel that carries traffic. Only a deployed control plane
 * can (`docs/ROADMAP.md` § The critical path, steps 1–3).
 *
 * This is *not* `.github/workflows/smoke.yml`, which is Phase 3: published artifacts, real tunnels,
 * six operating systems, nightly. That one needs a deployment. This one needs nothing.
 *
 * ## Ports
 *
 * Its own, so it can run while `pnpm dev` is up — that stack owns 3000, 8787 and 1420, and a smoke
 * test that cannot be run without stopping your dev servers is a smoke test nobody runs.
 *
 * ## Names
 *
 * **Generated, never `smoke-anything`.** `smoke-` is a reserved prefix, so a claim for it is a `403`
 * — which is how writing this found that `docs/TESTING.md`'s plan for `smoke.yml` could not work
 * (ADR-0036). Asking for no subdomain gets `nport-<base32>`: unguessable, recognisably ours, and now
 * reapable by the sweep.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const API_PORT = 8788
const ORIGIN_PORT = 3210
const API = `http://localhost:${API_PORT}`
const ORIGIN_BODY = "nport smoke origin\n"

/** Matches `.dev.vars`, which lowers the floor so a local CLI is not refused by its own gate. */
const UA = "nport/3.0.0-dev (smoke; test)"

/** Cleanup runs from here, so a failed assertion leaks no process. */
const children = []
let originServer

let failures = 0

function pass(what) {
  console.log(`  ✓ ${what}`)
}

function fail(what, detail) {
  failures += 1
  console.log(`  ✗ ${what}`)
  if (detail !== undefined) {
    console.log(`    ${String(detail).split("\n").join("\n    ")}`)
  }
}

function check(condition, what, detail) {
  if (condition) {
    pass(what)
  } else {
    fail(what, detail)
  }
}

// ── proof of work ─────────────────────────────────────────────────────────────────────
//
// Solved for real at the deployed difficulty rather than lowered, because the point of an
// end-to-end test is that the parts agree — and a 20-bit solve is about a second here.

function hasLeadingZeroBits(digest, bits) {
  const whole = Math.floor(bits / 8)
  const rest = bits % 8
  for (let index = 0; index < whole; index += 1) {
    if (digest[index] !== 0) return false
  }
  return rest === 0 || digest[whole] >>> (8 - rest) === 0
}

function solve(challenge, bits) {
  for (let nonce = 0; ; nonce += 1) {
    const digest = createHash("sha256").update(`${challenge}.${nonce}`).digest()
    if (hasLeadingZeroBits(digest, bits)) return String(nonce)
  }
}

async function api(path, { method = "GET", body, ip } = {}) {
  const headers = { "user-agent": UA }
  if (ip !== undefined) headers["cf-connecting-ip"] = ip
  if (body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text, bytes: text.length }
}

/** `subdomain` omitted means "generate one", which is both the default path and the only one a
 * smoke test may use — see the note on names above. */
async function createTunnel(ip, subdomain) {
  const challenge = await api("/v1/challenge", { ip })
  if (challenge.status !== 200) {
    return { status: challenge.status, json: challenge.json }
  }
  return api("/v1/tunnels", {
    method: "POST",
    ip,
    body: {
      ...(subdomain === undefined ? {} : { subdomain }),
      challenge: challenge.json.challenge,
      nonce: solve(challenge.json.challenge, challenge.json.difficulty),
      client: "cli",
    },
  })
}

// ── the stack ─────────────────────────────────────────────────────────────────────────

function track(child, name) {
  child.on("error", (error) => {
    fail(`${name} could not start`, error.message)
  })
  children.push(child)
  return child
}

async function startOrigin() {
  originServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" })
    response.end(ORIGIN_BODY)
  })
  await new Promise((resolve) => originServer.listen(ORIGIN_PORT, "127.0.0.1", resolve))
}

function startApi() {
  // `wrangler dev` rather than `pnpm dev:api`, so the port is ours to choose and the output is
  // this process's to read.
  return track(
    spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(API_PORT)], {
      cwd: join(ROOT, "apps", "api"),
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "wrangler dev",
  )
}

async function waitForHealth(deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const response = await fetch(`${API}/v1/health`)
      if (response.ok) return true
    } catch {
      // Not up yet. `wrangler dev` takes a few seconds and longer on a cold miniflare cache.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function cleanup() {
  for (const child of children) {
    child.kill("SIGKILL")
  }
  originServer?.close()
}

// ── the checks ────────────────────────────────────────────────────────────────────────

async function checkPreconditions() {
  console.log("\nprecondition")
  try {
    await access(join(ROOT, "apps", "api", ".dev.vars"))
    pass("apps/api/.dev.vars exists")
    return true
  } catch {
    fail(
      "apps/api/.dev.vars is missing",
      "Run `pnpm dev` once, or copy .dev.vars.example. Without FAKE_CLOUDFLARE=1 every\n" +
        "Cloudflare call is rejected upstream and provisioning cannot succeed.",
    )
    return false
  }
}

async function checkControlPlane() {
  console.log("\ncontrol plane")
  const health = await api("/v1/health")
  check(health.status === 200, "GET /v1/health answers 200", health.text)

  const meta = await api("/v1/meta")
  check(meta.status === 200, "GET /v1/meta answers 200", meta.text)
  // Clients discover limits rather than hardcoding them, so an absent field is a real regression.
  check(
    typeof meta.json?.powDifficulty === "number" && typeof meta.json?.tunnelDurationMs === "number",
    "GET /v1/meta reports the limits clients need",
    meta.text,
  )
}

/**
 * The one that would have caught the dev fake breaking.
 *
 * A `201` here means proof of work, the claim, the journaled saga, the tunnel, the DNS record and
 * **both shapes of the connector-token fetch** (ADR-0032) all worked through the real Worker.
 */
async function checkProvisioning() {
  console.log("\nprovisioning through the dev fake")
  const created = await createTunnel("203.0.113.200")
  check(created.status === 201, "POST /v1/tunnels answers 201", created.text)
  if (created.status !== 201) return

  const body = created.json
  check(typeof body.tunnelToken === "string" && body.tunnelToken.length > 0, "a token was issued")
  check(/^[A-Za-z0-9_-]{43}$/.test(body.ownerToken ?? ""), "an ownerToken was issued")
  // 64 bits of base32, against v2's 10,000-name space (defect R2).
  check(
    /^nport-[a-z2-7]{13}$/.test(body.subdomain ?? ""),
    "the generated name is unguessable",
    body.subdomain,
  )
  check(
    body.url === `https://${body.subdomain}.nport.test`,
    "the URL is built from the zone",
    body.url,
  )

  const released = await api(`/v1/tunnels/${body.subdomain}`, {
    method: "DELETE",
    ip: "203.0.113.200",
    body: { ownerToken: body.ownerToken },
  })
  check(released.status === 204, "DELETE /v1/tunnels/:subdomain answers 204", released.text)

  const gone = await api(`/v1/tunnels/${body.subdomain}`)
  check(gone.status === 404, "the name is free afterwards", gone.text)
}

/** ADR-0033. Before the fix all four succeeded, because each address was its own identity. */
async function checkIpv6Cap() {
  console.log("\nper-source cap over IPv6 (ADR-0033)")
  const results = []
  for (let index = 1; index <= 4; index += 1) {
    results.push(await createTunnel(`2001:db8:aaaa:bbbb::${index}`))
  }
  const [first, second, third, fourth] = results
  check(
    [first, second, third].every((r) => r.status === 201),
    "three tunnels from one /64 are allowed",
    results.map((r) => r.status).join(","),
  )
  check(
    fourth.status === 429 && fourth.json?.error?.code === "CONCURRENCY_LIMIT",
    "the fourth from the same /64 is refused — the prefix is the identity",
    fourth.text,
  )
}

/** ADR-0034. Before the fix this was 12.5 s of CPU and echoed the whole payload back. */
async function checkInputBounds() {
  console.log("\noversized input on the v2 shim (ADR-0034)")
  const oversized = JSON.stringify({ subdomain: `a${".nport.link".repeat(60_000)}` })
  const started = Date.now()
  const response = await fetch(`${API}/`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "nport/2.1.0" },
    body: oversized,
  })
  const text = await response.text()
  const elapsed = Date.now() - started

  check(response.status === 400, "645 KiB of input is refused", String(response.status))
  check(elapsed < 3_000, `refused promptly (${elapsed} ms — quadratic was 12,500 ms)`)
  check(text.length < 4_096, `the refusal is small (${text.length} bytes, not 645 KiB)`)
  check(
    text.includes("SUBDOMAIN_PROTECTED:"),
    "still v2's shape, so a 2.x client can read it",
    text,
  )
}

/**
 * The CLI as a process, which no other tier runs.
 *
 * Stopped with `SIGINT` rather than left to time out, because the graceful path is the one with the
 * defects: v2's signal handler never awaited its cleanup, so the lease leaked (defect R19).
 */
async function checkCli() {
  console.log("\nthe nport binary")
  const cli = track(
    spawn("cargo", ["run", "-q", "-p", "nport", "--", String(ORIGIN_PORT), "--backend", API], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "nport",
  )

  let stdout = ""
  let stderr = ""
  cli.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  cli.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  const exited = new Promise((resolve) =>
    cli.on("exit", (code, signal) => resolve({ code, signal })),
  )

  // Long enough to provision and print, short enough not to dominate the run. The first build is
  // the slow part, and `cargo run -q` is a no-op once warm.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !stdout.includes("https://")) {
    if (cli.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // **stdout carries the URL and nothing else**, so `URL=$(nport 3000 --quiet)` works.
  const url = stdout.trim()
  check(
    /^https:\/\/nport-[a-z2-7]{13}\.nport\.test$/.test(url),
    "the URL goes to stdout, alone",
    `stdout: ${JSON.stringify(stdout)}`,
  )
  check(
    stderr.includes(`forwarding to http://localhost:${ORIGIN_PORT}`),
    "progress goes to stderr",
    stderr,
  )

  cli.kill("SIGINT")
  const { code } = await exited
  check(code === 0, "Ctrl+C exits 0 after a graceful shutdown", `exit code ${code}\n${stderr}`)
  check(stderr.includes("stopped"), "the shutdown is announced", stderr)

  // The lease must be gone, not merely left to expire. This is the assertion v2 could not make.
  const subdomain = url.replace("https://", "").replace(".nport.test", "")
  const gone = await api(`/v1/tunnels/${subdomain}`)
  check(gone.status === 404, "the CLI released its lease on the way out", gone.text)
}

// ── run ───────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("nport smoke test — local stack, fake Cloudflare, real everything else")

  if (!(await checkPreconditions())) return

  await startOrigin()
  startApi()

  if (!(await waitForHealth())) {
    fail("wrangler dev never became healthy", `no 200 from ${API}/v1/health within 90 s`)
    return
  }

  await checkControlPlane()
  await checkProvisioning()
  await checkIpv6Cap()
  await checkInputBounds()
  await checkCli()
}

// Cleanup from a handler rather than after `main`, so an exception or a Ctrl+C still stops the
// children — `docs/TESTING.md` asks for exactly this discipline of the live tier, and a smoke test
// that leaks a `wrangler dev` is worse than one that does not exist.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
}

try {
  await main()
} catch (error) {
  fail("the smoke test threw", error?.stack ?? String(error))
} finally {
  cleanup()
}

console.log(
  failures === 0
    ? "\nsmoke: everything the local stack can prove, proved\n"
    : `\nsmoke: ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
