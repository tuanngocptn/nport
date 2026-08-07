/**
 * An in-memory stand-in for the registry's two outbound calls: DNS-over-HTTPS, and a node's
 * `GET /v1/meta`.
 *
 * **It must never be more generous than the real thing.** `apps/node`'s `apps/node/test/fake-cloudflare.ts`
 * learned that the hard way: it invented a `result_info.total_pages` field the tunnels list does not
 * send, so the reconciliation sweep silently never left page 1 and the whole suite agreed with the bug
 * (`docs/ROADMAP.md`, defect 8). So the DoH response shape here is exactly Cloudflare's — `Answer`
 * entries with a numeric `type` and a `data` string **carrying its surrounding quotes**, which is how
 * a resolver really returns TXT.
 *
 * It throws on any host it does not recognise, so a test that escapes the fake fails loudly rather
 * than resolving someone's real domain.
 */

/** TXT records to answer with, keyed by the exact queried name. */
export interface FakeDns {
  readonly [name: string]: readonly string[]
}

/** What a node's `/v1/meta` returns, keyed by origin. `null` means the node does not answer. */
export interface FakeNodes {
  readonly [origin: string]: Record<string, unknown> | null
}

export interface FakeUpstream {
  readonly fetch: typeof fetch
  /** Every URL fetched, in order. Lets a test assert what was *not* called. */
  readonly calls: string[]
}

/**
 * Builds a `fetch` that answers only the DoH endpoint and the node origins given.
 *
 * TXT `data` is quoted on the way out because that is what a real resolver does, and
 * `nodeProofSatisfied` in `packages/contract` is the thing that has to cope with it. A fake that
 * returned bare values would have let a missing `replaceAll('"', "")` pass.
 */
export function fakeUpstream(dns: FakeDns, nodes: FakeNodes): FakeUpstream {
  const calls: string[] = []

  const fetcher = (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    calls.push(url.toString())

    if (url.origin === "https://cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? ""
      const records = dns[name]
      if (records === undefined) {
        // NXDOMAIN: a 200 with no `Answer`, which is what the resolver actually returns. Not a 404 —
        // getting that wrong would make "no record" indistinguishable from "resolver broken".
        return Response.json({ Status: 3 })
      }
      return Response.json({
        Status: 0,
        Answer: records.map((data) => ({ name, type: 16, TTL: 300, data: `"${data}"` })),
      })
    }

    if (url.pathname === "/v1/meta" && url.origin in nodes) {
      const meta = nodes[url.origin]
      if (meta === null || meta === undefined) {
        // A node that is down. A connection failure is a rejected fetch, not a status — which is what
        // `probeNode` has to survive without throwing.
        throw new TypeError("fetch failed")
      }
      return Response.json(meta)
    }

    throw new Error(
      `fake upstream: nothing registered for ${url.toString()}. A test that reaches a real host is a test that lies.`,
    )
  }) as typeof fetch

  return { fetch: fetcher, calls }
}
