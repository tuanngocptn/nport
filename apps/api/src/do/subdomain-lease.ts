import { DurableObject } from "cloudflare:workers"

import type { ServerErrorCode } from "@nport/contract"
import type { CloudflareClient } from "../cloudflare/client"
import {
  CloudflareError,
  cnameTargetFor,
  DNS_RECORD_EXISTS,
  tunnelNameFor,
} from "../cloudflare/client"
import { cloudflareFor } from "../cloudflare/factory"
import { hashesMatch } from "../domain/owner-token"
import type { Env } from "../types"
import type { Registry } from "./registry"
import type { SourceQuota } from "./source-quota"

/**
 * One Durable Object per **normalized** subdomain: atomic claim, saga journal, expiry alarm.
 *
 * `idFromName(subdomain)` gives a single-threaded writer per name by construction, which is what
 * makes a concurrent double-claim impossible rather than merely unlikely (defect R4). The subdomain
 * **must** be normalized before deriving the ID — normalizing afterwards yields two objects for one
 * logical name and the atomicity guarantee evaporates (`apps/api/CLAUDE.md` § Gotchas).
 *
 * ## Single-threaded is not the same as uninterruptible
 *
 * A Durable Object runs one piece of JavaScript at a time, but it does **not** run one request at a
 * time: two `claim` calls can interleave at any `await`. Serialization alone would therefore not
 * prevent a double-claim — what prevents it is that the read-check-journal sequence below contains
 * no `await` at all. `ctx.storage.sql` is synchronous, so "is this name free" and "it is mine now"
 * are one indivisible step. Insert an `await` between them and defect R4 comes straight back.
 *
 * ## The journal
 *
 * Every state is written **before** the side effect it describes (`docs/ARCHITECTURE.md` §3a), so on
 * replay a journal entry means "this may have happened". Compensation is therefore allowed to be
 * wrong about whether a step completed: it confirms against Cloudflare by name rather than assuming,
 * which is what makes re-running it safe.
 *
 * ## Errors do not cross this boundary as exceptions
 *
 * Methods return `{ok: false, code}` instead of throwing `ApiError`. A thrown error crossing a
 * Durable Object RPC boundary arrives as a plain `Error` with its class and fields gone, so the
 * route would have to parse a message to recover the code — the exact mistake ADR-0018 exists to
 * prevent. The route turns a returned code into an `ApiError`.
 */

/**
 * The lease states (`docs/ARCHITECTURE.md` §4), which are also the saga journal's alphabet.
 *
 * `FREE` is in the documented list but not here: it is represented by the **absence of a row**, so
 * that "free" and "never claimed" cannot drift apart into two states meaning the same thing. A
 * released lease deletes its row rather than writing `FREE`.
 */
export type LeaseState = "CLAIMING" | "TUNNEL_CREATED" | "DNS_CREATED" | "ACTIVE" | "RELEASING"

/**
 * The side effect currently being attempted, or `none`.
 *
 * Distinct from `state`, which records what has completed. Together they distinguish "the tunnel
 * call returned" from "the tunnel call was in flight when the isolate died" — and the second case is
 * the one that needs a lookup-by-name rather than a delete-by-ID.
 */
export type SagaStep = "none" | "create-tunnel" | "create-dns" | "teardown"

/**
 * How long a saga or a teardown may be in flight before the watchdog alarm assumes it died.
 *
 * Generous relative to the work: provisioning is four Cloudflare calls, each retried at most three
 * times with sub-second backoff. The in-memory guard in `#inFlight` covers a merely *slow* saga, so
 * this bound only has to be longer than a plausible one, not longer than the worst conceivable one.
 */
const WATCHDOG_MS = 30_000

interface LeaseRow {
  subdomain: string
  tunnel_id: string | null
  owner_token_hash: ArrayBuffer
  state: LeaseState
  saga_step: SagaStep
  created_at: number
  expires_at: number
  last_heartbeat_at: number
  client_version: string
  ip_hash: string
  legacy: number
}

export interface ClaimRequest {
  /** Already normalized. The DO cannot check this — see the class comment. */
  readonly subdomain: string
  /** `SHA-256(ownerToken)`. The plaintext never reaches this object. */
  readonly ownerTokenHash: Uint8Array
  readonly ipHash: string
  readonly clientVersion: string
  /**
   * Set only by the v2 compatibility shim.
   *
   * A v2 client never received an `ownerToken` — the concept did not exist — so its delete cannot prove
   * ownership the way `/v1` requires. This flag marks the leases for which `releaseAsLegacy` is allowed
   * to fall back to a source-hash match, and it must never be set for a `/v1` claim.
   */
  readonly legacy?: boolean
}

