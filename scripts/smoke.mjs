/**
 * The local end-to-end smoke test: `pnpm smoke`.
 *
 * ## Why this exists when `pnpm test` already passes
 *
 * `pnpm test` runs `apps/node` inside real `workerd`, which is a lot — but it never starts
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
 * ## Two Workers, and the client talks to the gateway
 *
 * ADR-0049 put a **gateway** in front of the node, and that is not a detail this script can skip: the
 * node declares no route, reads its caller's identity from a header the gateway sets, and **fails
 * closed without it**. Pointing the CLI at the node's port directly gets `INTERNAL`, correctly.
 *
 * So the stack is two `wrangler dev` sessions. Their service binding resolves through wrangler's dev
 * registry, which is the one part of this that no unit test can cover — `apps/gateway`'s own tests stub
 * both services, deliberately, to ask what the gateway *sends*. **This is the only place the binding
 * itself is exercised**, and a binding that does not resolve is exactly the failure a deploy produces
 * when a `service` names the wrong script name.
 *
 * ## Ports
 *
 * Its own, so it can run while `pnpm dev` is up — that stack owns 3000, 8787, 8789 and 1420, and a
 * smoke test that cannot be run without stopping your dev servers is a smoke test nobody runs.
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
import { mkdtempSync, writeFileSync } from "node:fs"
import { access, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The gateway's, and therefore the client's. Its inspector takes the port above it.
 *
 * **Clear of `pnpm dev`**, which now owns 8787–8789 for the three Workers and 9227–9229 for their
 * inspectors. A smoke test that cannot run without stopping your dev servers is a smoke test nobody
 * runs, and the collision does not announce itself: wrangler would bind, this script would talk to
 * the *dev* stack, and it would report that stack's configuration as if it were ours.
 */
const API_PORT = 8795
/** The node's. Nothing in this script sends a request here except the fails-closed check. */
const NODE_PORT = 8797
const ORIGIN_PORT = 3210
const API = `http://localhost:${API_PORT}`
const NODE = `http://localhost:${NODE_PORT}`
const ORIGIN_BODY = "nport smoke origin\n"

/**
 * A deliberately short grace period, so one heartbeat happens inside the run.
 *
 * At the deployed 120 s the beat is every 30 s and no smoke test would ever see one. Twenty seconds
 * makes it five, which is the whole reason ADR-0037's fix is checkable here at all.
 */
const GRACE_SECONDS = 20
const EXPECTED_BEAT_MS = (GRACE_SECONDS * 1000) / 4

/** Matches `.dev.vars`, which lowers the floor so a local CLI is not refused by its own gate. */
const UA = "nport/3.0.0-dev (smoke; test)"

/** Cleanup runs from here, so a failed assertion leaks no process. */
const children = []
let originServer

let failures = 0

/** Everything `wrangler dev` printed, so a mid-run death is diagnosable. */
let apiOutput = ""

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

// ── sources ───────────────────────────────────────────────────────────────────────────
//
// **A fresh source per run, or the abuse controls treat the smoke test as the abuser.** They are
// per-source and they accumulate: the hourly create quota fills up, and ADR-0028 escalates proof-of-
// work difficulty by a bit for every few creates. Reusing one address across runs therefore made
// each run slower than the last until a solve took long enough to break the run — which is the
// controls working exactly as designed, on the wrong target.
//
// Documentation ranges only: `2001:db8::/32` (RFC 3849) and `203.0.113.0/24` (TEST-NET-3).

const RUN = Math.floor(Math.random() * 0xffff)
  .toString(16)
  .padStart(4, "0")

/** A /64 nobody else has used, so the per-source cap and difficulty both start clean. */
const v6 = (host) => `2001:db8:${RUN}:1::${host}`

/**
 * A fresh IPv4 per run, for the same reason — and this half was missed the first time.
 *
 * Randomising only the v6 source left `203.0.113.200` accumulating creates across runs until the
 * escalated difficulty tripped this test's own ceiling, which looked like the server dying. One
 * address per purpose, all inside the run's own block, so no check spends another's quota.
 */
const V4_BASE = (Number.parseInt(RUN, 16) % 120) + 10
const v4 = (offset) => `203.0.113.${V4_BASE + offset}`

