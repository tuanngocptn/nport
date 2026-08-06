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
 * **The whole registry is one Durable Object**, unlike `apps/api`, which shards per subdomain and per
 * source. The reason is scale: there are hundreds of nodes at most, not hundreds of thousands of
 * tunnels, and every cron run reads all of them anyway to probe them. Sharding would buy nothing and
 * cost the one property that matters here — that `id` uniqueness is decided in one place with no
 * `await` between the check and the insert.
 *
 * **Nothing here is authoritative about a node's health.** Status and capacity are what the last probe
 * *observed*; the node itself is authoritative, and this is a cache of what it said (ADR-0046).
 */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      // `active_tunnels` and `max_active_tunnels` are nullable on purpose: **absent means unknown,
      // not zero** (ADR-0046). A node on an older build publishes neither, and storing 0 would make
      // it look empty and get it picked first by every client.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS node (
          id                   TEXT PRIMARY KEY,
          url                  TEXT NOT NULL,
          domain               TEXT NOT NULL,
          region               TEXT,
          version              TEXT NOT NULL,
          status               TEXT NOT NULL,
          active_tunnels       INTEGER,
          max_active_tunnels   INTEGER,
          last_probed_at       INTEGER NOT NULL,
          registered_at        INTEGER NOT NULL,
          consecutive_failures INTEGER NOT NULL DEFAULT 0
        )
      `)
      // The proof-of-work ledger, exactly as `apps/api`'s `Registry` keeps one and for the same
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
   * Order matters, and it is the order `apps/api`'s `admitCreate` uses for the same reason:
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
   * Records a registration, together with what the probe just observed.
   *
   * One statement, because a registration is only accepted *after* a successful probe — so there is
   * never a moment where a node is listed with no observation. `registered_at` survives a refresh;
   * everything else is replaced.
   */
  async upsert(entry: Node): Promise<void> {
    const now = Date.now()
    this.ctx.storage.sql.exec(
      `INSERT INTO node (id, url, domain, region, version, status, active_tunnels,
                         max_active_tunnels, last_probed_at, registered_at, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         domain = excluded.domain,
         region = excluded.region,
         version = excluded.version,
         status = excluded.status,
         active_tunnels = excluded.active_tunnels,
         max_active_tunnels = excluded.max_active_tunnels,
         last_probed_at = excluded.last_probed_at,
         consecutive_failures = 0`,
      entry.id,
      entry.url,
      entry.domain,
      entry.region ?? null,
      entry.version,
      entry.status,
      entry.activeTunnels ?? null,
      entry.maxActiveTunnels ?? null,
      entry.lastProbedAt,
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

  /** What the cron needs: every node's id and url, so it can probe each one. */
  async probeTargets(): Promise<Array<{ id: string; url: string }>> {
    return this.ctx.storage.sql
      .exec<{ id: string; url: string }>("SELECT id, url FROM node ORDER BY id ASC")
      .toArray()
  }

  /**
   * Records a successful probe: the node is `up`, and the failure streak resets.
   */
  async recordSuccess(
    nodeId: string,
    observed: { activeTunnels?: number; maxActiveTunnels?: number },
    now: number,
  ): Promise<void> {
    // `version` is deliberately untouched: `/v1/meta` publishes `minClientVersion`, which is the floor
    // a node imposes on clients, not the node's own build. A node's version is what it declared at
    // registration and a probe cannot correct it.
    this.ctx.storage.sql.exec(
      `UPDATE node
          SET status = 'up',
              consecutive_failures = 0,
              active_tunnels = ?,
              max_active_tunnels = ?,
              last_probed_at = ?
        WHERE id = ?`,
      observed.activeTunnels ?? null,
      observed.maxActiveTunnels ?? null,
      now,
      nodeId,
    )
  }

  /**
   * Records a failed probe, and reports whether the node was delisted.
   *
   * Three states rather than two, because "not answering right now" and "gone" deserve different
   * answers: `degraded` while the streak is short, `down` once it reaches `failuresBeforeDown`, and
   * the row deleted at `failuresBeforeDelist`. Capacity is **cleared** on the way to `down` —
   * a stale "12 of 100 tunnels" on a node that has not answered in fifteen minutes is a number a
   * client would sort on, and it means nothing.
   */
  async recordFailure(
    nodeId: string,
    failuresBeforeDown: number,
    failuresBeforeDelist: number,
    now: number,
  ): Promise<{ readonly delisted: boolean; readonly status: NodeStatus }> {
    const row = this.ctx.storage.sql
      .exec<{ consecutive_failures: number }>(
        "SELECT consecutive_failures FROM node WHERE id = ?",
        nodeId,
      )
      .toArray()[0]
    if (!row) {
      // Already gone — a concurrent delist, or a node that deregistered mid-sweep. Not an error:
      // the cron is at-least-once in spirit and must tolerate the row being absent.
      return { delisted: false, status: "down" }
    }

    const failures = row.consecutive_failures + 1
    if (failures >= failuresBeforeDelist) {
      this.ctx.storage.sql.exec("DELETE FROM node WHERE id = ?", nodeId)
      return { delisted: true, status: "down" }
    }

    const status: NodeStatus = failures >= failuresBeforeDown ? "down" : "degraded"
    this.ctx.storage.sql.exec(
      `UPDATE node
          SET consecutive_failures = ?,
              status = ?,
              active_tunnels = CASE WHEN ? = 'down' THEN NULL ELSE active_tunnels END,
              last_probed_at = ?
        WHERE id = ?`,
      failures,
      status,
      status,
      now,
      nodeId,
    )
    return { delisted: false, status }
  }

  /**
   * Synchronous, so it composes into `admitRegistration` without introducing an await.
   *
   * Check-then-insert is safe for exactly the reason it is in `apps/api`'s `Registry`: there is no
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
  last_probed_at: number
  registered_at: number
  consecutive_failures: number
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
    lastProbedAt: row.last_probed_at,
  }
}
