import { DurableObject } from "cloudflare:workers"

import type { Env } from "../types"
import type { LeaseFailure } from "./subdomain-lease"

/**
 * One Durable Object per **source**, addressed by `idFromName(sourceHash)`.
 *
 * `docs/ARCHITECTURE.md` §7: with no accounts there is nothing to rate-limit per user, so the
 * substitute is a per-source identity that costs nothing to compute and reveals nothing —
 * `HMAC(ip, secret)` over the address and ASN. **A raw IP never reaches this object**; the name it is
 * addressed by is already the hash (rule 11).
 *
 * Sharded per source on purpose. A singleton holding every source's counters would serialize every
 * create in the system behind one object and hand an attacker a hot spot to aim at; here, hammering
 * one source's quota loads only that source's object, and raises only that source's cost.
 *
 * ## What each limit is for
 *
 * - **Concurrent holds** bound how much of the namespace and how many Cloudflare tunnels one source
 *   can occupy at once. Released on teardown.
 * - **Creates per hour** bound how much *work* one source can make us do, including work that failed.
 *   Deliberately not refunded on failure: a create that got as far as calling Cloudflare cost us the
 *   calls whether or not it succeeded, and refunding would let an attacker with a reliable way to
 *   fail — a name already taken, say — create without limit.
 * - **Proof-of-work difficulty** rises with recent creates, so the tenth tunnel in an hour costs
 *   noticeably more than the first while a first-time user still pays the ~100 ms floor.
 */

/**
 * How long an unconfirmed reservation holds a concurrency slot.
 *
 * A slot is taken before provisioning and confirmed when the lease goes `ACTIVE`. If the isolate dies
 * in between, or the claim loses a race for the name, the slot must not be held for the lease's full
 * lifetime — so an unconfirmed reservation simply expires. One minute is far longer than a
 * provisioning run and far shorter than a lease.
 */
const RESERVATION_TTL_MS = 60_000

/** The window the hourly create cap is measured over. */
const CREATE_WINDOW_MS = 3_600_000

/**
 * Creates within the window per extra bit of proof-of-work.
 *
 * Every bit doubles the expected work, so this is aggressive by design: at four creates per bit, a
 * source's twentieth tunnel in an hour costs ~32x its first. Chosen with `MAX_CREATES_PER_HOUR_PER_SOURCE`
 * in mind — the escalation should still be climbing when the hard cap arrives, or it would be
 * decoration.
 */
const CREATES_PER_EXTRA_BIT = 4

export interface QuotaLimits {
  readonly maxConcurrent: number
  readonly maxPerHour: number
}

export type ReserveResult = { readonly ok: true } | LeaseFailure