// ── proof of work ─────────────────────────────────────────────────────────────────────

function hasLeadingZeroBits(digest, bits) {
  const whole = Math.floor(bits / 8)
  const rest = bits % 8
  for (let index = 0; index < whole; index += 1) {
    if (digest[index] !== 0) return false
  }
  return rest === 0 || digest[whole] >>> (8 - rest) === 0
}

/**
 * The difficulty above which this stops trying.
 *
 * The deployed floor is 20 bits, ~1 s here. Anything much above that means a source has been
 * hammered and the escalation dial has moved, which for a smoke test is a bug in the test rather
 * than something to grind through — and grinding through it is what used to break the run.
 */
const MAX_SOLVABLE_BITS = 22

/**
 * Solves a challenge **without holding the event loop for the whole search**.
 *
 * A synchronous loop here is the subtle one: at the floor it finishes in about a second and looks
 * fine, and at 24 bits it blocks for a minute — during which node answers nothing, undici's
 * keep-alive socket to the server is closed underneath it, and the *next* request fails with a bare
 * `TypeError: fetch failed` that reads exactly like the server having crashed. It took a packet's
 * worth of bisecting to learn the server was healthy the whole time.
 */
async function solve(challenge, bits) {
  if (bits > MAX_SOLVABLE_BITS) {
    throw new Error(
      `difficulty is ${bits} bits, above this test's ${MAX_SOLVABLE_BITS}-bit ceiling — ` +
        "the source has been used too often, which means the run is not using a fresh one",
    )
  }
  for (let nonce = 0; ; nonce += 1) {
    const digest = createHash("sha256").update(`${challenge}.${nonce}`).digest()
    if (hasLeadingZeroBits(digest, bits)) return String(nonce)
    // Yield often enough that sockets stay alive, rarely enough that it costs nothing measurable.
    if ((nonce & 0xffff) === 0xffff) {
      await new Promise((resolve) => setImmediate(resolve))
    }
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
  return { status: response.status, json, text, bytes: text.length, headers: response.headers }
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
      nonce: await solve(challenge.json.challenge, challenge.json.difficulty),
      client: "cli",
    },
  })
}

// ── the stack ─────────────────────────────────────────────────────────────────────────

/** Whether something already answers on `port`. */
function inUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    const settle = (answer) => {
      socket.destroy()
      resolve(answer)
    }
    socket.once("connect", () => settle(true))
    socket.once("error", () => settle(false))
    setTimeout(() => settle(false), 1_000)
  })
}

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

function startNode() {
  // `wrangler dev` rather than `pnpm dev:node`, so the port is ours to choose and the output is
  // this process's to read.
  //
  // **The short grace is what makes the heartbeat observable.** `GET /v1/meta` publishes the beat
  // rate as a quarter of the grace period, and the client now reads it (ADR-0037), so a 20-second
  // grace means a beat every 5 seconds instead of every 30. That is not a test-only hook: it is the
  // production discovery path, exercised by turning the production dial.
  return track(
    spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--port",
        String(NODE_PORT),
        // **Two `wrangler dev` sessions cannot share an inspector.** It defaults to 9229 and the
        // second session fails to bind it — which surfaces as "the gateway never became healthy",
        // pointing at the wrong Worker entirely.
        "--inspector-port",
        String(NODE_PORT + 1),
        "--var",
        `HEARTBEAT_GRACE_SECONDS:${GRACE_SECONDS}`,
        // **The hourly quota is lifted, and only the hourly quota.** The CLI cannot set
        // `cf-connecting-ip`, so every run of the binary arrives as the same `"unknown"` source and
        // they accumulate: after twenty runs in an hour the CLI checks fail with
        // `CREATE_QUOTA_EXCEEDED`, which is the control working and the harness being the abuser. The
        // *concurrency* cap stays at its real value, because that is the one the IPv6 check asserts,
        // and the hourly quota has its own coverage in `test/abuse-controls.test.ts`.
        "--var",
        "MAX_CREATES_PER_HOUR_PER_SOURCE:1000",
      ],
      {
        cwd: join(ROOT, "apps", "node"),
        stdio: ["ignore", "pipe", "pipe"],
        // **Its own process group.** `pnpm exec wrangler` is three processes deep and `workerd` is
        // the one holding the port, so killing the child we spawned left that alive — every run
        // leaked one, and the next run then talked to the *previous* run's server and reported its
        // configuration instead of ours. Detaching lets the whole group be signalled at once.
        detached: true,
      },
    ),
    "wrangler dev (node)",
  )
}

