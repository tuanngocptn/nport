/**
 * Ownership without accounts.
 *
 * `docs/ARCHITECTURE.md` §7: create returns a 256-bit `ownerToken` **once**, and the server stores
 * only `SHA-256(ownerToken)`. Heartbeat, delete, and refresh require it. That is the whole ownership
 * model — there is no account to check against, so the only proof available is possession of a
 * secret the server cannot re-derive.
 *
 * This closes two v2 holes at once. `DELETE {subdomain, tunnelId}` was accepted from anyone, so any
 * caller could remove any tunnel — including the `api` record itself. And create would take over a
 * subdomain whose tunnel merely *looked* inactive, so a user whose connection flapped could lose
 * their name to a stranger (defect R7).
 *
 * Note what is deliberately absent: any function that returns a token given a subdomain. An API
 * that can re-issue a credential to an anonymous caller has no ownership model at all.
 */

/** 256 bits, per `docs/ARCHITECTURE.md` §7. Not tunable — the contract documents the width. */
const OWNER_TOKEN_BYTES = 32

/** SHA-256 output width, and therefore the stored hash's width. */
export const OWNER_TOKEN_HASH_BYTES = 32

/**
 * Mints a token: 32 random bytes, base64url.
 *
 * base64url rather than hex so it fits a JSON body and a shell variable without escaping, and
 * without the `+`/`/`/`=` that would need URL-encoding if a client ever put it in a query string.
 */
export function mintOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(OWNER_TOKEN_BYTES))
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

/**
 * `SHA-256(token)`, which is the only form the server keeps.
 *
 * A plain digest rather than a password hash on purpose: the token is 256 bits of entropy from a
 * CSPRNG, not a human-chosen secret, so there is no dictionary to slow down. Argon2 here would cost
 * CPU on every heartbeat — one per tunnel per 30 s, the dominant request cost in the system
 * (`docs/ARCHITECTURE.md` §6) — and buy nothing.
 */
export async function hashOwnerToken(token: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return new Uint8Array(digest)
}

/**
 * Constant-time comparison of two stored hashes.
 *
 * Both sides are digests, so a timing leak would reveal a prefix of a hash rather than of the token
 * — not obviously exploitable. It is still constant-time, because the alternative is an argument
 * about exploitability in a security review, and `!==` on the first differing byte is not cheaper in
 * any way that matters.
 */
export function hashesMatch(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  // `entries()` rather than an index loop so `byte` needs no assertion, and `?? 0` on the other side
  // is unreachable: the length check above already guarantees `right` has this index. The order
  // matters — with the guard first, the fallback can never make two different-length inputs compare
  // equal, which is the one thing this function must never do.
  for (const [index, byte] of left.entries()) {
    difference |= byte ^ (right[index] ?? 0)
  }
  return difference === 0
}