/**
 * A refusal, carrying a registry code the route maps to a status.
 *
 * **`details` is `Record<string, string | number>` and must not become `Record<string, unknown>`.**
 * Cloudflare's RPC return types are mapped through a serializability constraint that `unknown` does
 * not satisfy, and a union member that fails it is silently reduced to `never` rather than reported.
 * The whole failure arm therefore *disappears* from `ClaimResult`, `!result.ok` narrows to the
 * success branch, and every `result.code` in the route becomes "property does not exist on type
 * never" — an error a long way from its cause. `ApiError`'s own details are wider, so nothing
 * downstream is constrained by this.
 */
export interface LeaseFailure {
  readonly ok: false
  readonly code: ServerErrorCode
  readonly details?: Record<string, string | number>
}

export type ClaimResult =
  | {
      readonly ok: true
      readonly subdomain: string
      readonly tunnelId: string
      /** Returned to the client exactly once. Never logged, never stored. */
      readonly tunnelToken: string
      readonly expiresAt: number
    }
  | LeaseFailure

export type HeartbeatResult = { readonly ok: true; readonly expiresAt: number } | LeaseFailure

export type ReleaseResult = { readonly ok: true } | LeaseFailure

export type StatusResult =
  | { readonly ok: true; readonly active: boolean; readonly expiresAt: number }
  | LeaseFailure

