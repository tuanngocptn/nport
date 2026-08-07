/**
 * Names for callers who did not ask for one.
 *
 * `nport-<base32(8 random bytes)>` — 64 bits of entropy, so guessing a stranger's tunnel URL is not
 * a thing you can do.
 *
 * v2 generated `user-<Math.random() 0..9999>`: a 10,000-name space, from a non-cryptographic PRNG,
 * with no collision retry. Enumerating every live tunnel took ten thousand requests, and a second
 * caller could silently collide with the first (defect R2). Its other generator, `tun-<timestamp>`,
 * was worse — guessable to the second.
 *
 * The `nport-` prefix is a reserved prefix in `@nport/contract`, so a user cannot claim a name that
 * collides with this space.
 */

/**
 * RFC 4648 base32, lowercased, no padding. **Exactly 32 symbols**, one per 5-bit group.
 *
 * Lowercase because a DNS label is case-insensitive and the lease key is the lowercased name — a
 * mixed-case generated name would normalize to something different from what was handed out.
 *
 * Read with `charAt`, which is typed `string` rather than `string | undefined`, so the lookup needs
 * no non-null assertion. A shorter alphabet would silently emit short names; the length assertion in
 * `owner-token.test.ts` is what catches that.
 */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

/** 64 bits. Enough that collisions are not a design concern; short enough to type. */
const ENTROPY_BYTES = 8

/** `nport-` plus 13 base32 characters — 19 in total, well inside the 63-character DNS limit. */
export function generateSubdomain(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES))
  return `nport-${base32(bytes)}`
}

function base32(bytes: Uint8Array): string {
  let out = ""
  let buffer = 0
  let bits = 0

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET.charAt((buffer >>> bits) & 0b11111)
    }
  }
  if (bits > 0) {
    // The final partial group, left-aligned. 8 bytes is not a multiple of 5 bits, so there is
    // always one: dropping it would throw away 4 bits of the 64.
    out += ALPHABET.charAt((buffer << (5 - bits)) & 0b11111)
  }
  return out
}
