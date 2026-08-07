/**
 * Stateless proof-of-work.
 *
 * `docs/ARCHITECTURE.md` §7 calls this "the load-bearing control: the only one that raises attacker
 * cost without an account or a stored identifier." With no accounts there is nothing to rate-limit
 * per user, so making `POST /v1/tunnels` *cost* something is the substitute.
 *
 * **Nothing is stored server-side.** A challenge carries its own integrity as an HMAC over its own
 * parameters, so `GET /v1/challenge` costs one HMAC and cannot be exhausted — issuing challenges is
 * not a resource an attacker can drain. That is the whole reason for the design; a table of
 * outstanding challenges would itself be the attack surface.
 *
 * Pure logic, heavily unit-tested, no bindings — which is what lets it live in a package rather than
 * in one of the Workers. **Both Workers use this one implementation** (ADR-0047): `apps/node` gates
 * `POST /v1/tunnels` with it and `apps/registry` gates `POST /v1/nodes`. The two sign with *different*
 * secrets, so a challenge from one is not solvable for the other — sharing the algorithm is not
 * sharing the trust boundary.
 */

/** Fields a challenge commits to. Everything needed to verify it later, and nothing else. */
export interface ChallengePayload {
  /** Expiry, epoch milliseconds. */
  readonly exp: number
  /** Required leading zero bits. */
  readonly bits: number
  /** Random, so two challenges issued in the same millisecond differ. */
  readonly salt: string
}

export interface IssuedChallenge {
  readonly challenge: string
  readonly difficulty: number
  readonly expiresAt: number
}

/**
 * How long a challenge stays solvable.
 *
 * Long enough for a slow machine to solve a 20-bit challenge and make the follow-up request;
 * short enough that a pre-computed batch has little value. Solving takes ~100 ms on a typical
 * laptop, so two minutes is ~1000x headroom rather than a tight deadline.
 */
export const CHALLENGE_TTL_MS = 120_000

/** Rejects a difficulty outside this range rather than trusting the caller's arithmetic. */
export const MIN_BITS = 1
export const MAX_BITS = 32

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

/**
 * Issues a challenge: `base64url(payload).base64url(mac)`.
 *
 * The MAC covers the encoded payload, so difficulty and expiry cannot be edited by the client.
 * A client that lowers `bits` in the payload invalidates the MAC.
 */
export async function issueChallenge(
  secret: string,
  bits: number,
  now: number,
): Promise<IssuedChallenge> {
  if (!Number.isInteger(bits) || bits < MIN_BITS || bits > MAX_BITS) {
    throw new RangeError(`difficulty must be an integer in ${MIN_BITS}..${MAX_BITS}, got ${bits}`)
  }

  const salt = base64url(crypto.getRandomValues(new Uint8Array(12)))
  const expiresAt = now + CHALLENGE_TTL_MS
  const payload: ChallengePayload = { exp: expiresAt, bits, salt }

  const encoded = base64url(encoder.encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(encoded)))

  return { challenge: `${encoded}.${base64url(mac)}`, difficulty: bits, expiresAt }
}

/** Why a solution was rejected. Maps onto the registry's codes. */
export type PowRejection = "malformed" | "bad-signature" | "expired" | "insufficient-work"

export type PowResult = { ok: true; bits: number } | { ok: false; reason: PowRejection }

/**
 * Verifies a challenge and its nonce.
 *
 * Order matters: signature **before** expiry. Checking expiry first would answer a question about
 * an unauthenticated payload, letting a caller learn whether a forged `exp` was in the past — and
 * more practically, it invites reporting `CHALLENGE_EXPIRED` (retryable) for a forged challenge
 * that should report `POW_INVALID` (not retryable).
 */
export async function verifyChallenge(
  secret: string,
  challenge: string,
  nonce: string,
  now: number,
): Promise<PowResult> {
  const parts = challenge.split(".")
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" }
  }
  const [encoded, signature] = parts as [string, string]

  let signatureValid: boolean
  try {
    const key = await hmacKey(secret)
    signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64url(signature),
      encoder.encode(encoded),
    )
  } catch {
    // A signature that is not valid base64 is a malformed challenge, not a crypto failure.
    return { ok: false, reason: "malformed" }
  }
  if (!signatureValid) {
    return { ok: false, reason: "bad-signature" }
  }

  let payload: ChallengePayload
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(encoded))) as ChallengePayload
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (
    typeof payload.exp !== "number" ||
    typeof payload.bits !== "number" ||
    typeof payload.salt !== "string"
  ) {
    return { ok: false, reason: "malformed" }
  }

  if (now > payload.exp) {
    return { ok: false, reason: "expired" }
  }

  const solved = await hasLeadingZeroBits(`${challenge}.${nonce}`, payload.bits)
  return solved ? { ok: true, bits: payload.bits } : { ok: false, reason: "insufficient-work" }
}

/**
 * Whether `SHA-256(input)` starts with at least `bits` zero bits.
 *
 * Bit-level, not "starts with N hex zeros". A hex-digit check can only express multiples of four,
 * which makes difficulty far too coarse a dial: 16 bits to 20 bits is a 16x cost jump, and there
 * is nothing in between when the whole point is to raise cost gradually under load.
 */
export async function hasLeadingZeroBits(input: string, bits: number): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)))
  let remaining = bits
  for (const byte of digest) {
    if (remaining >= 8) {
      if (byte !== 0) return false
      remaining -= 8
      continue
    }
    if (remaining === 0) return true
    // The final partial byte: its top `remaining` bits must be zero.
    return byte >>> (8 - remaining) === 0
  }
  return remaining === 0
}

/** Solves a challenge. Test and client-side helper; the server never calls it. */
export async function solveChallenge(challenge: string, bits: number): Promise<string> {
  for (let nonce = 0; ; nonce += 1) {
    const candidate = String(nonce)
    if (await hasLeadingZeroBits(`${challenge}.${candidate}`, bits)) {
      return candidate
    }
  }
}