/**
 * The gateway, which is what the CLI actually talks to (ADR-0049).
 *
 * **`--var MIN_CLIENT_VERSION:0.0.0`** because the version gate lives here now and the local build
 * calls itself `3.0.0-dev`, which the gate sorts *below* `3.0.0`. `apps/node/.dev.vars` used to lower
 * the floor for exactly this reason; the floor moved and the override has to move with it.
 *
 * **No `--var` for the registry.** `apps/gateway/wrangler.jsonc` binds `REGISTRY`, and wrangler's dev
 * registry resolves a missing binding to a stub that 503s rather than failing the session — so
 * `/v1/nodes` is unavailable here and nothing in this script asks for it. Booting a third Worker to
 * smoke-test a directory with nothing in it would cost a process and prove nothing.
 */
function startGateway() {
  return track(
    spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--port",
        String(API_PORT),
        "--inspector-port",
        String(API_PORT + 1),
        "--var",
        "MIN_CLIENT_VERSION:0.0.0",
        "--var",
        "IP_HASH_SECRET:smoke-ip-hash-secret-not-for-production",
      ],
      {
        cwd: join(ROOT, "apps", "gateway"),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    ),
    "wrangler dev (gateway)",
  )
}

/**
 * Waits for a `/v1/health` 200 at `base`.
 *
 * Both Workers answer it: the node's is its own, the gateway's is answered at the front door and never
 * forwarded. Waiting on **both** is what distinguishes "the gateway is not up" from "the gateway is up
 * and its binding does not resolve" — and the second is the failure this stack exists to catch.
 */
async function waitForHealth(base, deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const response = await fetch(`${base}/v1/health`)
      if (response.ok) return true
    } catch {
      // Not up yet. `wrangler dev` takes a few seconds and longer on a cold miniflare cache.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/// Whether `port` is *still* held after giving the kernel time to release it.
///
/// Three seconds is far longer than the ~100 ms observed and far shorter than anything a person waits
/// for. Returns as soon as the port frees, so the common case costs one probe.
async function stillHeld(port, deadlineMs = 3_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (!(await inUse(port))) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return await inUse(port)
}

function cleanup() {
  for (const child of children) {
    try {
      // Negative pid means the process *group*, which is the only way `workerd` goes with it.
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL")
      }
    } catch {
      child.kill("SIGKILL")
    }
  }
  originServer?.close()
}

// ── the checks ────────────────────────────────────────────────────────────────────────

async function checkPreconditions() {
  console.log("\nprecondition")
  try {
    await access(join(ROOT, "apps", "node", ".dev.vars"))
    pass("apps/node/.dev.vars exists")
    return true
  } catch {
    fail(
      "apps/node/.dev.vars is missing",
      "Run `pnpm dev` once, or copy .dev.vars.example. Without FAKE_CLOUDFLARE=1 every\n" +
        "Cloudflare call is rejected upstream and provisioning cannot succeed.",
    )
    return false
  }
}

/**
 * The two properties the split rests on, and the only place either is exercised for real (ADR-0049).
 *
 * Both are deployment properties rather than code, so no unit test can see them: the gateway's own
 * suite stubs its services, and the node's suite hands itself the header the gateway would have set.
 * What is left over is precisely this — does a request cross the binding, and does the node refuse one
 * that did not.
 */