export class SubdomainLease extends DurableObject<Env> {
  /**
   * Whether this instance is mid-saga.
   *
   * In-memory on purpose, and the only correct place for it. The watchdog alarm must not compensate
   * underneath a saga that is merely slow, but it *must* compensate one whose isolate died — and
   * "the isolate died" is exactly the condition under which this flag is gone. Persisting it would
   * break that, and the no-module-level-state rule does not apply: this is per-object instance
   * state, not shared module scope.
   */
  #inFlight = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Schema creation blocks every request until it completes, so no method can observe a
    // half-created table.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lease (
          subdomain         TEXT PRIMARY KEY,
          tunnel_id         TEXT,
          owner_token_hash  BLOB NOT NULL,
          state             TEXT NOT NULL,
          saga_step         TEXT NOT NULL,
          created_at        INTEGER NOT NULL,
          expires_at        INTEGER NOT NULL,
          last_heartbeat_at INTEGER NOT NULL,
          client_version    TEXT NOT NULL,
          ip_hash           TEXT NOT NULL,
          -- Whether this lease was created through the v2 compatibility shim, which is the only thing
          -- that may later authorize a delete without an ownerToken. An explicit column rather than a
          -- prefix on the client_version text: an authorization decision must never rest on parsing a
          -- string, which is ADR-0018's whole point. (No backticks here -- JS template literal.)
          legacy            INTEGER NOT NULL DEFAULT 0
        )
      `)
    })
  }

  /**
   * Claims the name and provisions the tunnel, or explains why not.
   *
   * The first two statements are the atomicity guarantee; see the class comment before adding an
   * `await` to them.
   */
  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const now = Date.now()
    const existing = this.#read()

    if (existing !== undefined) {
      if (!this.#isReclaimable(existing, now)) {
        return {
          ok: false,
          code: "SUBDOMAIN_IN_USE",
          // The one detail worth giving a loser: when to come back. Without it a CLI can only
          // suggest "try another name", which is the wrong advice for a name that frees up in a
          // minute.
          details: { expiresAt: existing.expires_at },
        }
      }

      // The lease has genuinely expired — by the server's clock, which is the only authority
      // (`docs/ARCHITECTURE.md` §7) — but its teardown never completed. Reclaim is still gated on
      // teardown *finishing*, so run it now rather than handing out a name whose DNS record and
      // tunnel still exist. Marking RELEASING first is synchronous, so a second claim arriving
      // during the teardown sees RELEASING and gets a clean 409 instead of tearing down twice.
      this.#write({ ...existing, state: "RELEASING", saga_step: "teardown" })
      await this.#armWatchdog(now)

      // `#releaseCloudflare`, not `#release`: the row must **not** be cleared here. Reclaim is the
      // one path that keeps using this object after tearing down, and an absent row is a free name.
      // Clearing it would open a window — every `await` in the clearing sequence is a chance for
      // another claim to see no row and start its own saga, which is defect R4 arriving through the
      // one path allowed to await. The row instead goes RELEASING → CLAIMING in a single synchronous
      // write below, so it is never absent.
      const torndown = await this.#releaseCloudflare(existing)
      if (!torndown.ok) {
        return torndown
      }
    }

    const ttlMs = Number(this.env.LEASE_TTL_SECONDS) * 1000
    const row: LeaseRow = {
      subdomain: request.subdomain,
      tunnel_id: null,
      owner_token_hash: toArrayBuffer(request.ownerTokenHash),
      state: "CLAIMING",
      saga_step: "none",
      created_at: now,
      expires_at: now + ttlMs,
      // Not `now`: a lease that never heartbeats should die on the grace period, and seeding this
      // with the creation time is what makes that happen without a special case.
      last_heartbeat_at: now,
      client_version: request.clientVersion,
      ip_hash: request.ipHash,
      legacy: request.legacy === true ? 1 : 0,
    }
    this.#write(row)
    // ── end of the indivisible section ──────────────────────────────────────────────

    await this.#armWatchdog(now)
    this.#inFlight = true
    try {
      return await this.#provision(row)
    } finally {
      this.#inFlight = false
    }
  }

  /**
   * Records a heartbeat and re-arms the alarm.
   *
   * **Does not extend `expires_at`.** The lease's ceiling is server-authoritative and a heartbeat is
   * liveness, not renewal — v2's four-hour limit was a client-side `setTimeout` and so was no limit
   * at all (defect R6).
   */
  async heartbeat(ownerTokenHash: Uint8Array): Promise<HeartbeatResult> {
    const row = this.#read()
    if (row === undefined) {
      return { ok: false, code: "TUNNEL_NOT_FOUND" }
    }
    if (!this.#authorized(row, ownerTokenHash)) {
      return { ok: false, code: "INVALID_OWNER_TOKEN" }
    }

    const now = Date.now()
    if (now >= row.expires_at) {
      // Reached when the alarm has not fired yet. Answer honestly and let the alarm do the work:
      // tearing down inline would make a heartbeat the most expensive call in the API.
      await this.#ensureAlarmAt(now)
      return { ok: false, code: "LEASE_EXPIRED" }
    }
    if (row.state !== "ACTIVE") {
      // Mid-saga or mid-teardown. Not found is the honest answer: there is nothing to keep alive
      // yet, and the client should not treat a provisioning race as an ownership failure.
      return { ok: false, code: "TUNNEL_NOT_FOUND" }
    }

    this.#write({ ...row, last_heartbeat_at: now })
    await this.#ensureAlarmAt(this.#deadline({ ...row, last_heartbeat_at: now }))
    return { ok: true, expiresAt: row.expires_at }
  }

  /**
   * Releases the lease and tears the tunnel down.
   *
   * Idempotent: releasing a lease that is already gone succeeds. A client retrying after a network
   * blip must not be told its own successful delete failed (`docs/API.md`).
   */
  async release(ownerTokenHash: Uint8Array): Promise<ReleaseResult> {
    const row = this.#read()
    if (row === undefined) {
      return { ok: true }
    }
    if (!this.#authorized(row, ownerTokenHash)) {
      return { ok: false, code: "INVALID_OWNER_TOKEN" }
    }

    this.#write({ ...row, state: "RELEASING", saga_step: "teardown" })
    await this.#armWatchdog(Date.now())
    this.#inFlight = true
    try {
      const result = await this.#teardown(row)
      return result.ok ? { ok: true } : result
    } finally {
      this.#inFlight = false
    }
  }

  /**
   * Releases a lease created through the v2 compatibility shim, authorized by source hash.
   *
   * The weakest authorization in the system, and confined here on purpose. A v2 client never received an
   * `ownerToken`, so there is nothing for it to present; the only thing left is that the delete arrives
   * from the same source that created the lease. `docs/API.md` § Legacy v2 compatibility states exactly
   * this, and two guards keep it from becoming v2's unauthenticated delete:
   *
   * 1. **`legacy` must be set.** A `/v1` lease can never be deleted this way, however the request is
   *    shaped, so an attacker cannot use the legacy endpoint to reach a modern tunnel.
   * 2. **The source hash must match.** Same address and ASN as the create, which for a CLI on one machine
   *    is the normal case.
   *
   * Both are weaker than an `ownerToken` and both are the reason `docs/RELEASE.md` sunsets this. What it
   * is *not* is v2's behaviour: v2 accepted `{subdomain, tunnelId}` from anyone and deleted whatever it
   * named, including the `api` record.
   */
  async releaseAsLegacy(ipHash: string): Promise<ReleaseResult> {
    const row = this.#read()
    if (row === undefined) {
      // Idempotent, like `/v1` delete: a client retrying after a blip must not be told its own
      // successful delete failed.
      return { ok: true }
    }
    if (row.legacy !== 1) {
      console.warn("legacy delete refused for a v1 lease", { subdomain: row.subdomain })
      return { ok: false, code: "INVALID_OWNER_TOKEN" }
    }
    if (row.ip_hash !== ipHash) {
      console.warn("legacy delete refused: source mismatch", { subdomain: row.subdomain })
      return { ok: false, code: "INVALID_OWNER_TOKEN" }
    }

    this.#write({ ...row, state: "RELEASING", saga_step: "teardown" })
    await this.#armWatchdog(Date.now())
    this.#inFlight = true
    try {
      const result = await this.#teardown(row)
      return result.ok ? { ok: true } : result
    } finally {
      this.#inFlight = false
    }
  }

  /** Public status. Carries nothing an attacker could use — no tunnel ID, no owner hash. */
  async status(): Promise<StatusResult> {
    const row = this.#read()
    if (row === undefined) {
      return { ok: false, code: "TUNNEL_NOT_FOUND" }
    }
    const now = Date.now()
    return {
      ok: true,
      // Expired-but-not-yet-reaped reads as inactive. Reporting `active: true` because an alarm has
      // not fired yet would make this endpoint disagree with whether the URL actually works.
      active: row.state === "ACTIVE" && now < row.expires_at,
      expiresAt: row.expires_at,
    }
  }

  /**
   * Expiry, heartbeat timeout, and the saga watchdog — all three, because a Durable Object has only
   * one alarm and `min()` is enough to share it (`docs/ARCHITECTURE.md` §6).
   *
   * **At-least-once**, so every branch tolerates the work already being done. Left to throw on
   * failure on purpose: the runtime then retries the alarm with backoff, which is the mechanism
   * `docs/ARCHITECTURE.md` §5 relies on for "alarm re-drives compensation". Once the runtime gives
   * up, the reconciliation cron is the backstop.
   */
  override async alarm(): Promise<void> {
    const row = this.#read()
    if (row === undefined) {
      return
    }

    const now = Date.now()

    if (this.#inFlight) {
      // A saga or teardown is running in this isolate right now and will finish on its own. The
      // watchdog exists for the case where it *cannot*, so firing here would compensate live work.
      await this.#ensureAlarmAt(now + WATCHDOG_MS)
      return
    }

    if (row.state === "RELEASING") {
      const result = await this.#teardown(row)
      if (!result.ok) {
        // A DNS conflict is not retryable by us — it needs a human (`docs/OPERATIONS.md`). The row
        // is already cleared by `#teardown`, so stopping here does not strand the name.
        console.error("lease teardown blocked", { subdomain: row.subdomain, code: result.code })
      }
      return
    }

    if (row.state !== "ACTIVE") {
      // Mid-saga with no saga running: the isolate died between a journal entry and its side effect.
      // This is the case the journal exists for.
      if (now >= row.created_at + WATCHDOG_MS) {
        console.warn("compensating an abandoned saga", {
          subdomain: row.subdomain,
          state: row.state,
          step: row.saga_step,
        })
        this.#write({ ...row, state: "RELEASING", saga_step: "teardown" })
        await this.#teardown(row)
        return
      }
      await this.#ensureAlarmAt(row.created_at + WATCHDOG_MS)
      return
    }

    const deadline = this.#deadline(row)
    if (now < deadline) {
      // Spurious or early — re-arm rather than reaping a healthy lease.
      await this.#ensureAlarmAt(deadline)
      return
    }

    this.#write({ ...row, state: "RELEASING", saga_step: "teardown" })
    const result = await this.#teardown(row)
    if (!result.ok) {
      console.error("lease expiry blocked", { subdomain: row.subdomain, code: result.code })
    }
  }

  // ── the saga ──────────────────────────────────────────────────────────────────────

  /**
   * `CLAIMING → TUNNEL_CREATED → DNS_CREATED → ACTIVE`, journaling before each side effect.
   *
   * Any failure compensates in reverse and leaves the name free. `PROVISION_FAILED`'s message —
   * "Nothing was left behind" — is a promise this function has to keep.
   */
  async #provision(row: LeaseRow): Promise<ClaimResult> {
    const client = this.#cloudflare()
    const name = tunnelNameFor(row.subdomain)
    const fqdn = client.fqdn(row.subdomain)

    let tunnelId: string
    let tunnelToken: string
    try {
      // Journaled before the call, so a crash mid-call still leaves a record saying a tunnel may
      // exist. Compensation finds it by name, which is why the name is derived and not random.
      this.#write({ ...row, saga_step: "create-tunnel" })
      const created = await client.createTunnel(name)
      tunnelId = created.id
      tunnelToken = created.token
      if (!this.#stillOurs(row)) {
        return this.#abandon(row, tunnelId, "create-tunnel")
      }
      this.#write({ ...row, tunnel_id: tunnelId, state: "TUNNEL_CREATED", saga_step: "none" })
    } catch (error) {
      await this.#compensate(row, "create-tunnel")
      return this.#provisionFailure(error, row.subdomain, "create-tunnel")
    }

    const withTunnel: LeaseRow = { ...row, tunnel_id: tunnelId, state: "TUNNEL_CREATED" }

    try {
      this.#write({ ...withTunnel, saga_step: "create-dns" })
      await client.createDnsRecord(fqdn, cnameTargetFor(tunnelId))
    } catch (error) {
      if (error instanceof CloudflareError && error.has(DNS_RECORD_EXISTS)) {
        // A record already exists for a name whose lease was free. Either a previous teardown could
        // not remove it, or it belongs to something that is not a tunnel. Deciding requires looking,
        // and invariant 8 forbids deleting what we cannot prove we own.
        const existing = await client.findDnsRecord(fqdn)
        const ours =
          existing !== null &&
          existing.type === "CNAME" &&
          existing.content === cnameTargetFor(tunnelId)
        if (!ours) {
          await this.#compensate(withTunnel, "create-dns")
          console.error("dns conflict on claim", { subdomain: row.subdomain, fqdn })
          return { ok: false, code: "DNS_CONFLICT" }
        }
        // It is already exactly the record we were about to create. Nothing to do — this is the
        // retry path, not an error.
      } else {
        await this.#compensate(withTunnel, "create-dns")
        return this.#provisionFailure(error, row.subdomain, "create-dns")
      }
    }

    if (!this.#stillOurs(row)) {
      return this.#abandon(withTunnel, tunnelId, "create-dns")
    }

    const now = Date.now()
    const active: LeaseRow = {
      ...withTunnel,
      state: "DNS_CREATED",
      saga_step: "none",
      last_heartbeat_at: now,
    }
    this.#write(active)

    const final: LeaseRow = { ...active, state: "ACTIVE" }
    this.#write(final)
    await this.#ensureAlarmAt(this.#deadline(final))

    // A Registry failure must not fail a provision that worked. The index is a derived view, and
    // losing one increment degrades a soft global cap rather than a guarantee — whereas returning an
    // error here would leave the caller without the `ownerToken` for a tunnel that exists, so nobody
    // could release it and the name would sit until its heartbeat grace period expired.
    try {
      await this.#registry().record(row.subdomain, final.expires_at)
      // Promotes the caller's reservation to the lease's own lifetime. Until this runs the slot is
      // held on a one-minute reservation, so a saga that dies here costs the caller a minute rather
      // than four hours.
      await this.#quota(row.ip_hash).confirm(row.subdomain, final.expires_at)
    } catch (error) {
      console.error("post-activation bookkeeping failed; lease is active but unindexed", {
        subdomain: row.subdomain,
        error: String(error),
      })
    }

    return {
      ok: true,
      subdomain: row.subdomain,
      tunnelId,
      tunnelToken,
      expiresAt: final.expires_at,
    }
  }

  /**
   * Whether the row still belongs to the saga that journaled it.
   *
   * Defence in depth behind `#isReclaimable`. A saga awaits Cloudflare many times, and every one of
   * those awaits is a chance for something else — a reclaim, a release, an alarm — to have taken the
   * lease over. Writing a journal entry then would clobber the new holder's row and hand two callers
   * the same name, so each write checks first that the row is still the one it started with.
   *
   * The **owner token hash** is the identity, not `created_at`. It is 32 random bytes minted per
   * claim, so it changes exactly when ownership does and never otherwise — whereas `created_at` is a
   * clock value, and anything that adjusts a clock (a test simulating elapsed time, a future
   * lease-extension feature) would read as a takeover that never happened.
   */
  #stillOurs(row: LeaseRow): boolean {
    const current = this.#read()
    return (
      current !== undefined &&
      hashesMatch(new Uint8Array(current.owner_token_hash), new Uint8Array(row.owner_token_hash))
    )
  }

  /**
   * Gives up a saga whose lease was taken over, cleaning up only what this saga created.
   *
   * Deliberately does **not** touch the lease row or the DNS record: both belong to whoever holds the
   * lease now. Only the tunnel this saga made is ours to remove, and it is identified by the ID we
   * received rather than by name — the name now refers to the new holder's tunnel too.
   */
  async #abandon(row: LeaseRow, tunnelId: string, step: SagaStep): Promise<LeaseFailure> {
    console.warn("abandoning a saga whose lease was taken over", {
      subdomain: row.subdomain,
      step,
    })
    try {
      await this.#cloudflare().deleteTunnel(tunnelId)
    } catch (error) {
      // Left for reconciliation. Nothing routes to it — the DNS record points at the new holder's
      // tunnel — so it costs an orphan rather than a wrong answer.
      console.error("could not remove an abandoned saga's tunnel", {
        subdomain: row.subdomain,
        error: String(error),
      })
    }
    return { ok: false, code: "SUBDOMAIN_IN_USE" }
  }

  /**
   * Undoes whatever the failed step may have done, then frees the name.
   *
   * Reverse order, and confirmed against Cloudflare rather than assumed — `#teardown` looks the
   * tunnel up by name and verifies the DNS record's content before touching either.
   */
  async #compensate(row: LeaseRow, failedStep: SagaStep): Promise<void> {
    console.warn("compensating saga", { subdomain: row.subdomain, failedStep })
    const result = await this.#teardown(row)
    if (!result.ok) {
      // The name is freed regardless; what remains is a Cloudflare-side leftover for reconciliation.
      console.error("compensation incomplete", { subdomain: row.subdomain, code: result.code })
    }
  }

  /**
   * Removes the DNS record and the tunnel, then clears the lease. Idempotent.
   *
   * The two halves are separate on purpose — see `#releaseCloudflare` and `#clearLease`. Callers that
   * keep using this object afterwards (reclaim) must not clear the row.
   */
  async #teardown(row: LeaseRow): Promise<{ ok: true } | LeaseFailure> {
    const released = await this.#releaseCloudflare(row)

    // The two failure codes mean opposite things here, and collapsing them is a real bug:
    //
    // - `DNS_CONFLICT` — the work is done. A record NPort cannot prove it owns was left in place, but
    //   nothing of ours remains. Clear the lease, because holding the name hostage would make one
    //   stray DNS record permanently unclaimable.
    // - `UPSTREAM_CLOUDFLARE_ERROR` — the calls themselves failed, so a tunnel and possibly a DNS
    //   record may still point at this name. **Keep the row in RELEASING** and let the watchdog retry.
    //   Freeing it here is exactly the takeover v3 forbids (defect R7).
    if (released.ok || released.code === "DNS_CONFLICT") {
      await this.#clearLease(row)
    }
    return released
  }

  /**
   * The Cloudflare half of a teardown. Touches no lease state.
   *
   * Order is deliberate: DNS first, so the name stops resolving before the tunnel it points at
   * disappears. The reverse would leave a window where the hostname resolves to a tunnel that no
   * longer exists, which the edge answers with its own error page rather than ours.
   *
   * **Never deletes a DNS record it cannot prove it owns** (invariant 8): the record must be a
   * `CNAME` whose content is exactly `<tunnel_id>.cfargotunnel.com`. Anything else is left alone and
   * reported as `DNS_CONFLICT` with a log line for manual review. This is v2's subdomain-takeover
   * path, which deleted the incumbent's records on nothing more than a status string (defect R7).
   */
  async #releaseCloudflare(row: LeaseRow): Promise<{ ok: true } | LeaseFailure> {
    const client = this.#cloudflare()
    const fqdn = client.fqdn(row.subdomain)
    let conflict = false

    try {
      const record = await client.findDnsRecord(fqdn)
      if (record !== null) {
        const expected = row.tunnel_id === null ? null : cnameTargetFor(row.tunnel_id)
        const provable = expected !== null && record.type === "CNAME" && record.content === expected
        if (provable) {
          await client.deleteDnsRecord(record.id)
        } else {
          conflict = true
          console.error("refusing to delete an unowned dns record", {
            subdomain: row.subdomain,
            fqdn,
            recordType: record.type,
            // The expected target, not the actual content: the actual content is somebody else's
            // hostname, and this line ends up in a log an operator reads.
            expected,
          })
        }
      }

      // The tunnel is identified by ID when we have one, and by our own namespaced name when we do
      // not — the case where the isolate died mid-`createTunnel`. The `nport-` prefix is what makes
      // deleting by name safe in an account that may hold tunnels NPort did not create.
      if (row.tunnel_id !== null) {
        await client.deleteTunnel(row.tunnel_id)
      } else {
        for (const tunnel of await client.findTunnelsByName(tunnelNameFor(row.subdomain))) {
          await client.deleteTunnel(tunnel.id)
        }
      }
    } catch (error) {
      // Leave the row in RELEASING and let the alarm retry. Clearing it here would free the name
      // while a tunnel and possibly a DNS record still point at it.
      console.error("teardown failed", {
        subdomain: row.subdomain,
        status: error instanceof CloudflareError ? error.status : undefined,
      })
      await this.#ensureAlarmAt(Date.now() + WATCHDOG_MS)
      return { ok: false, code: "UPSTREAM_CLOUDFLARE_ERROR" }
    }

    return conflict ? { ok: false, code: "DNS_CONFLICT" } : { ok: true }
  }

  /**
   * Frees the name.
   *
   * **The row's deletion is the last statement, and nothing is awaited after it.** That ordering is
   * the whole point of this method. Both calls below yield: `deleteAlarm` is a storage operation, and
   * `forget` is an outbound RPC to another Durable Object which does *not* hold the input gate. Doing
   * either one after the delete would leave the name looking free across an await, so a claim
   * arriving in that window would start a second saga on a name that is still being torn down.
   *
   * Deleting the alarm first is deliberate for the same reason in reverse: if a new claim had already
   * begun, a later `deleteAlarm` would remove *its* watchdog and leave that saga with nothing to
   * compensate it.
   */
  async #clearLease(row: LeaseRow): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.#registry().forget(row.subdomain)
    // Frees the caller's concurrency slot. Placed here, before the delete, for the reason above: the
    // row must still exist across every await in this method. An unreleased slot would expire on its
    // own, but only after the lease's full lifetime, so a user who closed a tunnel would wait hours
    // to reuse the slot.
    try {
      await this.#quota(row.ip_hash).release(row.subdomain)
    } catch (error) {
      // Never fail a teardown over bookkeeping: the slot expires with the lease regardless.
      console.error("could not release the source's quota slot", {
        subdomain: row.subdomain,
        error: String(error),
      })
    }
    this.ctx.storage.sql.exec("DELETE FROM lease")
  }

  #provisionFailure(error: unknown, subdomain: string, step: SagaStep): LeaseFailure {
    if (error instanceof CloudflareError) {
      console.error("provisioning failed", { subdomain, step, status: error.status })
      // 502 for an upstream failure, 500 for one that is ours. The distinction drives whether the
      // CLI retries, so it is not cosmetic.
      return { ok: false, code: error.retryable ? "UPSTREAM_CLOUDFLARE_ERROR" : "PROVISION_FAILED" }
    }
    console.error("provisioning failed", { subdomain, step, error: String(error) })
    return { ok: false, code: "PROVISION_FAILED" }
  }

  // ── storage ───────────────────────────────────────────────────────────────────────

  /**
   * Synchronous by design. See the class comment on atomicity.
   *
   * The generic is intersected with `Record<string, SqlStorageValue>` only because that is
   * `sql.exec`'s constraint. The declared return type is the strict `LeaseRow`, so callers still get
   * a compile error for a mistyped column name.
   */
  #read(): LeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<LeaseRow & Record<string, SqlStorageValue>>("SELECT * FROM lease LIMIT 1")
      .toArray()[0]
  }

  #write(row: LeaseRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO lease (subdomain, tunnel_id, owner_token_hash, state, saga_step,
                          created_at, expires_at, last_heartbeat_at, client_version, ip_hash, legacy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subdomain) DO UPDATE SET
         tunnel_id = excluded.tunnel_id,
         owner_token_hash = excluded.owner_token_hash,
         state = excluded.state,
         saga_step = excluded.saga_step,
         -- Updated, not preserved -- reclaim transitions RELEASING to CLAIMING without deleting the
         -- row, so this is an UPDATE, and inheriting the dead lease's creation time would put the new
         -- saga's watchdog window in the past and make it instantly reclaimable by anyone. Every
         -- caller passes a full row carrying the creation time it intends, so nothing else moves.
         -- (No backticks in this comment: it lives inside a JS template literal.)
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         last_heartbeat_at = excluded.last_heartbeat_at,
         client_version = excluded.client_version,
         ip_hash = excluded.ip_hash,
         legacy = excluded.legacy`,
      row.subdomain,
      row.tunnel_id,
      row.owner_token_hash,
      row.state,
      row.saga_step,
      row.created_at,
      row.expires_at,
      row.last_heartbeat_at,
      row.client_version,
      row.ip_hash,
      row.legacy,
    )
  }

  // ── policy ────────────────────────────────────────────────────────────────────────

  /**
   * When this lease should be reaped: whichever comes first, the hard expiry or a missed heartbeat.
   *
   * `docs/ARCHITECTURE.md` §3e states this as `min(expires_at, last_heartbeat_at + 120s)`.
   */
  #deadline(row: LeaseRow): number {
    const graceMs = Number(this.env.HEARTBEAT_GRACE_SECONDS) * 1000
    return Math.min(row.expires_at, row.last_heartbeat_at + graceMs)
  }

  /**
   * Whether an existing row may be taken over.
   *
   * `RELEASING` is never reclaimable: teardown is either running or being retried by the watchdog,
   * and handing the name out before it completes is precisely the takeover v3 forbids. A teardown
   * that fails permanently leaves the name held — deliberately, because the alternative is issuing a
   * URL that points at somebody else's tunnel. Reconciliation is the backstop.
   */
  #isReclaimable(row: LeaseRow, now: number): boolean {
    if (row.state === "RELEASING") {
      return false
    }
    if (row.state === "ACTIVE") {
      return now >= this.#deadline(row)
    }
    // Mid-saga. A live saga is never reclaimable, however old its journal entry is: `#inFlight` says
    // one is running in this isolate *right now*, and a Durable Object has exactly one instance, so
    // that answer is authoritative.
    //
    // Checking the clock alone was a real bug. Provisioning makes twelve Cloudflare calls in the worst
    // case, and during an incident where each one hangs it passes the watchdog window easily — at
    // which point a second claim tore the first saga's lease out from under it, the first saga wrote
    // its ACTIVE row back over the second's, and the loser's compensation deleted the row outright.
    // That left a live tunnel and DNS record with no lease, so nothing would ever reap them.
    if (this.#inFlight) {
      return false
    }
    // No saga running, so the isolate that journaled this entry is gone and cannot resume. The clock
    // is now a sound test: past the window means abandoned.
    return now >= row.created_at + WATCHDOG_MS
  }

  #authorized(row: LeaseRow, presented: Uint8Array): boolean {
    return hashesMatch(new Uint8Array(row.owner_token_hash), presented)
  }

  // ── collaborators ─────────────────────────────────────────────────────────────────

  #cloudflare(): CloudflareClient {
    return cloudflareFor(this.env)
  }

  #registry(): DurableObjectStub<Registry> {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"))
  }

  /**
   * The quota object for the source that created this lease.
   *
   * Addressed by the stored `ip_hash`, which is already `HMAC(ip, secret)` — this object has never
   * seen an address and cannot produce one (rule 11).
   */
  #quota(ipHash: string): DurableObjectStub<SourceQuota> {
    return this.env.SOURCE_QUOTA.get(this.env.SOURCE_QUOTA.idFromName(ipHash))
  }

  /**
   * Arms the alarm that compensates this saga if the isolate running it dies.
   *
   * Unconditional rather than via `#ensureAlarmAt`: a saga starting on a name whose previous lease
   * had a far-future alarm must pull it in, not leave it.
   */
  async #armWatchdog(now: number): Promise<void> {
    await this.ctx.storage.setAlarm(now + WATCHDOG_MS)
  }

  /** Sets the alarm unless one is already pending at or before `at`. */
  async #ensureAlarmAt(at: number): Promise<void> {
    const pending = await this.ctx.storage.getAlarm()
    if (pending === null || pending > at) {
      await this.ctx.storage.setAlarm(at)
    }
  }
}

/** SQLite BLOB binding wants an `ArrayBuffer`, and a `Uint8Array` view may be a slice of a larger one. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
