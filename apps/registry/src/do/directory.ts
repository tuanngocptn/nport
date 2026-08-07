import { DurableObject } from "cloudflare:workers"

import type { Node, NodeStatus } from "@nport/contract"

import type { Env } from "../types"

/**
 * The directory: every listed node, and the proof-of-work replay ledger.
 *
 * Addressed as `idFromName("global")`, so every registration and every listing passes through one
 * object. That is a deliberate serialization point and the only place a *global* fact can be true —
 * "is this id already taken", "are we at `MAX_NODES`" — because module scope is not per-request and
 * isolates come and go.
 *
 * **The whole registry is one Durable Object**, unlike `apps/node`, which shards per subdomain and per
 * source. The reason is scale: there are hundreds of nodes at most, not hundreds of thousands of
 * tunnels, and every cron run reads all of them anyway to probe them. Sharding would buy nothing and
 * cost the one property that matters here — that `id` uniqueness is decided in one place with no
 * `await` between the check and the insert.
 *
 * **Nothing here is authoritative about a node's health.** Status and capacity are what the node last
 * *told us*, aged by the sweep; the node itself is authoritative, and this is a cache of what it said
 * (ADR-0049 — under ADR-0046 the same sentence was true of a probe instead).
 */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      // `active_tunnels` and `max_active_tunnels` are nullable on purpose: **absent means unknown,
      // not zero**. A node that will not report its own count gets listed without one, and storing 0
      // instead would make it look empty and get it picked first by every client.
      //
      // **No `consecutive_failures`.** It counted probe attempts, and there are none (ADR-0049).
      // `last_seen_at` alone answers what the sweep needs to know, and it is a timestamp the node
      // supplied rather than a counter this object maintained across runs — so a missed cron tick
      // shifts a status by one interval instead of losing a whole failure's worth of history.
      //
      // Changing a column list in a `CREATE TABLE IF NOT EXISTS` only takes effect on a fresh object,
      // and that is safe **only because this Worker has never been deployed**. Once it has, a column
      // change needs an explicit `ALTER TABLE` here — the constructor is the migration, and
      // `wrangler rollback` reverts code and not schema (`docs/RELEASE.md`).
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS node (
          id                 TEXT PRIMARY KEY,
          url                TEXT NOT NULL,
          domain             TEXT NOT NULL,
          region             TEXT,
          version            TEXT NOT NULL,
          status             TEXT NOT NULL,
          active_tunnels     INTEGER,
          max_active_tunnels INTEGER,
          last_seen_at       INTEGER NOT NULL,
          registered_at      INTEGER NOT NULL
        )
      `)
      // The proof-of-work ledger, exactly as `apps/node`'s `Registry` keeps one and for the same
      // reason (ADR-0027): without it, one solved challenge registers unlimited nodes inside its
      // two-minute validity window, and the control that is supposed to cost something does not.
      // Bounded by the challenge TTL rather than by row count, and pruned on every write, so it
      // cannot grow until an attacker has already paid for a solve.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS spent_challenge (
          mac        TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )
      `)
    })
  }

  /**
   * Admits a registration: capacity, then the challenge ledger, in one round trip.
   *
   * Order matters, and it is the order `apps/node`'s `admitCreate` uses for the same reason:
   * **capacity before the ledger**. A `503` is our fault and retryable, so it must not burn a solved
   * challenge; a replay is the caller's fault and must.
   *
   * No `await` between the two checks, so two concurrent redemptions of one challenge cannot both
   * observe it unspent — `ctx.storage.sql` is synchronous, which is what makes check-then-insert
   * safe here.
   */
  async admitRegistration(
    mac: string,
    ledgerExpiresAt: number,
    nodeId: string,
    maxNodes: number,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: "capacity" | "replay" }
  > {
    const now = Date.now()
    this.#prune(now)

    // A refresh of a node already listed does not consume a slot — otherwise a full directory could
    // never be refreshed, and every node in it would age out of its own accord.
    const known =
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM node WHERE id = ?", nodeId)
        .one().count > 0
    if (!known) {
      const listed = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM node")
        .one().count
      if (listed >= maxNodes) {
        return { ok: false, reason: "capacity" }
      }
    }

    if (!this.#spend(mac, ledgerExpiresAt)) {
      return { ok: false, reason: "replay" }
    }
    return { ok: true }
  }

  /**
   * The domain a listed id is registered against, or `null` if the id is free.
   *
   * What `id-taken` is decided on: an id may be refreshed by whoever proved the *same* domain, and
   * claimed by nobody else. Without this, publishing a TXT record for your own domain would let you
   * take over any id you liked, which is the takeover shape invariant 8 exists to prevent one layer
   * down.
   */
  async domainFor(nodeId: string): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ domain: string }>("SELECT domain FROM node WHERE id = ?", nodeId)
      .toArray()[0]
    return row?.domain ?? null
  }

  /**
   * Records a registration — which is also the node's heartbeat (ADR-0049).
   *
   * `registered_at` survives a refresh; everything else is replaced, including `last_seen_at`, which
   * is what the sweep ages. A node that had gone `down` for missing a few ticks comes straight back to
   * `up` on its next successful registration, with no proof of work beyond the one it just paid.
   *
   * **`active_tunnels` is overwritten even when the new value is null**, deliberately: a node that
   * stops reporting its count should read as "unknown", not go on advertising a number from twenty
   * minutes ago that a client would sort on.
   */
  async upsert(entry: Node): Promise<void> {
    const now = Date.now()
    this.ctx.storage.sql.exec(
      `INSERT INTO node (id, url, domain, region, version, status, active_tunnels,
                         max_active_tunnels, last_seen_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         domain = excluded.domain,
         region = excluded.region,
         version = excluded.version,
         status = excluded.status,
         active_tunnels = excluded.active_tunnels,
         max_active_tunnels = excluded.max_active_tunnels,
         last_seen_at = excluded.last_seen_at`,
      entry.id,
      entry.url,
      entry.domain,
      entry.region ?? null,
      entry.version,
      entry.status,
      entry.activeTunnels ?? null,
      entry.maxActiveTunnels ?? null,
      entry.lastSeenAt,
      now,
    )
  }

  /**
   * Every listed node, newest registration last.
   *
   * **Includes `down` nodes.** A client is meant to show them as unavailable rather than have them
   * vanish, which is what the design asks for — full and offline nodes are disabled, not hidden
   * (`docs/FEATURES.md` §3) — and it is also the honest answer: a node that is down now was up
   * fifteen minutes ago and may be up again shortly.
   */
  async list(): Promise<Node[]> {
    const rows = this.ctx.storage.sql
      .exec<NodeRow>("SELECT * FROM node ORDER BY registered_at ASC, id ASC")
      .toArray()
    return rows.map(toNode)
  }

  /**
   * Ages every listing against its own `last_seen_at`, and deletes what has gone quiet for too long.
   *
   * **Three statements and no subrequests**, replacing a loop that fetched every node in the directory
   * (ADR-0049). The order is delete-then-mark: doing it the other way would mark a row `down` and then
   * delete it in the same run, spending a write on a row that is about to be gone.
   *
   * `delistAfterMs` is expected to be the larger of the two, and nothing enforces that — if they were
   * swapped, a node would be deleted before it was ever marked `down`, which is a policy choice a
   * configuration is allowed to make and not a corruption. The deployed values live in
   * `wrangler.jsonc` and `test/sweep.test.ts` passes its own, so no test asserts them.
   *
   * Capacity is cleared on the way to `down` for the same reason `upsert` overwrites it with null: a
   * stale "12 of 100 tunnels" on a node that has not been heard from in a quarter of an hour is a
   * number a client would rank on, and it means nothing.
   */
  async sweepStale(
    downAfterMs: number,
    delistAfterMs: number,
    now: number,
  ): Promise<{
    readonly listed: number
    readonly up: number
    readonly down: number
    readonly delisted: string[]
  }> {
    const delisted = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM node WHERE last_seen_at < ?", now - delistAfterMs)
      .toArray()
      .map((row) => row.id)
    if (delisted.length > 0) {
      this.ctx.storage.sql.exec("DELETE FROM node WHERE last_seen_at < ?", now - delistAfterMs)
    }

    this.ctx.storage.sql.exec(
      `UPDATE node
          SET status = 'down',
              active_tunnels = NULL
        WHERE last_seen_at < ? AND status != 'down'`,
      now - downAfterMs,
    )

    const counts = this.ctx.storage.sql
      .exec<{ listed: number; down: number }>(
        `SELECT COUNT(*) AS listed,
                SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down
           FROM node`,
      )
      .one()

    // `SUM` over zero rows is null, which arithmetic would quietly turn into NaN in the log line.
    const down = Number(counts.down ?? 0)
    return { listed: counts.listed, up: counts.listed - down, down, delisted }
  }

  /**
   * Synchronous, so it composes into `admitRegistration` without introducing an await.
   *
   * Check-then-insert is safe for exactly the reason it is in `apps/node`'s `Registry`: there is no
   * `await` between the two statements and `ctx.storage.sql` is synchronous, so two concurrent
   * redemptions of one challenge cannot both observe it unspent.
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
  }
}

/**
 * The stored shape. Nullable columns are `null`, never absent.
 *
 * The index signature is what `SqlStorage.exec`'s type parameter requires — it hands back rows as a
 * record of `SqlStorageValue`, so a plain interface does not satisfy the constraint. Written out
 * rather than reaching for `Record<string, SqlStorageValue>`, which would type every column as
 * "could be anything a database holds" and lose the nullability this file turns into absent fields.
 */
interface NodeRow extends Record<string, SqlStorageValue> {
  id: string
  url: string
  domain: string
  region: string | null
  version: string
  status: string
  active_tunnels: number | null
  max_active_tunnels: number | null
  last_seen_at: number
  registered_at: number
}

/**
 * A row as the contract describes it.
 *
 * `null` becomes **absent**, not `0` and not `null`: the contract's optional fields are zod
 * `.optional()`, which accepts a missing key and rejects an explicit `null` — a distinction that has
 * already cost this repo one bug on the client side, where `"subdomain": null` made every
 * `nport 3000` fail with a 400.
 */
function toNode(row: NodeRow): Node {
  return {
    id: row.id,
    url: row.url,
    domain: row.domain,
    ...(row.region === null ? {} : { region: row.region }),
    version: row.version,
    status: row.status as NodeStatus,
    ...(row.active_tunnels === null ? {} : { activeTunnels: row.active_tunnels }),
    ...(row.max_active_tunnels === null ? {} : { maxActiveTunnels: row.max_active_tunnels }),
    lastSeenAt: row.last_seen_at,
  }
}