async function checkTheGatewayIsInFront() {
  console.log("\nthe gateway")

  // `/v1/meta` is the first request that crosses the service binding. A gateway whose binding does not
  // resolve answers `/v1/health` cheerfully — it never forwards that one — and `INTERNAL` here.
  const meta = await api("/v1/meta")
  check(
    meta.status === 200,
    "GET /v1/meta crosses the service binding to the node",
    meta.status === 500
      ? `${meta.text}\n(a 500 here means the NODE binding did not resolve, not that the node is down)`
      : meta.text,
  )

  // **The node refuses a request that did not come through a gateway.** Not a hypothetical: in a
  // deployment it declares no route, so this can only happen by mistake — and serving it anyway would
  // give every direct caller one shared identity and no per-source cap would apply to any of them.
  const direct = await fetch(`${NODE}/v1/meta`, { headers: { "user-agent": UA } })
  const directBody = await direct.text()
  let code
  try {
    code = JSON.parse(directBody)?.error?.code
  } catch {
    code = undefined
  }
  check(
    direct.status === 500 && code === "INTERNAL",
    "the node fails closed for a request that skipped the gateway",
    `${direct.status} ${directBody}`,
  )

  // And the forged-header case, which is the reason the gateway overwrites rather than passes through.
  // Two callers who could both claim one hash would share one `SourceQuota` object.
  const forged = await fetch(`${API}/v1/meta`, {
    headers: { "user-agent": UA, "x-nport-source-hash": "f".repeat(64) },
  })
  check(
    forged.status === 200,
    "a forged x-nport-source-hash does not break the request (the gateway overwrites it)",
    `${forged.status} ${await forged.text()}`,
  )
}

async function checkControlPlane() {
  console.log("\ncontrol plane")
  const health = await api("/v1/health")
  check(health.status === 200, "GET /v1/health answers 200", health.text)

  const meta = await api("/v1/meta")
  check(meta.status === 200, "GET /v1/meta answers 200", meta.text)
  check(
    meta.json?.heartbeatIntervalMs === EXPECTED_BEAT_MS,
    `GET /v1/meta derives the beat from the grace (${EXPECTED_BEAT_MS} ms)`,
    meta.text,
  )
  // Clients discover limits rather than hardcoding them, so an absent field is a real regression.
  check(
    typeof meta.json?.powDifficulty === "number" && typeof meta.json?.tunnelDurationMs === "number",
    "GET /v1/meta reports the limits clients need",
    meta.text,
  )
}

