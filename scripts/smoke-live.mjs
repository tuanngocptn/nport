#!/usr/bin/env node
/**
 * The end-to-end smoke test against a **deployed** control plane: `pnpm smoke:live`.
 *
 *   node scripts/smoke-live.mjs --backend https://api.nport.online
 *
 * ## How this differs from `pnpm smoke`
 *
 * `scripts/smoke.mjs` runs the whole stack locally against `wrangler dev` with a fake Cloudflare.
 * It proves the seam between client and control plane, and it deliberately **cannot** prove a tunnel
 * that carries traffic, because the credential it gets back is not real. This one starts where that
 * one stops: a real lease, a real Cloudflare tunnel, a real QUIC connection to the edge, and real
 * requests arriving from the public internet.
 *
 * They are separate files rather than one with a flag because almost nothing carries over. The local
 * test spoofs `cf-connecting-ip` to exercise per-source caps, solves a deliberately cheap proof of
 * work, and asserts on internals; none of that is available or appropriate here, where every request
 * costs real quota and the source address is whatever the runner has.
 *
 * ## What it proves, and what it cannot
 *
 * Gate G2 (`docs/ROADMAP.md`) wants macOS, Linux and Windows, plus WebSocket and server-enforced
 * expiry. This covers the first four on whichever OS it runs on. **Expiry is not here**: the lease is
 * an hour long, and a smoke test that takes an hour is a smoke test nobody runs. It is checked
 * separately (`docs/TESTING.md`).
 *
 * **Graceful shutdown is POSIX-only.** Windows has no `SIGINT` to send a child process; Node's
 * `child.kill()` there is a terminate, not a Ctrl+C, so the drain path cannot be exercised the way a
 * user would exercise it. The run says so rather than quietly asserting something weaker.
 *
 * ## Names and quota
 *
 * **No `-s`, ever.** `smoke-` is a reserved prefix and a claim for it is a 403 (ADR-0036), so this
 * asks for nothing and takes the generated `nport-<base32>` — unguessable, recognisably ours, and
 * reapable by the sweep if this process dies before it can release the lease.
 *
 * Creates are capped per source per hour on the real control plane. One run costs one create, and a
 * failed run still costs one, so a tight retry loop around this script will lock the source out.
 */

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { platform } from "node:os"

const BACKEND = argOf("backend") ?? "https://api.nport.online"
const BINARY = argOf("binary") ?? null
const IS_WINDOWS = platform() === "win32"

/** Distinct per run, so a stale tunnel serving an old body cannot pass as this one. */
const BODY = `nport live smoke ${randomBytes(8).toString("hex")}\n`

let failures = 0
const children = []

function argOf(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

function pass(what) {
  console.log(`  ✓ ${what}`)
}

function fail(what, detail) {
  console.error(`  ✗ ${what}`)
  if (detail !== undefined) console.error(`      ${detail}`)
  failures += 1
}

function check(condition, what, detail) {
  if (condition) pass(what)
  else fail(what, detail)
  return condition
}

// ── the origin ────────────────────────────────────────────────────────────────────────
//
// HTTP plus a hand-rolled WebSocket echo. Node ships a WebSocket *client* but no server, and this is
// ~50 lines against a dependency that would exist solely for one test — see `docs/conventions`.

/** RFC 6455 §1.3. The one constant in the handshake, and it is not a secret. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11D"

function acceptKey(key) {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64")
}

/**
 * Decodes one client frame, which is always masked (§5.3), and returns its text payload.
 *
 * Only what an echo needs: single-frame text, payloads under 64 KiB. Anything else returns null and
 * the caller ignores it — this is a fixture, not a WebSocket implementation.
 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  if (opcode === 0x8) return { close: true }
  if (opcode !== 0x1) return null

  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let at = 2
  if (length === 126) {
    length = buffer.readUInt16BE(2)
    at = 4
  } else if (length === 127) {
    return null
  }

  const mask = masked ? buffer.subarray(at, at + 4) : null
  if (masked) at += 4
  const payload = Buffer.from(buffer.subarray(at, at + length))
  if (mask !== null) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { text: payload.toString("utf8") }
}

/** Encodes an unmasked text frame — servers never mask (§5.1). */
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8")
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.concat([
          Buffer.from([0x81, 126]),
          (() => {
            const b = Buffer.alloc(2)
            b.writeUInt16BE(payload.length)
            return b
          })(),
        ])
  return Buffer.concat([header, payload])
}

async function startOrigin() {
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end(BODY)
      return
    }
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("not found\n")
  })

  server.on("upgrade", (request, socket, head) => {
    const key = request.headers["sec-websocket-key"]
    if (request.url !== "/ws" || key === undefined) {
      socket.destroy()
      return
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    // `head` can already hold the first frame when the client is fast; feeding it back through the
    // same path is what stops message 1 going missing on a fast connection.
    const consume = (chunk) => {
      const frame = decodeFrame(chunk)
      if (frame === null) return
      if (frame.close) {
        socket.end()
        return
      }
      socket.write(encodeFrame(`echo:${frame.text}`))
    }
    if (head !== undefined && head.length > 0) consume(head)
    socket.on("data", consume)
    socket.on("error", () => socket.destroy())
  })

  // Port 0 asks the kernel for a free one, so parallel runs and a busy dev machine cannot collide.
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: server.address().port }
}

