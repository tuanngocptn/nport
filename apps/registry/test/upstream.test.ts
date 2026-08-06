/**
 * The two outbound calls, and the check that makes them safe.
 *
 * `verifyNodeUrl` gets the most attention here because it is the load-bearing check in the whole
 * registration path: it stops the registry being an open fetch proxy, **and** it is what makes the
 * DNS proof cover the URL we actually fetch. Everything else in `POST /v1/nodes` assumes it holds.
 */

import { describe, expect, it } from "vitest"

import { domainProofSatisfied, probeNode, verifyNodeUrl } from "../src/upstream"
import { fakeUpstream } from "./fake-upstream"

describe("verifyNodeUrl", () => {
  it("accepts the node's own host and a subdomain of the proved domain", () => {
    expect(verifyNodeUrl("https://api.nport.link", "nport.link").ok).toBe(true)
    expect(verifyNodeUrl("https://nport.link", "nport.link").ok).toBe(true)
    expect(verifyNodeUrl("https://a.b.nport.link", "nport.link").ok).toBe(true)
  })

  it("refuses a host outside the domain that was proved", () => {
    // **The amplification and takeover case in one.** A registration proves control of `nport.link`;
    // without this the directory would happily advertise — and the registry would fetch — a host the
    // operator has proved nothing about.
    const refused = verifyNodeUrl("https://evil.test/x", "nport.link")
    expect(refused).toEqual({ ok: false, reason: "not-under-domain" })
  })

  it("refuses a host that merely ends with the domain's characters", () => {
    // The dot in the suffix check is the whole difference: a bare `endsWith` would let anyone who
    // registers `notnport.link` pass a proof for `nport.link`.
    expect(verifyNodeUrl("https://notnport.link", "nport.link")).toEqual({
      ok: false,
      reason: "not-under-domain",
    })
    expect(verifyNodeUrl("https://xnport.link", "nport.link").ok).toBe(false)
  })

  it("refuses anything but https", () => {
    // Clients send a proof of work to this URL; plaintext would put it on the wire.
    expect(verifyNodeUrl("http://api.nport.link", "nport.link")).toEqual({
      ok: false,
      reason: "not-https",
    })
    expect(verifyNodeUrl("file:///etc/passwd", "nport.link").ok).toBe(false)
    // `javascript:` parses as a URL, so the protocol check is what refuses it rather than the parse.
    expect(verifyNodeUrl("javascript:alert(1)", "nport.link").ok).toBe(false)
  })

  it("refuses a URL that does not parse", () => {
    expect(verifyNodeUrl("not a url", "nport.link")).toEqual({ ok: false, reason: "unparseable" })
    expect(verifyNodeUrl("", "nport.link").ok).toBe(false)
  })

  it("compares hosts case-insensitively, because DNS does", () => {
    expect(verifyNodeUrl("https://API.NPort.Link", "nport.link").ok).toBe(true)
    expect(verifyNodeUrl("https://api.nport.link", "NPORT.LINK").ok).toBe(true)
  })

  it("is not fooled by userinfo or a port", () => {
    // `https://nport.link@evil.test` has hostname `evil.test` — the classic misread. `URL` gets this
    // right, and the assertion is here so a future hand-rolled parser cannot get it wrong quietly.
    expect(verifyNodeUrl("https://nport.link@evil.test", "nport.link").ok).toBe(false)
    expect(verifyNodeUrl("https://api.nport.link:8443", "nport.link").ok).toBe(true)
  })
})

