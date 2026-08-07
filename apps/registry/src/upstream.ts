/**
 * The registry's **one** outbound call: resolve a TXT record.
 *
 * It takes **attacker-supplied input** on an endpoint anyone may call, so it is written as if it will
 * be abused. `verifyNodeUrl` below is the check that makes it safe, and it is worth reading first.
 *
 * `probeNode` used to live here too, and is gone with the probe (ADR-0049). Its careful parts were
 * worth keeping in the history: a bounded read, so a node streaming forever could not make the probe
 * read forever, and field-by-field parsing rather than the contract's schema, so an older node's
 * `/v1/meta` was not rejected for a field it never had. Nothing in this Worker fetches a stranger's
 * server any more — nodes report their own capacity — so the only outbound call left is to a resolver
 * we choose.
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
 * How long the lookup gets. It runs inside a request a person is waiting on, and a resolver that takes
 * longer than this has effectively not answered.
 */
const UPSTREAM_TIMEOUT_MS = 5000

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
