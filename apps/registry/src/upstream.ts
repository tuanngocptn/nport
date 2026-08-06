/**
 * The registry's only two outbound calls: resolve a TXT record, and probe a node's `/v1/meta`.
 *
 * Both take **attacker-supplied input** on an endpoint anyone may call, so both are written as if
 * they will be abused. `verifyNodeUrl` below is the check that makes the rest safe, and it is worth
 * reading before either function.
 */

import { nodeProofRecordName, nodeProofSatisfied } from "@nport/contract"

/**
 * DNS-over-HTTPS, because **a Worker cannot do raw DNS.** There is no UDP socket, so the only way to
 * ask a question is to ask over HTTPS.
 *
 * Cloudflare's own resolver, which is also the cheapest hop from inside a Worker. It is not a trust
 * assumption worth agonising over: the answer only ever *grants* a listing, and a resolver that lied
 * would have to lie in the operator's favour, which the operator could achieve by publishing the
 * record honestly.
 */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"

/** TXT. */
const TYPE_TXT = 16

/**
 * How long either call gets. Both run inside a request a person is waiting on, and a node that takes
 * longer than this to answer its own `/v1/meta` is not a node worth listing.
 */
const UPSTREAM_TIMEOUT_MS = 5000

/**
 * The most bytes read from a node's `/v1/meta`.
 *
 * The body is a small JSON object, and the peer is a stranger's server. Without a ceiling, a node that
 * streams forever makes the probe read forever — the same missing bound as `MAX_RESPONSE_HEAD` in
 * `crates/core`, in the other language.
 */
const MAX_META_BYTES = 16_384

export type UrlRejection = "not-https" | "not-under-domain" | "unparseable"

/**
 * Whether a node's claimed URL may be fetched, given the domain it proved control of.
 *
 * **This is the load-bearing check in the whole registration path**, and it does two jobs.
 *
 * First, it stops the registry being an open fetch proxy. `POST /v1/nodes` makes us fetch a URL a
 * stranger chose; without a constraint, anyone who solves one proof of work can point Cloudflare's
 * network at any host they like and read back a truncated response.
 *
 * Second — and this is the subtler one — it makes the **domain proof actually cover the thing we
 * fetch**. The TXT record proves control of `<domain>` and nothing else. If the URL could be anywhere,
 * an operator could prove `example.test` and then have the directory advertise a node hosted on a
 * host they do not control at all. Requiring the URL's host to be `<domain>` or a subdomain of it is
 * what ties the proof to the probe target, so one check covers both.
 *
 * HTTPS only, because the URL is handed to clients who will send a proof of work to it.
 */
export function verifyNodeUrl(
  url: string,
  domain: string,
): { ok: true } | { ok: false; reason: UrlRejection } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: "unparseable" }
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "not-https" }
  }
  const host = parsed.hostname.toLowerCase()
  const claimed = domain.toLowerCase()
  // Exact match or a subdomain. The dot matters: `notnport.link` must not pass for `nport.link`,
  // which a bare `endsWith` would allow.
  if (host !== claimed && !host.endsWith(`.${claimed}`)) {
    return { ok: false, reason: "not-under-domain" }
  }
  return { ok: true }
}

/**
 * Whether `_nport-node.<domain>` carries a TXT record proving this node id.
 *
 * The comparison itself lives in `@nport/contract` (`nodeProofSatisfied`), so the registry, the docs
 * and any future tooling agree on the exact value without anyone retyping it.
 *
 * A lookup that fails for *any* reason is `false`, never a throw: a resolver hiccup must read as
 * "not proved yet" and be retryable by re-registering, not as a 500 on someone else's DNS.
 */
export async function domainProofSatisfied(
  domain: string,
  nodeId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const name = nodeProofRecordName(domain)
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`

  let records: string[]
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      return false
    }
    const body = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> }
    records = (body.Answer ?? [])
      // Filter by type: a CNAME at the same name comes back in `Answer` too, and its `data` is a
      // hostname. Feeding that to the comparison would be harmless but it is one less thing to think
      // about, and a resolver is free to include records nobody asked for.
      .filter((answer) => answer.type === TYPE_TXT)
      .map((answer) => answer.data ?? "")
  } catch {
    return false
  }

  return nodeProofSatisfied(records, nodeId)
}

/**
 * What a probe learned. Both fields optional, because an older node publishes neither.
 *
 * **No `version`**, and that is a fact about the contract rather than an omission: `GET /v1/meta`
 * publishes `minClientVersion` — the floor a node imposes on *clients* — and says nothing about the
 * node's own build. So a node's version is only ever what it declared at registration, and the probe
 * cannot correct it.
 */
export interface Observation {
  readonly activeTunnels?: number
  readonly maxActiveTunnels?: number
}

/**
 * Reads a node's `GET /v1/meta`.
 *
 * `null` means "did not answer usefully" — unreachable, slow, non-JSON, or an error status. The caller
 * turns that into a failure streak; it is never an exception, because one unreachable node must not
 * fail a cron run that has other nodes to probe.
 *
 * **Capacity comes from here and nowhere else** (ADR-0046). A registration cannot claim it, because a
 * node that could assert `activeTunnels: 0` would be picked first by every client — a free denial of
 * service against whoever runs it.
 */
export async function probeNode(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<Observation | null> {
  const target = new URL("/v1/meta", url)
  try {
    const response = await fetcher(target.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }
    const text = await readBounded(response)
    if (text === null) {
      return null
    }
    const meta = JSON.parse(text) as Record<string, unknown>

    // Read field by field rather than trusting the shape. This is a stranger's server, and the
    // contract's own schema would reject an older node's meta for a field it never had — which is
    // exactly the compatibility ADR-0046 made these two fields optional to preserve.
    const active = count(meta.activeTunnels)
    const max = count(meta.maxActiveTunnels)
    return {
      ...(active === undefined ? {} : { activeTunnels: active }),
      ...(max === undefined ? {} : { maxActiveTunnels: max }),
    }
  } catch {
    return null
  }
}

/** A non-negative integer, or `undefined` for anything else. Absent means unknown, never zero. */
function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined
  }
  return value
}

/**
 * Reads at most [`MAX_META_BYTES`], or `null` if the body is longer.
 *
 * Refusing rather than truncating: a truncated JSON body would fail to parse and be reported as
 * "malformed", which blames the wrong thing. A node whose `/v1/meta` is 16 KiB is misconfigured, and
 * saying so by not listing it is the honest answer.
 */
async function readBounded(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_META_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}