describe("domainProofSatisfied", () => {
  const PROOF = "_nport-node.nport.link"

  it("finds the record for the right node id", async () => {
    const fake = fakeUpstream({ [PROOF]: ["nport-node=hk1"] }, {})
    await expect(domainProofSatisfied("nport.link", "hk1", fake.fetch)).resolves.toBe(true)
  })

  it("refuses a record naming a different node id", async () => {
    // The binding is the point: one published record authorises one listing, not every listing on
    // the domain.
    const fake = fakeUpstream({ [PROOF]: ["nport-node=hk1"] }, {})
    await expect(domainProofSatisfied("nport.link", "hk2", fake.fetch)).resolves.toBe(false)
  })

  it("copes with the quotes a real resolver returns", async () => {
    // `test/fake-upstream.ts` quotes `data` because Cloudflare does. A fake that returned bare values
    // would have let a missing unquote pass here and fail in production.
    const fake = fakeUpstream({ [PROOF]: ["nport-node=hk1"] }, {})
    expect(await domainProofSatisfied("nport.link", "hk1", fake.fetch)).toBe(true)
    expect(fake.calls[0]).toContain(encodeURIComponent(PROOF))
  })

  it("finds its record among the ones a real domain already has", async () => {
    const fake = fakeUpstream(
      { [PROOF]: ["v=spf1 -all", "google-site-verification=abc", "nport-node=hk1"] },
      {},
    )
    await expect(domainProofSatisfied("nport.link", "hk1", fake.fetch)).resolves.toBe(true)
  })

  it("is false for a name with no records at all", async () => {
    const fake = fakeUpstream({}, {})
    await expect(domainProofSatisfied("nport.link", "hk1", fake.fetch)).resolves.toBe(false)
  })

  it("is false rather than a throw when the resolver misbehaves", async () => {
    // A resolver hiccup must read as "not proved yet" and be fixable by registering again — never as
    // a 500 on someone else's DNS.
    const broken = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    await expect(domainProofSatisfied("nport.link", "hk1", broken)).resolves.toBe(false)
  })
})

describe("probeNode", () => {
  const ORIGIN = "https://api.nport.link"

  it("reads the capacity a node publishes", async () => {
    const fake = fakeUpstream({}, { [ORIGIN]: { activeTunnels: 12, maxActiveTunnels: 100 } })
    await expect(probeNode(ORIGIN, fake.fetch)).resolves.toEqual({
      activeTunnels: 12,
      maxActiveTunnels: 100,
    })
    expect(fake.calls).toEqual([`${ORIGIN}/v1/meta`])
  })

  it("returns an empty observation for a node that publishes neither field", async () => {
    // An older node. **Empty, not null**: it answered, so it is up — it just did not say how full it
    // is. Conflating the two would delist every node running a build from before ADR-0046.
    const fake = fakeUpstream({}, { [ORIGIN]: { minClientVersion: "3.0.0", powDifficulty: 20 } })
    await expect(probeNode(ORIGIN, fake.fetch)).resolves.toEqual({})
  })

  it("treats a nonsense capacity as unknown rather than as zero", async () => {
    // Absent means unknown. A node reporting `-1` or `"lots"` must not end up looking empty, which is
    // the state every client sorts to the front.
    const fake = fakeUpstream({}, { [ORIGIN]: { activeTunnels: -1, maxActiveTunnels: "lots" } })
    await expect(probeNode(ORIGIN, fake.fetch)).resolves.toEqual({})
  })

  it("is null for a node that does not answer", async () => {
    const fake = fakeUpstream({}, { [ORIGIN]: null })
    await expect(probeNode(ORIGIN, fake.fetch)).resolves.toBeNull()
  })

  it("is null for a body that is not JSON", async () => {
    const notJson = (async () => new Response("<html>hello</html>")) as unknown as typeof fetch
    await expect(probeNode(ORIGIN, notJson)).resolves.toBeNull()
  })

  it("is null for an error status", async () => {
    const failing = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch
    await expect(probeNode(ORIGIN, failing)).resolves.toBeNull()
  })

  it("refuses a body larger than the ceiling rather than reading forever", async () => {
    // The peer is a stranger's server. Without a bound, a node that streams forever makes the probe
    // read forever — the missing-ceiling shape `crates/core`'s `MAX_RESPONSE_HEAD` exists to prevent,
    // in the other language.
    const huge = (async () =>
      Response.json({ activeTunnels: 1, padding: "x".repeat(20_000) })) as unknown as typeof fetch
    await expect(probeNode(ORIGIN, huge)).resolves.toBeNull()
  })

  it("asks for /v1/meta even when the node's URL carries a path", async () => {
    // `new URL("/v1/meta", base)` replaces the path rather than appending, which is what we want: a
    // node registered as `https://api.nport.link/` must not be probed at `//v1/meta`.
    const fake = fakeUpstream({}, { [ORIGIN]: { activeTunnels: 0 } })
    await probeNode(`${ORIGIN}/some/prefix`, fake.fetch)
    expect(fake.calls).toEqual([`${ORIGIN}/v1/meta`])
  })
})
