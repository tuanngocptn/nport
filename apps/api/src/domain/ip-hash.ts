/**
 * Source identity without storing a source.
 *
 * `HMAC(ip, IP_HASH_SECRET)`, truncated. **Raw IPs are never stored or logged** (rule 11), which is
 * the one privacy commitment an account-free service can actually keep: there is no user record to
 * attach an address to, so the address itself must not become one.
 *
 * HMAC rather than a bare hash, because the input space is small enough to enumerate — all of IPv4
 * is 2^32 digests, which is minutes of GPU time. The keyed construction means the mapping is
 * useless to anyone without the secret, and rotating the secret invalidates every stored value at
 * once, which is the intended behaviour: a lease's `ip_hash` outlives the lease by nothing.
 */

/**
 * Bytes of digest kept, hex-encoded.
 *
 * 16 bytes is 128 bits — no collision concern at NPort's scale, and a shorter row than the full 32.
 * The value is only ever compared for equality, never inverted, so truncation costs nothing.
 */
const RETAINED_BYTES = 16

/**
 * How many leading 16-bit groups of an IPv6 address the identity is keyed on — four, a **64-bit
 * prefix**. (Written out rather than as the usual slash notation: `**` followed by that notation
 * closes this comment, which cost one confusing parse error already.)
 *
 * **This is what makes the per-source caps mean anything over IPv6.** A residential or mobile IPv6
 * allocation is a /64 at the very smallest — usually a /56 or /48 — so the client owns at least 2^64
 * addresses and can pick a different one per request at no cost. Keyed on the full address, every one
 * of `docs/ARCHITECTURE.md` §7's per-source layers evaporates for anyone on IPv6: a fresh rate-limit
 * bucket, a fresh `SourceQuota` object, a fresh concurrency cap and a fresh hourly quota, for free and
 * without a botnet. That is not a theoretical hole — it was reachable, and a test now pins it shut.
 *
 * /64 rather than something longer because it is the smallest block anyone is *guaranteed* to have,
 * and the trade-off only runs one way. Grouping too coarsely means a handful of unrelated customers
 * behind one provider's shared /64 share a cap, which is a nuisance; grouping too finely means there
 * is no cap. It is also what Cloudflare's own rate limiting keys IPv6 on.
 */
const IPV6_PREFIX_GROUPS = 4

/**
 * The part of a client address the identity is keyed on.
 *
 * IPv4 addresses pass through whole — a client controls exactly one. IPv6 is truncated to its /64,
 * because a client controls the rest of it. An address that cannot be parsed is returned unchanged
 * and hashed as-is: an unrecognised source is not a reason to merge it with every other unrecognised
 * source, and `"unknown"` (no `cf-connecting-ip`) has to keep working as a single identity.
 */
export function sourcePrefix(ip: string): string {
  if (!ip.includes(":")) {
    return ip
  }
  const groups = expandIpv6(ip)
  if (groups === null) {
    return ip
  }
  // An IPv4-mapped address (`::ffff:a.b.c.d`) is an IPv4 client wearing an IPv6 hat, and all 32 bits
  // of it are meaningful. Truncating it to a 64-bit prefix would put *every* such client in one
  // bucket — the same bug inverted, and a worse one, since it caps unrelated people against each
  // other. Only the mapped form, deliberately: `::` and `::1` are the unspecified and loopback
  // addresses rather than IPv4 anything, and the IPv4-*compatible* `::a.b.c.d` is deprecated, never
  // sent by Cloudflare, and safe to leave grouped.
  if (groups[5] === 0xffff && groups.slice(0, 5).every((group) => group === 0)) {
    return `v4:${groups[6]}:${groups[7]}`
  }
  return `v6:${groups.slice(0, IPV6_PREFIX_GROUPS).join(":")}`
}

/**
 * The eight 16-bit groups of an IPv6 address, or `null` if it is not one.
 *
 * Written out rather than pattern-matched because the comparison has to be on **values**: `2001:db8::1`
 * and `2001:0db8:0:0:0:0:0:1` are the same address, and a string compare of the two says otherwise —
 * which would hand the same client two identities and reopen the hole this exists to close.
 */
function expandIpv6(text: string): number[] | null {
  // A zone index (`%eth0`) and brackets are not part of the address. Neither appears in
  // `cf-connecting-ip`, and stripping them costs one line against a whole class of near-miss.
  let address = text.replace(/^\[|\]$/g, "")
  const zone = address.indexOf("%")
  if (zone !== -1) {
    address = address.slice(0, zone)
  }

  const halves = address.split("::")
  if (halves.length > 2) {
    return null
  }
  const [leftText, rightText] = [halves[0] ?? "", halves[1] ?? ""]
  const left = leftText === "" ? [] : leftText.split(":")
  const right = rightText === "" ? [] : rightText.split(":")

  // A trailing dotted quad — `::ffff:1.2.3.4` — occupies the last two groups.
  const tail = right.length > 0 ? right : left
  if (tail.length > 0 && (tail.at(-1) as string).includes(".")) {
    const quad = (tail.pop() as string).split(".")
    if (quad.length !== 4) {
      return null
    }
    const octets = quad.map(Number)
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null
    }
    const [a, b, c, d] = octets as [number, number, number, number]
    tail.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16))
  }

  const parsed = (parts: string[]): number[] | null => {
    const values: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
        return null
      }
      values.push(Number.parseInt(part, 16))
    }
    return values
  }
  const head = parsed(left)
  const foot = parsed(right)
  if (head === null || foot === null) {
    return null
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : null
  }
  const gap = 8 - head.length - foot.length
  // `::` must stand for at least one group, so a compressed form that already has eight is invalid.
  if (gap < 1) {
    return null
  }
  return [...head, ...Array.from({ length: gap }, () => 0), ...foot]
}

/**
 * The identity for a request source.
 *
 * Callers pass the client IP and, where a request has one, the ASN. The **address is narrowed to what
 * the client does not control** first (`sourcePrefix`) — that is the part doing the work. The ASN is
 * additional key material, not a defence against a botnet: it can only ever split one identity into
 * two, never merge two into one, so hosts on one network still key separately. `docs/ARCHITECTURE.md`
 * §7 is what a botnet is actually bounded by — the global cap and proof of work.
 *
 * Both are inputs to one HMAC rather than separate values, because a per-source cap wants one key.
 */
export async function sourceHash(secret: string, ip: string, asn?: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  // A separator, so ("1.2.3.4", 5) and ("1.2.3.45", undefined) cannot produce the same input.
  const material = `${sourcePrefix(ip)}|${asn ?? ""}`
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material)),
  )

  let hex = ""
  for (const byte of mac.subarray(0, RETAINED_BYTES)) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}