async function checkRedirect() {
  console.log("\nthe root redirect")
  // v2 behaviour some users still hit by hand, and nothing else exercises it end to end.
  const response = await fetch(`${API}/`, { redirect: "manual" })
  check(response.status === 301, "GET / is a 301", String(response.status))
  check(
    response.headers.get("location") === "https://nport.link",
    "…to the site",
    response.headers.get("location") ?? "no location header",
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
  const created = await createTunnel(v4(0))
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
    ip: v4(0),
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
    results.push(await createTunnel(v6(index)))
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
/**
 * ADR-0034's input bound, **moved off the v2 shim** (ADR-0049).
 *
 * It used to POST 645 KiB at `/`, and that check had quietly stopped meaning anything: the gateway
 * routes only `/v1/*`, so `POST /` gets the front door's not-found envelope in three milliseconds
 * without any bound being consulted. Three of its four assertions passed for that reason, and the
 * fourth — "still v2's shape, so a 2.x client can read it" — failed, which is the only reason the
 * other three were looked at. A check that passes because nothing serves the path is worse than no
 * check.
 *
 * So it goes at `POST /v1/tunnels`, where the validator actually lives. The v2 shim's own version of
 * this bound is unreachable until `/` is routed again; `apps/gateway/test/legacy-gap.test.ts` is the
 * tripwire for that, and `apps/node/test/legacy.test.ts` still covers the shape when driven directly.
 *
 * The interesting assertion is the **timing**: normalization was quadratic in the input length, so a
 * 645 KiB subdomain took 12.5 seconds of CPU on one anonymous request.
 */
async function checkInputBounds() {
  console.log("\noversized input (ADR-0034)")
  const oversized = JSON.stringify({ subdomain: `a${".nport.link".repeat(60_000)}`, client: "cli" })
  const started = Date.now()
  const response = await fetch(`${API}/v1/tunnels`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: oversized,
  })
  const text = await response.text()
  const elapsed = Date.now() - started

  check(response.status === 400, "645 KiB of input is refused", String(response.status))
  check(elapsed < 3_000, `refused promptly (${elapsed} ms — quadratic was 12,500 ms)`)
  check(text.length < 4_096, `the refusal is small (${text.length} bytes, not 645 KiB)`)
  // **Refused by the node's validator, not by the gateway's router.** `INVALID_REQUEST` from a path
  // that exists is the whole point — it proves the bound ran, where a 404 would prove only that
  // nothing listens.
  let code
  try {
    code = JSON.parse(text)?.error?.code
  } catch {
    code = undefined
  }
  check(
    code === "INVALID_REQUEST",
    "refused by the contract's own bound, on a path that exists",
    text,
  )
  // No "and nothing was provisioned" assertion here: the input is refused by the validator before a
  // subdomain exists to look up, so there is no name to ask about. `apps/node/test/tunnels.test.ts`
  // covers the saga's side-effect-free refusals, where a name *is* known.
}

/**
 * A throwaway `~/.nport` for every CLI this script starts.
 *
 * **Without it, `pnpm smoke` is not a test of this repository — it is a test of the machine it runs
 * on.** `config::path` reads `NPORT_HOME` before `HOME`, so a CLI spawned with the ambient
 * environment loads the developer's real `~/.nport/config.toml`: a `lang = "es"` there turns every
 * assertion about English output red, and a `backend` there points the run at somebody else's
 * control plane. Both failures name the wrong thing — the second would look like a broken tunnel.
 *
 * It stayed hidden because CI has no home directory to leak, so the harness passed there and failed
 * only on a machine that had used the tool. `docs/TESTING.md` already records the sibling lesson
 * about a harness sharing state *between runs*; this is the same fault one level out, sharing state
 * with whoever is running it.
 *
 * Per-run rather than per-check, so a leftover directory is one directory.
 */
const CLI_HOME = mkdtempSync(join(tmpdir(), "nport-smoke-"))

/** The environment every spawned CLI gets: this process's, with its own home. */
function cliEnv(extra = {}) {
  return { ...process.env, NPORT_HOME: CLI_HOME, ...extra }
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
      env: cliEnv(),
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

  // **A real heartbeat, observed.** `core::tunnel` used to beat on a hardcoded 30 s and ignore what
  // the server published, so no run this short could ever have seen one (ADR-0037). With the rate
  // taken from `/v1/meta` the grace above makes it 5 s, and the lease's expiry is what proves the
  // server answered: a heartbeat does not extend it (defect R6), so the check is that the tunnel is
  // still *there* well past the point a missed beat would have killed it.
  const subdomain = url.replace("https://", "").replace(".nport.test", "")

  // **No assertion here about the client's beat rate, and that is deliberate.** The obvious one —
  // "is the lease still alive past its grace period?" — cannot work in this environment, and it took
  // a while to see why: the credential is fake, so the connector exhausts its retries and tears the
  // tunnel down within about twenty seconds. Any later query then returns 404 because the CLI
  // *successfully deleted its own lease*, which reads exactly like an expiry. An assertion that
  // green means "beats landed" and red means "the pool gave up" measures neither.
  //
  // Proving the client beats at the rate the server published needs a tunnel that stays up, which
  // needs a real credential — step 3 of `docs/ROADMAP.md` § The critical path. Until then the rate
  // mapping is covered by unit tests in `core::tunnel` (ADR-0037), and what *is* checkable here is
  // the endpoint itself, below.

  cli.kill("SIGINT")
  const { code } = await exited
  check(code === 0, "Ctrl+C exits 0 after a graceful shutdown", `exit code ${code}\n${stderr}`)
  check(stderr.includes("stopped"), "the shutdown is announced", stderr)

  // The lease must be gone, not merely left to expire. This is the assertion v2 could not make.
  const gone = await api(`/v1/tunnels/${subdomain}`)
  check(gone.status === 404, "the CLI released its lease on the way out", gone.text)
}

/**
 * `Retry-After` on the refusals that have a time to give — and none on the one that does not.
 *
 * `docs/API.md` promises the header, and the promise was half true: it was derived from
 * `details.retryAfter` alone, so an hourly-quota refusal went out carrying the exact instant it frees
 * up **in the body** and no header at all. The header is the field standard tooling reads.
 */
async function checkRetryAfter() {
  console.log("\nRetry-After")

  // The concurrency cap: three tunnels, then a refusal that must carry no header.
  const ip = v4(2)
  const limit = 3
  for (let index = 0; index < limit; index += 1) {
    const created = await createTunnel(ip)
    if (created.status !== 201) {
      fail(`could not fill the concurrency cap (create ${index})`, created.text)
      return
    }
  }
  const concurrency = await createTunnel(ip)
  check(
    concurrency.status === 429 && concurrency.json?.error?.code === "CONCURRENCY_LIMIT",
    "a source at its cap is refused",
    concurrency.text,
  )
  check(
    concurrency.headers.get("retry-after") === null,
    "…with no Retry-After, because waiting does not help — closing a tunnel does",
    String(concurrency.headers.get("retry-after")),
  )
}

/**
 * The heartbeat endpoint, driven directly.
 *
 * Distinct from "does the client beat at the right rate", which this environment cannot show. What it
 * does show is the contract the client depends on: a heartbeat is accepted, and it **does not extend
 * the lease** — the server owns `expiresAt` and liveness is not renewal, which is defect R6 and the
 * reason invariant 3 exists.
 */
async function checkHeartbeatEndpoint() {
  console.log("\nthe heartbeat endpoint")
  const created = await createTunnel(v4(1))
  if (created.status !== 201) {
    fail("could not provision a tunnel to beat against", created.text)
    return
  }
  const { subdomain, ownerToken, expiresAt } = created.json

  const beat = await api(`/v1/tunnels/${subdomain}/heartbeat`, {
    method: "POST",
    ip: v4(1),
    body: { ownerToken },
  })
  check(beat.status === 200, "a heartbeat is accepted", beat.text)
  check(
    beat.json?.expiresAt === expiresAt,
    "and does not extend the lease — the server owns the ceiling (defect R6)",
    `${beat.json?.expiresAt} vs ${expiresAt}`,
  )

  const wrongToken = await api(`/v1/tunnels/${subdomain}/heartbeat`, {
    method: "POST",
    ip: v4(1),
    body: { ownerToken: "A".repeat(43) },
  })
  check(
    wrongToken.status === 403 && wrongToken.json?.error?.code === "INVALID_OWNER_TOKEN",
    "a heartbeat from the wrong holder is refused",
    wrongToken.text,
  )

  await api(`/v1/tunnels/${subdomain}`, { method: "DELETE", ip: v4(1), body: { ownerToken } })
}

/**
 * A broken `~/.nport/config.toml` is reported clearly, and in the user's language.
 *
 * `NPORT_HOME` is a real seam in `config::path`, so this needs no access to the developer's own
 * config. The language assertion is the one that matters: the config failure used to print
 * `thiserror`'s English Display, because it happened before the language was resolved — defect R20's
 * shape, on the one path where a user is already puzzled.
 */
async function checkConfigErrors() {
  console.log("\nthe config file")
  const home = join(ROOT, "node_modules", ".cache", "nport-smoke-home")
  await mkdir(join(home, ".nport"), { recursive: true })
  const file = join(home, ".nport", "config.toml")

  const run = (contents, extra) =>
    new Promise((resolve) => {
      writeFileSync(file, contents)
      const cli = spawn("cargo", ["run", "-q", "-p", "nport", "--", "3000", ...extra], {
        cwd: ROOT,
        // Its own home, because these checks write configs to read back.
        env: cliEnv({ NPORT_HOME: home }),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      cli.stderr.on("data", (chunk) => {
        stderr += chunk
      })
      cli.on("exit", (code) => resolve({ code, stderr }))
      cli.on("error", () => resolve({ code: -1, stderr: "spawn failed" }))
    })

  const typo = await run("porrt = 3000\n", [])
  check(typo.code === 1, "a typo in the config is fatal, not a silent default", String(typo.code))
  check(typo.stderr.includes("CONFIG_UNREADABLE"), "…and carries its registry code", typo.stderr)
  // The detail is what makes it actionable, and `deny_unknown_fields` is what produces it.
  check(
    typo.stderr.includes("expected one of") && typo.stderr.includes("porrt"),
    "…and names the offending key and the valid ones",
    typo.stderr,
  )

  const spanish = await run("porrt = 3000\n", ["--lang", "es"])
  check(
    spanish.stderr.includes("no se pudo leer"),
    "the failure is reported in the requested language",
    spanish.stderr,
  )

  // A file that parses must not be fatal — the fatal path is for files that cannot be used.
  const valid = await run('lang = "es"\n', [])
  check(
    !valid.stderr.includes("CONFIG_UNREADABLE"),
    "a valid config is not reported as broken",
    valid.stderr,
  )
}

/** `--quiet` is the scripting contract, and it is one line or it is broken. */
async function checkQuiet() {
  console.log("\nthe nport binary, --quiet")
  const cli = track(
    spawn(
      "cargo",
      ["run", "-q", "-p", "nport", "--", String(ORIGIN_PORT), "--quiet", "--backend", API],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: cliEnv() },
    ),
    "nport --quiet",
  )

  let stdout = ""
  cli.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  const exited = new Promise((resolve) => cli.on("exit", () => resolve()))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !stdout.includes("https://")) {
    if (cli.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  check(
    /^https:\/\/nport-[a-z2-7]{13}\.nport\.test\n$/.test(stdout),
    "stdout is exactly one URL and a newline",
    JSON.stringify(stdout),
  )

  cli.kill("SIGINT")
  await exited
}

// ── run ───────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("nport smoke test — local stack, fake Cloudflare, real everything else")

  if (!(await checkPreconditions())) return

  await startOrigin()

  // **The node first.** The gateway's `services` binding resolves through wrangler's dev registry,
  // and a session that starts before its target is registered has to re-resolve. Starting in
  // dependency order is the same order the deploy uses, for the same reason.
  const node = startNode()
  const gateway = startGateway()

  // Kept so a death mid-run reports what a server said rather than `TypeError: fetch failed`. Both,
  // labelled, because "which of the two died" is the first question.
  for (const [name, child] of [
    ["node", node],
    ["gateway", gateway],
  ]) {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        apiOutput += `[${name}] ${chunk}`
      })
    }
  }

  // The tail of both Workers' output, because "never became healthy" on its own names a symptom and
  // the cause is always in what wrangler printed — a port already held, a binding that would not
  // resolve, a config error. Reporting one without the other sent this on a long detour once.
  for (const [what, base] of [
    ["node", NODE],
    ["gateway", API],
  ]) {
    if (!(await waitForHealth(base))) {
      fail(
        `the ${what} never became healthy`,
        `no 200 from ${base}/v1/health within 90 s\n\n--- the Workers said ---\n${apiOutput.slice(-3_000)}`,
      )
      return
    }
  }

  await checkTheGatewayIsInFront()
  await checkControlPlane()
  await checkRedirect()
  await checkProvisioning()
  await checkIpv6Cap()
  await checkInputBounds()
  await checkRetryAfter()
  await checkHeartbeatEndpoint()
  await checkCli()
  await checkQuiet()
  await checkConfigErrors()
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
  fail(
    "the smoke test threw",
    `${error?.stack ?? String(error)}\n\n--- the Workers said ---\n${apiOutput.slice(-4_000)}`,
  )
} finally {
  cleanup()
}

// A leaked `workerd` makes the *next* run measure the wrong server, and the port guard above turns
// that into a clear refusal — but saying so here is what connects the two.
//
// **Waited for, not sampled once.** `cleanup()` sends SIGKILL and the kernel then reaps the group and
// releases the listening socket, which does not happen in the same tick. Checking immediately reported
// a leak on *every* run — the port is free about a tenth of a second later — so the warning was noise,
// and a genuine leak looked exactly like it. A check that fires when nothing is wrong cannot tell you
// when something is.
for (const port of [API_PORT, NODE_PORT]) {
  if (await stillHeld(port)) {
    console.log(
      `\nwarning: something still holds port ${port}. Stop it before the next run:\n` +
        `  lsof -ti:${port} | xargs kill -9`,
    )
  }
}

console.log(
  failures === 0
    ? "\nsmoke: everything the local stack can prove, proved\n"
    : `\nsmoke: ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
