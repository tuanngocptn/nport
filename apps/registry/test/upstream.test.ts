/**
 * The two outbound calls, and the check that makes them safe.
 *
 * `verifyNodeUrl` gets the most attention here because it is the load-bearing check in the whole
 * registration path: it stops the registry being an open fetch proxy, **and** it is what makes the
 * DNS proof cover the URL we actually fetch. Everything else in `POST /v1/nodes` assumes it holds.
 */

import { describe, expect, it } from "vitest"

import { domainProofSatisfied, verifyNodeUrl } from "../src/upstream"
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

/**
 * **`describe("probeNode")` is gone with the probe** (ADR-0049), and it is worth saying what went with
 * it, because the tests were the good kind: a bounded read so a node streaming forever could not make
 * the probe read forever, field-by-field parsing so an older node's `/v1/meta` was not rejected for a
 * field it never had, `-1` and `"lots"` read as *unknown* rather than as empty, and `new URL` used so a
 * node registered with a path was still probed at `/v1/meta`.
 *
 * None of it has a caller now: this Worker fetches a DNS resolver and nothing else. Nodes report their
 * own capacity, and `apps/node/test/register.test.ts` covers what they send. The "unknown, never zero"
 * distinction survives where it still matters — `Directory` stores those columns nullable, and
 * `test/nodes.test.ts` asserts an absent claim stays absent rather than becoming `0`.
 */