// ── the tunnel ────────────────────────────────────────────────────────────────────────

function startTunnel(port) {
  const [command, args] =
    BINARY === null
      ? ["cargo", ["run", "-q", "-p", "nport", "--", String(port), "--backend", BACKEND]]
      : [BINARY, [String(port), "--backend", BACKEND]]

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
  children.push(child)

  let output = ""
  const seen = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      output += chunk
      seen.push(chunk)
    })
  }
  return { child, transcript: () => output, lines: seen }
}

/** The banner's first line is the URL. Waits for it rather than for a fixed delay. */
async function waitForUrl(tunnel, deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    const match = /https:\/\/[a-z0-9-]+\.[a-z0-9.-]+/i.exec(tunnel.transcript())
    if (match !== null) return match[0]
    if (tunnel.child.exitCode !== null) {
      throw new Error(`the CLI exited early (${tunnel.child.exitCode}):\n${tunnel.transcript()}`)
    }
    await sleep(500)
  }
  throw new Error(`no URL within ${deadlineMs}ms. Output:\n${tunnel.transcript()}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A tunnel is routable a moment after the CLI prints its URL — DNS and the edge both have to catch
 * up. Retrying a 5xx here is the difference between a real failure and a race.
 */
async function waitForRoute(url, deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs
  let last = "no attempt"
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { headers: { "cache-control": "no-cache" } })
      if (response.ok) return await response.text()
      last = `HTTP ${response.status}`
    } catch (error) {
      last = String(error)
    }
    await sleep(3_000)
  }
  throw new Error(`${url} never served: ${last}`)
}

async function echoOverWebSocket(url, messages = 20) {
  const socket = new WebSocket(`${url.replace(/^https:/, "wss:")}/ws`)
  const received = []

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket did not open within 30s")), 30_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("websocket failed to open"))
    })
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`only ${received.length}/${messages} echoes within 30s`)),
      30_000,
    )
    socket.addEventListener("message", (event) => {
      received.push(String(event.data))
      if (received.length === messages) {
        clearTimeout(timer)
        resolve()
      }
    })
    for (let i = 0; i < messages; i += 1) socket.send(`m${i}`)
  })

  socket.close()
  return received
}

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already gone; nothing to do.
      }
    }
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────────

console.log(`smoke:live against ${BACKEND} on ${platform()}\n`)

const origin = await startOrigin()
console.log(`  origin on 127.0.0.1:${origin.port}`)

const tunnel = startTunnel(origin.port)
let url

try {
  url = await waitForUrl(tunnel)
  console.log(`  tunnel at ${url}\n`)

  const body = await waitForRoute(url)
  check(body === BODY, "the body arrives byte-identical", `got ${JSON.stringify(body)}`)

  const missing = await fetch(`${url}/does-not-exist`)
  check(missing.status === 404, "a 404 from the origin arrives as a 404", `got ${missing.status}`)

  const repeated = await Promise.all(
    Array.from({ length: 10 }, () => fetch(url).then((r) => r.status)),
  )
  check(
    repeated.every((status) => status === 200),
    "ten concurrent requests all succeed",
    `statuses ${repeated.join(",")}`,
  )

  const echoes = await echoOverWebSocket(url)
  check(
    echoes.length === 20 && echoes.every((text, index) => text === `echo:m${index}`),
    "a websocket carries 20 messages in order",
    `got ${echoes.length}: ${echoes.slice(0, 3).join(",")}…`,
  )

  // ── teardown ────────────────────────────────────────────────────────────────────────
  if (IS_WINDOWS) {
    console.log("\n  graceful shutdown: skipped — Windows has no SIGINT to send a child")
    tunnel.child.kill()
  } else {
    tunnel.child.kill("SIGINT")
    const exited = await Promise.race([
      new Promise((resolve) => tunnel.child.once("exit", () => resolve(true))),
      sleep(45_000).then(() => false),
    ])
    check(exited, "Ctrl+C drains and exits within 45s")

    // The lease is released before the process exits, so the hostname stops serving. Cloudflare
    // answers 530 for a moment while the record is going, then the name stops resolving entirely.
    let gone = false
    for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
      await sleep(3_000)
      try {
        const response = await fetch(url, { cache: "no-store" })
        gone = response.status >= 500
      } catch {
        gone = true
      }
    }
    check(gone, "the public URL stops serving after teardown")
  }
} catch (error) {
  fail("the run completed", String(error))
  console.error(`\n--- CLI output ---\n${tunnel.transcript()}`)
} finally {
  cleanup()
  origin.server.close()
}

console.log(
  failures === 0
    ? "\nsmoke:live: a real tunnel carried real traffic\n"
    : `\nsmoke:live: ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
