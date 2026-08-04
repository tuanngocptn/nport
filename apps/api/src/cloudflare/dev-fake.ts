/**
 * A fake Cloudflare API for `wrangler dev`, so `pnpm dev` can provision without credentials.
 *
 * ## Why this exists
 *
 * `POST /v1/tunnels` calls Cloudflare four times. Without a real scoped token every one of those is
 * rejected upstream, so the whole interesting half of the control plane — the saga, the lease, the
 * `ownerToken`, the CLI's provisioning path — cannot be exercised locally at all. That is a poor
 * trade for a project whose first-run promise is that nothing needs configuring.
 *
 * ## Why it is safe
 *
 * It is wired **only** when `FAKE_CLOUDFLARE` is truthy, and that flag can only come from
 * `apps/api/.dev.vars` — a gitignored file that `wrangler dev` reads and `wrangler deploy` does not.
 * There is no path by which a deployed Worker sees it, short of someone running
 * `wrangler secret put FAKE_CLOUDFLARE`, which is not an accident anyone has. The guard below still
 * refuses to activate when the token looks real, so the failure mode of a mistake is "your fake
 * stopped working", not "production stopped provisioning".
 *
 * ## What it is not
 *
 * Not `test/fake-cloudflare.ts`. That one patches `globalThis.fetch` to reach inside Durable Objects
 * from a test file in the same isolate, and injects per-operation failures to drive the compensation
 * paths. This is a plain `fetch`-shaped function slotted into the seam `CloudflareClient` already
 * has for its own tests, with no failure injection — a developer wants the happy path.
 *
 * **The token it mints is not a real connector credential.** Provisioning succeeds and the URL is
 * shaped correctly, but `nport` cannot open a QUIC session to Cloudflare's edge with it. Everything
 * up to and including the lease is real; the tunnel is not.
 *
 * ## Known limitation
 *
 * State is per-isolate. `SubdomainLease` runs in its own isolate, so create → delete for one
 * subdomain is consistent, which is the path that matters. The reconciliation cron runs elsewhere
 * and will therefore see no tunnels and no orphans. Making that work would mean a Durable Object
 * whose only purpose is to hold fake state, which is a lot of production surface for a dev
 * convenience.
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

interface FakeTunnel {
  id: string
  name: string
  created_at: string
  deleted_at: string | null
}

interface FakeDnsRecord {
  id: string
  name: string
  type: string
  content: string
}

// Module scope, which `apps/api/CLAUDE.md` rule 10 forbids — and the reason it forbids it does not
// apply here. The rule exists because an isolate is shared across *callers*, so shared mutable state
// leaks one user's data into another's request. This module is only ever loaded in `wrangler dev`,
// where there is one caller: the developer who started it.
const tunnels = new Map<string, FakeTunnel>()
const dnsRecords = new Map<string, FakeDnsRecord>()
let counter = 0

/** A stable, obviously-fake hex id. Not random, so a log line is reproducible between runs. */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}${String(counter).padStart(8, "0")}dead0000beef0000cafe0000`.slice(0, 32)
}

/**
 * A tunnel id in the shape the client will actually accept: a **UUID**.
 *
 * Not cosmetic. `TunnelToken::parse` runs `Uuid::parse_str` on this field, so a bare hex string
 * fails there — and the CLI then reports `EDGE_PROTOCOL_ERROR` having never reached the edge at all,
 * which makes a fake run prove much less than it appears to. Cloudflare's own tunnel ids are UUIDs,
 * so this is also the more faithful fake.
 */
function nextTunnelId(): string {
  counter += 1
  const n = String(counter).padStart(8, "0")
  return `${n}-dead-4000-8000-0000cafe0000`
}

function ok(result: unknown, resultInfo?: unknown): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  })
}

function fail(status: number, code: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  )
}

/**
 * Whether the fake should be used.
 *
 * The `CF_API_TOKEN` check is the belt to the flag's braces: a real token is 40 characters of
 * URL-safe base64, and the placeholder in `.dev.vars.example` is not. If someone points a dev
 * session at a genuine token, they want the genuine API — silently faking it would mean their
 * "it works locally" proved nothing at all.
 */
export function useDevFake(env: { FAKE_CLOUDFLARE?: string; CF_API_TOKEN?: string }): boolean {
  if (env.FAKE_CLOUDFLARE !== "1" && env.FAKE_CLOUDFLARE !== "true") {
    return false
  }
  const token = env.CF_API_TOKEN ?? ""
  const looksReal = token.length >= 40 && /^[A-Za-z0-9_-]+$/.test(token)
  if (looksReal) {
    console.warn("FAKE_CLOUDFLARE is set but CF_API_TOKEN looks real — using the real API")
    return false
  }
  return true
}

/** A `fetch`-shaped handler for the seven endpoints `CloudflareClient` calls. */
export const devFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : "")
  const method = init?.method ?? "GET"
  const path = url.pathname.replace(new URL(CF_API_BASE).pathname, "")
  const body: Record<string, unknown> = typeof init?.body === "string" ? JSON.parse(init.body) : {}

  // --- Tunnels -------------------------------------------------------------
  const tunnelMatch = /^\/accounts\/[^/]+\/cfd_tunnel(?:\/([^/]+))?(\/connections)?$/.exec(path)
  if (tunnelMatch) {
    const [, id, connections] = tunnelMatch

    if (method === "POST" && !id) {
      const name = String(body.name ?? "")
      const tunnel: FakeTunnel = {
        id: nextTunnelId(),
        name,
        created_at: new Date().toISOString(),
        deleted_at: null,
      }
      tunnels.set(tunnel.id, tunnel)
      // Shaped like the real thing (`docs/PROTOCOL.md` §3) so the CLI's token parser is exercised
      // rather than bypassed: base64 JSON, `t` a UUID, and `s` a secret of at least the 32 bytes
      // `MIN_SECRET_LEN` requires. Get either wrong and the client fails at *parsing* while
      // reporting EDGE_PROTOCOL_ERROR, so a dev run looks like it reached the edge when it did not.
      //
      // The secret is nonsense, which is the point — everything up to the QUIC handshake is
      // exercised, and the handshake is what refuses it.
      const token = btoa(
        JSON.stringify({
          a: "0".repeat(32),
          t: tunnel.id,
          s: btoa("nport-dev-fake-secret-not-a-real-credential"),
        }),
      )
      return ok({ id: tunnel.id, token })
    }

    if (method === "DELETE" && id && connections) {
      return ok(null)
    }

    if (method === "DELETE" && id) {
      const tunnel = tunnels.get(id)
      if (!tunnel) {
        return fail(404, 1000, "tunnel not found")
      }
      tunnels.delete(id)
      return ok(null)
    }

    if (method === "GET" && !id) {
      const name = url.searchParams.get("name")
      const all = [...tunnels.values()].map((t) => ({
        id: t.id,
        name: t.name,
        created_at: t.created_at,
        deleted_at: t.deleted_at,
      }))
      const matched = name === null ? all : all.filter((t) => t.name === name)
      return ok(matched, {
        page: Number(url.searchParams.get("page") ?? 1),
        per_page: Number(url.searchParams.get("per_page") ?? matched.length),
        count: matched.length,
        total_count: matched.length,
      })
    }
  }

  // --- DNS records ---------------------------------------------------------
  const dnsMatch = /^\/zones\/[^/]+\/dns_records(?:\/([^/]+))?$/.exec(path)
  if (dnsMatch) {
    const [, id] = dnsMatch

    if (method === "POST" && !id) {
      const name = String(body.name ?? "")
      const existing = [...dnsRecords.values()].find((r) => r.name === name)
      if (existing) {
        // 81053 is the code the saga branches on to mean "the name is taken"; returning a plain
        // 400 here would exercise a different path than production takes.
        return fail(400, 81053, "An A, AAAA, or CNAME record with that host already exists.")
      }
      const record: FakeDnsRecord = {
        id: nextId("d"),
        name,
        type: String(body.type ?? "CNAME"),
        content: String(body.content ?? ""),
      }
      dnsRecords.set(record.id, record)
      return ok(record)
    }

    if (method === "DELETE" && id) {
      dnsRecords.delete(id)
      return ok({ id })
    }

    if (method === "GET" && !id) {
      const name = url.searchParams.get("name")
      const matched = [...dnsRecords.values()].filter((r) => name === null || r.name === name)
      return ok(matched)
    }
  }

  console.warn("dev fake: unhandled Cloudflare call", { method, path })
  return fail(501, 1000, "not implemented in the dev fake")
}
