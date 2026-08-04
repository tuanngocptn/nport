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
    })
  }

  /**
   * Live leases, for the global cap.
   *
   * Prunes expired rows first, so a lost `forget` — a Durable Object destroyed, a compensation that
   * never ran — costs at most one lease's worth of headroom until its expiry passes, rather than
   * permanently inflating the count until someone notices NPort reporting capacity it has.
   */
  async activeCount(): Promise<number> {
    this.#prune(Date.now())
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM lease_index")
      .one()
    return row.count
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
   * Redeems a solved challenge, once.
   *
   * Returns `false` if this challenge has already been used — the replay guard that makes the
   * proof-of-work cost *per tunnel* rather than *per two minutes*. Without it, one solved challenge
   * creates unlimited tunnels inside its validity window, and the control `docs/ARCHITECTURE.md` §7
   * calls load-bearing carries no load at all.
   *
   * This does not contradict the "nothing is stored server-side" property of `GET /v1/challenge`.
   * That property is about *issuing*: issuing stays free and unexhaustible because nothing is written
   * until a caller has already paid the work. A row here costs an attacker a full solve.
   */
  async spendChallenge(mac: string, expiresAt: number): Promise<boolean> {
    const now = Date.now()
    this.#prune(now)
    // Check-then-insert is safe here for the same reason it is in `SubdomainLease.claim`: there is no
    // `await` between the two statements, and `ctx.storage.sql` is synchronous, so two concurrent
    // redemptions of one challenge cannot both observe it unspent.
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
