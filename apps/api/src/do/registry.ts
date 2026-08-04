import { DurableObject } from "cloudflare:workers"

import type { Env } from "../types"

/**
 * The singleton: global lease index, counters, and the challenge ledger.
 *
 * Addressed as `idFromName("global")`, so every create passes through one object. That is a
 * deliberate serialization point and the only place a *global* fact can be true — a per-subdomain
 * object cannot know how many tunnels exist, and module scope cannot either, because isolates come
 * and go (`apps/api/CLAUDE.md` rule 10).
 *
 * The index is what the reconciliation sweep will walk: v2's cron handled ~10 tunnels per invocation
 * with no ordering, so the oldest could starve indefinitely (defect R8). The paginating cursor lands
 * with the cron in the next slice; the index it needs exists now because provisioning has to
 * maintain it anyway.
 *
 * **Nothing here is authoritative for a lease.** Ownership and expiry live in `SubdomainLease`. This
 * object holds a derived view, and every method below is written so that losing an update degrades a
 * count rather than a guarantee.
 */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lease_index (
          subdomain   TEXT PRIMARY KEY,
          expires_at  INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL
        )
      `)
      // The proof-of-work ledger. Bounded by the challenge TTL rather than by row count, and pruned
      // on every write, so it cannot grow without an attacker first doing the work.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS spent_challenge (
          mac        TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )
      `)
      // The reconciliation cursor: a single row, so the sweep resumes where the last run stopped.
      // This is the whole fix for v2's cleanup ceiling — its cron handled ~10 tunnels per invocation
      // with no ordering, so the oldest could starve forever (defect R8).
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sweep (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          page       INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    })
  }

  /**
   * The global cap and the challenge-replay ledger, in one round trip.
   *
   * Both facts belong to this object and both gate the same request. Asking separately cost two
   * subrequests and left a gap in which a challenge could be spent for a create the cap then refused,
   * so they are one call with no `await` between the checks.
   *
   * Order matters: capacity **before** the ledger. A `503` is our fault and retryable, so it must not
   * burn a solved challenge; a replay is the caller's fault and must.
   *
   * ## Why a ledger at all
   *
   * Without it, one solved challenge creates unlimited tunnels inside its two-minute validity window,
   * and the control `docs/ARCHITECTURE.md` §7 calls load-bearing carries no load (ADR-0027). It does
   * not contradict the "nothing stored" property of `GET /v1/challenge`: that is about *issuing*, and
   * issuing stays unexhaustible because no row is written until a caller has already paid for a solve.
   */
  async admitCreate(
    mac: string,
    ledgerExpiresAt: number,
    maxActive: number,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: "capacity" | "replay" }
  > {
    const now = Date.now()
    this.#prune(now)

    const active = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM lease_index")
      .one().count
    if (active >= maxActive) {
      return { ok: false, reason: "capacity" }
    }

    if (!this.#spend(mac, ledgerExpiresAt)) {
      return { ok: false, reason: "replay" }
    }
    return { ok: true }
  }

  /** The page the next sweep should read. Starts at 1 and wraps when the account runs out. */
  async sweepPage(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ page: number }>("SELECT page FROM sweep WHERE id = 1")
      .toArray()[0]
    return row?.page ?? 1
  }

  /**
   * Advances the cursor, wrapping to page 1 when the last page has been read.
   *
   * Wrapping rather than stopping, because reconciliation is a standing safety net: an orphan can
   * appear at any time, so the sweep has to keep going round. Bounded per run, unbounded over time.
   */
  async advanceSweep(page: number, hadMore: boolean): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO sweep (id, page, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at`,
      hadMore ? page + 1 : 1,
      Date.now(),
    )
  }

  /**
   * Which of these subdomains have **no** live index entry — the sweep's candidate orphans.
   *
   * A cheap first filter, one call for a whole page instead of one Durable Object hop per tunnel. It is
   * deliberately *not* the decision: the index is a derived view that can be stale or lost, and acting
   * on it alone would let a missing index row get a live tunnel deleted. The caller confirms every
   * candidate against the authoritative `SubdomainLease` before touching anything.
   */
  async withoutLease(subdomains: readonly string[]): Promise<string[]> {
    this.#prune(Date.now())
    return subdomains.filter((subdomain) => {
      const found = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM lease_index WHERE subdomain = ?",
          subdomain,
        )
        .one().count
      return found === 0
    })
  }

  /** Called by a lease when it becomes `ACTIVE`. Idempotent: the same name records once. */
  async record(subdomain: string, expiresAt: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO lease_index (subdomain, expires_at, recorded_at) VALUES (?, ?, ?)
       ON CONFLICT(subdomain) DO UPDATE SET expires_at = excluded.expires_at`,
      subdomain,
      expiresAt,
      Date.now(),
    )
  }

  /** Called when a lease is torn down. Tolerates a name that was never recorded. */
  async forget(subdomain: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM lease_index WHERE subdomain = ?", subdomain)
  }

  /**
   * Synchronous, so it composes into `admitCreate` without introducing an await.
   *
   * Check-then-insert is safe for the same reason it is in `SubdomainLease.claim`: there is no `await`
   * between the two statements, and `ctx.storage.sql` is synchronous, so two concurrent redemptions of
   * one challenge cannot both observe it unspent.
   */
  #spend(mac: string, expiresAt: number): boolean {
    const seen = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM spent_challenge WHERE mac = ?", mac)
      .one()
    if (seen.count > 0) {
      return false
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO spent_challenge (mac, expires_at) VALUES (?, ?)",
      mac,
      expiresAt,
    )
    return true
  }

  #prune(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM spent_challenge WHERE expires_at < ?", now)
    this.ctx.storage.sql.exec("DELETE FROM lease_index WHERE expires_at < ?", now)
  }
}