export class SourceQuota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      // One row per subdomain this source currently holds or is provisioning.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hold (
          subdomain  TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          confirmed  INTEGER NOT NULL
        )
      `)
      // One row per create attempt, pruned to the window. Rows rather than a counter, because a
      // sliding window needs the timestamps: a counter reset on the hour would let a source spend
      // its whole quota twice in two minutes across the boundary.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS create_attempt (
          at INTEGER NOT NULL
        )
      `)
    })
  }

  /**
   * Takes a concurrency slot and records a create attempt, or explains which limit was hit.
   *
   * **Atomic by construction**, the same way `SubdomainLease.claim` is: every statement below is
   * synchronous and there is no `await` anywhere in the method, so two concurrent creates from one
   * source cannot both observe the last free slot. Adding an `await` here reintroduces exactly the
   * over-limit race this exists to prevent.
   */
  async reserve(subdomain: string, limits: QuotaLimits): Promise<ReserveResult> {
    const now = Date.now()
    this.#prune(now)

    const attempts = this.#createsSince(now - CREATE_WINDOW_MS)
    if (attempts >= limits.maxPerHour) {
      // The oldest attempt in the window is what frees up first, so that is when retrying can work.
      const oldest = this.ctx.storage.sql
        .exec<{ at: number | null }>(
          "SELECT MIN(at) AS at FROM create_attempt WHERE at >= ?",
          now - CREATE_WINDOW_MS,
        )
        .one()
      const resetAt = (oldest.at ?? now) + CREATE_WINDOW_MS
      return { ok: false, code: "CREATE_QUOTA_EXCEEDED", details: { resetAt } }
    }

    const existing = this.ctx.storage.sql
      .exec<{ confirmed: number }>(
        "SELECT confirmed FROM hold WHERE subdomain = ? LIMIT 1",
        subdomain,
      )
      .toArray()[0]

    // A **confirmed** hold means this source already has a live lease for this name. The attempt is
    // charged and allowed through so that `SubdomainLease` gives the real answer — but the hold is left
    // strictly alone, and that is load-bearing.
    //
    // Touching it was a hole that defeated the cap outright. `reserve` used to overwrite any existing
    // hold's expiry with the 60-second reservation window, and the route's failure path then deleted
    // it — so a source at its cap could ask again for a name it already held, take the `409` the lease
    // correctly returns, and come away one slot lighter. Repeat once per lease and the cap is gone,
    // bounded only by the hourly quota. Hence: no write here, and `releaseReservation` below.
    if (existing?.confirmed === 1) {
      this.ctx.storage.sql.exec("INSERT INTO create_attempt (at) VALUES (?)", now)
      return { ok: true }
    }

    // An **unconfirmed** hold is this source's own reservation from a previous attempt in the last
    // minute, so re-reserving the same name is not a second slot. This is the case the exemption was
    // written for: a client retrying a create for a subdomain it is already provisioning.
    if (existing === undefined && this.#holds() >= limits.maxConcurrent) {
      return { ok: false, code: "CONCURRENCY_LIMIT", details: { limit: limits.maxConcurrent } }
    }

    this.ctx.storage.sql.exec("INSERT INTO create_attempt (at) VALUES (?)", now)
    this.ctx.storage.sql.exec(
      `INSERT INTO hold (subdomain, expires_at, confirmed) VALUES (?, ?, 0)
       ON CONFLICT(subdomain) DO UPDATE SET expires_at = excluded.expires_at`,
      subdomain,
      now + RESERVATION_TTL_MS,
    )
    return { ok: true }
  }

  /** Promotes a reservation to the lease's own lifetime, once the lease is `ACTIVE`. */
  async confirm(subdomain: string, expiresAt: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO hold (subdomain, expires_at, confirmed) VALUES (?, ?, 1)
       ON CONFLICT(subdomain) DO UPDATE SET expires_at = excluded.expires_at, confirmed = 1`,
      subdomain,
      expiresAt,
    )
  }

  /**
   * Frees a concurrency slot, confirmed or not. Tolerates a slot that was never taken.
   *
   * For **teardown**: the lease is gone, so the hold must go with it. A caller undoing its own failed
   * create wants `releaseReservation` instead.
   *
   * Does **not** refund the create attempt — see the class comment.
   */
  async release(subdomain: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM hold WHERE subdomain = ?", subdomain)
  }

  /**
   * Frees a slot **only if it is still an unconfirmed reservation**.
   *
   * For a create that failed: it hands back what this request took and nothing else. The guard is the
   * point — a confirmed hold belongs to a live lease, and deleting one on a failed create is how the
   * cap became evadable by re-requesting an owned name.
   */
  async releaseReservation(subdomain: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM hold WHERE subdomain = ? AND confirmed = 0", subdomain)
  }

  /**
   * The proof-of-work difficulty this source should be issued, in leading zero bits.
   *
   * Read on `GET /v1/challenge`, which makes that endpoint cost one Durable Object read. That is a
   * deliberate amendment to the "nothing is stored, one HMAC" property (ADR-0028): the read is
   * per-source, so an attacker hammering it loads only their own object and raises only their own
   * price, and the request-rate limiter bounds it besides.
   */
  async difficulty(floorBits: number, maxBits: number): Promise<number> {
    const now = Date.now()
    const attempts = this.#createsSince(now - CREATE_WINDOW_MS)
    const extra = Math.floor(attempts / CREATES_PER_EXTRA_BIT)
    return Math.min(maxBits, floorBits + extra)
  }

  /**
   * Live holds and recent attempts.
   *
   * Read only by tests today, and kept for one reason: the difference between "the slot was released"
   * and "the create still counted against the hourly quota" is not observable from outside without it,
   * and that difference is the whole of the refund policy above. Asserting it behaviourally would take
   * twenty more creates, which the request-rate limiter refuses.
   */
  async usage(): Promise<{ readonly holds: number; readonly createsThisHour: number }> {
    const now = Date.now()
    this.#prune(now)
    return {
      holds: this.#holds(),
      createsThisHour: this.#createsSince(now - CREATE_WINDOW_MS),
    }
  }

  #holds(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM hold").one()
      .count
  }

  #createsSince(since: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM create_attempt WHERE at >= ?", since)
      .one().count
  }

  #prune(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM hold WHERE expires_at < ?", now)
    this.ctx.storage.sql.exec("DELETE FROM create_attempt WHERE at < ?", now - CREATE_WINDOW_MS)
  }
}
