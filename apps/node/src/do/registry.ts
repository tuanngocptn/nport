import { DurableObject } from "cloudflare:workers"

import type { Env } from "../types"

/**
 * The singleton: global lease index, counters, and the challenge ledger.
 *
 * Addressed as `idFromName("global")`, so every create passes through one object. That is a
 * deliberate serialization point and the only place a *global* fact can be true — a per-subdomain
 * object cannot know how many tunnels exist, and module scope cannot either, because isolates come
 * and go (`apps/node/CLAUDE.md` rule 10).
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
      // One row, holding when this node last claimed a registration heartbeat. A new table rather
      // than a column so it applies to Durable Objects that already exist: `CREATE TABLE IF NOT
      // EXISTS` runs on every instantiation and creates a missing table, while a missing *column*
      // on an existing object would need an explicit `ALTER TABLE`.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS clock (
          key   TEXT PRIMARY KEY,
          value INTEGER NOT NULL
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

  /**
   * Whether the global cap leaves room for another lease.
   *
   * Split out from `admitCreate` for the v2 shim, which has no challenge to redeem: a v2 client cannot
   * solve a proof of work, so there is nothing to put in the ledger. The capacity question is the only
   * part of admission that still applies.
   */
  async hasCapacity(maxActive: number): Promise<boolean> {
    this.#prune(Date.now())
    const active = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM lease_index")
      .one().count
    return active < maxActive
  }

  /**
   * How many leases are live right now.
   *
   * Published by `GET /v1/meta` as `activeTunnels`, so the registry's probe — and through it every
   * client's node selection — can see this node's headroom (ADR-0046). Split out from
   * [`hasCapacity`] rather than reusing it because the two answer different questions: that one is a
   * gate ("is there room for one more"), this one is a number a stranger reads.
   *
   * Derived and best-effort, like everything else in this object: a lost index update degrades the
   * count, never a guarantee. A node that undercounts looks emptier than it is and gets picked more
   * often, which the per-source caps and the global cap still bound — so the failure mode is uneven
   * load, not an overrun.
   */
  /**
   * The number `GET /v1/meta` publishes, **and a heartbeat claim, in one hop.**
   *
   * Two answers from one Durable Object call on purpose. `/v1/meta` is polled by every client at
   * startup and already paid for this hop (rule 13); adding a second one to decide whether to
   * re-register would double the cost of the most-polled route on the node.
   *
   * `shouldRegister` is a **claim, not a question** — it records the moment it says yes, so two
   * concurrent requests cannot both be told to register. Check-then-write with no `await` between
   * them, which is safe here for the same reason `admitCreate` is: `ctx.storage.sql` is synchronous.
   *
   * **Why registration is driven by traffic at all** (ADR-0049, amended): Cloudflare cron triggers are
   * best-effort, and staging went two hours without one while serving normally — long enough for the
   * registry to age the node out of the directory and for a fresh client to get `NO_NODE_AVAILABLE`
   * from a node that was up the whole time. A node carrying traffic is *provably* alive, which is a
   * better liveness signal than a scheduler tick, and this makes the two independent: either one alone
   * keeps a node listed.
   *
   * A node with **no** traffic still depends on the cron, and that is the right way round — nobody is
   * affected by an idle node slipping out of a directory nobody is reading it from.
   */
  async snapshot(
    heartbeatAfterMs: number,
    now: number,
  ): Promise<{ readonly activeTunnels: number; readonly shouldRegister: boolean }> {
    this.#prune(now)

    const activeTunnels = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM lease_index")
      .one().count

    const last =
      this.ctx.storage.sql
        .exec<{ value: number }>("SELECT value FROM clock WHERE key = 'heartbeat_at'")
        .toArray()[0]?.value ?? 0

    const shouldRegister = now - last >= heartbeatAfterMs
    if (shouldRegister) {
      this.ctx.storage.sql.exec(
        "INSERT INTO clock (key, value) VALUES ('heartbeat_at', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        now,
      )
    }

    return { activeTunnels, shouldRegister }
  }

  async activeCount(): Promise<number> {
    this.#prune(Date.now())
    return this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM lease_index")
      .one().count
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
