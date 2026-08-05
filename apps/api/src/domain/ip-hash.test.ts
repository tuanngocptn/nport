/**
 * Source identity, and the address narrowing that makes the per-source caps real.
 *
 * Most of this file is about IPv6 forms, because that is where the bug was: keyed on the full address,
 * every per-source control in `docs/ARCHITECTURE.md` §7 was free to bypass by changing bits the client
 * already owns. The property under test is therefore a **negative** one — two addresses a single client
 * can hold must not produce two identities — and the many spellings of one IPv6 address are the ways
 * that property breaks quietly.
 */

import { describe, expect, it } from "vitest"

import { sourceHash, sourcePrefix } from "./ip-hash"

const SECRET = "test-ip-hash-secret"

describe("sourcePrefix", () => {
  it("passes an IPv4 address through whole", () => {
    // A client controls exactly one IPv4 address, so every bit of it is identity.
    expect(sourcePrefix("203.0.113.10")).toBe("203.0.113.10")
    expect(sourcePrefix("203.0.113.11")).not.toBe(sourcePrefix("203.0.113.10"))
  })

  it("keeps a missing address as its own single identity", () => {
    // No `cf-connecting-ip` becomes `"unknown"`, and every such request has to share one bucket
    // rather than each getting a fresh one.
    expect(sourcePrefix("unknown")).toBe("unknown")
  })

  it("truncates IPv6 to its /64", () => {
    expect(sourcePrefix("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd")).toBe("v6:8193:3512:4660:22136")
  })

  it("gives one identity to every address in a /64", () => {
    // The whole point. A residential allocation is a /64 at minimum, so these are one client.
    const first = sourcePrefix("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd")
    expect(sourcePrefix("2001:db8:1234:5678::1")).toBe(first)
    expect(sourcePrefix("2001:db8:1234:5678:ffff:ffff:ffff:ffff")).toBe(first)
    expect(sourcePrefix("2001:db8:1234:5678::")).toBe(first)
  })

  it("separates different /64s", () => {
    expect(sourcePrefix("2001:db8:1234:5679::1")).not.toBe(sourcePrefix("2001:db8:1234:5678::1"))
  })

  it("reads compressed and expanded spellings of one address the same way", () => {
    // A string comparison would call these different, which would hand one client two identities and
    // reopen the hole. The comparison has to be on values.
    const canonical = sourcePrefix("2001:0db8:0000:0000:0000:0000:0000:0001")
    expect(sourcePrefix("2001:db8::1")).toBe(canonical)
    expect(sourcePrefix("2001:DB8::1")).toBe(canonical)
    expect(sourcePrefix("2001:db8:0:0:0:0:0:1")).toBe(canonical)
  })

  it("handles the all-zero and loopback forms", () => {
    expect(sourcePrefix("::")).toBe("v6:0:0:0:0")
    expect(sourcePrefix("::1")).toBe("v6:0:0:0:0")
  })

  it("handles a trailing `::`", () => {
    expect(sourcePrefix("2001:db8::")).toBe(sourcePrefix("2001:db8:0:0::5"))
  })

  it("keys an IPv4-mapped address on all 32 bits of the IPv4", () => {
    // Truncating these to /64 would put *every* IPv4-mapped client in one bucket — the same bug
    // inverted, and a far worse one, since it would cap unrelated people against each other.
    expect(sourcePrefix("::ffff:203.0.113.10")).not.toBe(sourcePrefix("::ffff:203.0.113.11"))
    expect(sourcePrefix("::ffff:203.0.113.10")).not.toBe(sourcePrefix("::"))
  })

  it("reads an IPv4-mapped address the same in hex and dotted form", () => {
    // `::ffff:cb00:710a` and `::ffff:203.0.113.10` are the same address.
    expect(sourcePrefix("::ffff:cb00:710a")).toBe(sourcePrefix("::ffff:203.0.113.10"))
  })

  it("does not treat a NAT64 address as IPv4", () => {
    // `64:ff9b::/96` embeds an IPv4 address but is not IPv4-mapped, and everything behind one NAT64
    // gateway genuinely is one source.
    expect(sourcePrefix("64:ff9b::203.0.113.10")).toBe("v6:100:65435:0:0")
  })

  it("hashes an unparseable address whole rather than merging it with others", () => {
    // Returned unchanged, so two different malformed values stay two identities. Merging them would
    // make "send a malformed address" a way to share somebody else's bucket.
    expect(sourcePrefix("2001:db8::1::2")).toBe("2001:db8::1::2")
    expect(sourcePrefix("2001:zzzz::1")).toBe("2001:zzzz::1")
    expect(sourcePrefix("1:2:3:4:5:6:7")).toBe("1:2:3:4:5:6:7")
    expect(sourcePrefix("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9")
    expect(sourcePrefix("::ffff:203.0.113")).toBe("::ffff:203.0.113")
    expect(sourcePrefix("::ffff:203.0.113.999")).toBe("::ffff:203.0.113.999")
  })

  it("strips a zone index and brackets", () => {
    expect(sourcePrefix("[2001:db8:1234:5678::1]")).toBe(sourcePrefix("2001:db8:1234:5678::1"))
    expect(sourcePrefix("fe80::1%eth0")).toBe(sourcePrefix("fe80::1"))
  })
})

describe("sourceHash", () => {
  it("gives one hash to a whole /64", async () => {
    const first = await sourceHash(SECRET, "2001:db8:1234:5678::1")
    expect(await sourceHash(SECRET, "2001:db8:1234:5678:dead:beef:cafe:f00d")).toBe(first)
  })

  it("gives different hashes to different /64s", async () => {
    const first = await sourceHash(SECRET, "2001:db8:1234:5678::1")
    expect(await sourceHash(SECRET, "2001:db8:1234:9999::1")).not.toBe(first)
  })

  it("never returns the address it was given", async () => {
    // Rule 11: a raw IP is never stored, and this value is stored on every lease.
    const hash = await sourceHash(SECRET, "203.0.113.10")
    expect(hash).not.toContain("203")
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it("separates two sources that differ only in ASN", async () => {
    const withAsn = await sourceHash(SECRET, "203.0.113.10", 64496)
    expect(await sourceHash(SECRET, "203.0.113.10")).not.toBe(withAsn)
  })

  it("cannot be confused by an address that looks like an address plus an ASN", async () => {
    // The separator's whole job. Without it, ("1.2.3.4", 5) and ("1.2.3.45", undefined) collide.
    const a = await sourceHash(SECRET, "203.0.113.4", 5)
    const b = await sourceHash(SECRET, "203.0.113.45")
    expect(a).not.toBe(b)
  })

  it("changes completely when the secret rotates", async () => {
    // Rotating the secret invalidates every stored value at once, which is the intended behaviour.
    const before = await sourceHash(SECRET, "203.0.113.10")
    expect(await sourceHash("a-different-secret", "203.0.113.10")).not.toBe(before)
  })
})
