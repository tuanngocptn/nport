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
 * The identity for a request source.
 *
 * Callers pass the client IP and, where a request has one, the ASN — so that a botnet spread across
 * one network cannot present as thousands of unrelated sources. Both are inputs to the same HMAC
 * rather than separate values, because a per-source cap wants one key.
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
  const material = `${ip}|${asn ?? ""}`
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material)),
  )

  let hex = ""
  for (const byte of mac.subarray(0, RETAINED_BYTES)) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}
