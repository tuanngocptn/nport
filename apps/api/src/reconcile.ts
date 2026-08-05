/**
 * Reconciliation: the safety net, not the mechanism.
 *
 * `docs/ARCHITECTURE.md` §3f. Expiry is driven by each lease's own Durable Object alarm, so this sweep
 * exists only for **orphans** — a Cloudflare tunnel with no lease behind it, which can happen if a
 * Durable Object was destroyed or a compensation failed permanently. If it is deleting things
 * regularly, something in §3e is broken and that is the bug to fix.
 *
 * v2 did the opposite: cleanup *was* the mechanism, capped at ~10 tunnels per 30-minute run with no
 * ordering, so the oldest could starve indefinitely (defect R8). Here the cron runs every five minutes
 * over a persisted cursor: bounded per invocation, unbounded over time.
 *
 * ## The deletion rule, and why it is this narrow
 *
 * Invariant 8 — never delete a DNS record you cannot prove you own — is hardest to satisfy here,
 * because an orphan has no lease to say what it should point at. The proof used instead is the orphan
 * **tunnel's own ID**: a record is ours to delete only if it is a `CNAME` whose content is exactly
 * `<that tunnel's id>.cfargotunnel.com`. That is the same test `SubdomainLease` applies, with the same
 * strength, and it means the record is deleted **before** the tunnel — while the proof still exists.
 *
 * Deleting the tunnel first would destroy the evidence and leave a dangling `CNAME` that nothing could
 * ever prove ownership of. Worse, that name would then be permanently unclaimable: a later create would
 * hit `81053`, find content pointing at a tunnel that no longer exists, and refuse with `DNS_CONFLICT`
 * forever. Order matters more here than anywhere else in the sweep.
 *
 * Records that fail the test are **logged and left alone**, for a human to look at
 * (`docs/OPERATIONS.md`). That is the deliberate choice: an accumulating orphan record is a nuisance, and
 * deleting a stranger's record is v2's subdomain-takeover defect (R7).
 */

import { isReserved } from "@nport/contract"
import type { CloudflareClient } from "./cloudflare/client"
import { cnameTargetFor, tunnelNameFor } from "./cloudflare/client"
import { cloudflareFor } from "./cloudflare/factory"
import { missingBindings } from "./env"
import type { Env } from "./types"

/**
 * Tunnels examined per run.
 *
 * Sized against the free plan's 50 subrequests. One list call, one `Registry` hop for the whole page,
 * one `SubdomainLease` hop per candidate, and up to five Cloudflare calls per orphan removed. Ten and
 * three keeps the worst case near 25, which leaves room for the platform's own overhead.
 */
const PAGE_SIZE = 10

/** Orphans removed per run. The cursor means a backlog drains over successive runs rather than at once. */
const MAX_REMOVALS_PER_RUN = 3

/**
 * How old a tunnel must be before it can be called an orphan.
 *
 * The sweep races provisioning otherwise. A saga journals its lease before creating a tunnel, so a live
 * saga's tunnel does have a lease — but the isolate can die between the two, and the watchdog needs its
 * own 30 seconds to compensate. Ten minutes is far beyond both, and an orphan is in no hurry.
 */
const MIN_ORPHAN_AGE_MS = 600_000

export interface ReconcileReport {
  readonly page: number
  readonly examined: number
  /** Tunnels with no index entry — suspected, not yet confirmed. */
  readonly candidates: number
  readonly removed: number
  /** Records left in place because ownership could not be proven. Needs a human. */
  readonly conflicts: number
  readonly skippedReserved: number
  /** Whether the cursor wrapped back to the first page on this run. */
  readonly wrapped: boolean
}

export async function reconcile(env: Env): Promise<ReconcileReport> {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))
  const page = await registry.sweepPage()

  const client = cloudflareFor(env)

  const { tunnels, hasMore } = await client.listTunnels(page, PAGE_SIZE)

  // Advanced **here**, before any of the work, and deliberately not at the end.
  //
  // Advancing only after a clean run looks tidier and reintroduces v2's starving cleanup through a
  // different door: one orphan that persistently fails to delete would throw, the cursor would stay put,
  // and every other page in the account would never be examined again. Losing a page's work to a
  // transient failure costs one lap of the cursor; pinning the sweep costs everything else.
  await registry.advanceSweep(page, hasMore)

  const now = Date.now()

  let skippedReserved = 0
  const subdomains: string[] = []
  for (const tunnel of tunnels) {
    const subdomain = subdomainOf(tunnel.name)
    if (subdomain === undefined) {
      // Not ours. A self-hoster's account may hold tunnels NPort did not create, and the `nport-`
      // prefix is the only thing that distinguishes them.
      continue
    }
    if (isReserved(subdomain)) {
      // The deny list is shared with the sweeper precisely so cleanup can never remove one of our own
      // records (`docs/ARCHITECTURE.md` §7).
      skippedReserved += 1
      continue
    }
    if (!olderThan(tunnel.created_at, now - MIN_ORPHAN_AGE_MS)) {
      continue
    }
    subdomains.push(subdomain)
  }

  // One hop for the whole page. The index is a hint, not the verdict — see `Registry.withoutLease`.
  const candidates = subdomains.length === 0 ? [] : await registry.withoutLease(subdomains)

  let removed = 0
  let conflicts = 0
  for (const subdomain of candidates) {
    if (removed >= MAX_REMOVALS_PER_RUN) {
      // Deliberately bounded, and deliberately logged: a silent cap reads as "everything was handled"
      // when it was not. The cursor brings us back.
      console.warn("reconciliation hit its per-run removal cap", {
        page,
        remaining: candidates.length - removed,
      })
      break
    }

    // The authoritative check. A missing index row is not proof of a missing lease.
    const lease = env.SUBDOMAIN_LEASE.get(env.SUBDOMAIN_LEASE.idFromName(subdomain))
    const status = await lease.status()
    if (status.ok) {
      console.warn("reconciliation found a lease the index had lost", { subdomain })
      // Put the index back, so the next sweep does not pay for this candidate again.
      await registry.record(subdomain, status.expiresAt)
      continue
    }

    const outcome = await removeOrphan(client, subdomain)
    if (outcome === "removed") {
      removed += 1
    } else if (outcome === "conflict") {
      conflicts += 1
    }
    // `already-gone` counts as neither. It cost no deletions, so it must not consume the per-run
    // removal budget — otherwise a page of stale listings would crowd out the real orphans behind them.
  }

  return {
    page,
    examined: tunnels.length,
    candidates: candidates.length,
    removed,
    conflicts,
    skippedReserved,
    wrapped: !hasMore,
  }
}

/**
 * Removes one orphan: its DNS record first, then the tunnel.
 *
 * Returns `conflict` when the record could not be proven ours, in which case **nothing is deleted** —
 * not even the tunnel, because deleting it would destroy the only proof that the record was ever ours
 * and leave a name that can never be claimed again.
 */
async function removeOrphan(
  client: CloudflareClient,
  subdomain: string,
): Promise<"removed" | "conflict" | "already-gone"> {
  const name = tunnelNameFor(subdomain)
  const fqdn = client.fqdn(subdomain)

  // Look the tunnel up by name rather than trusting the listing we already have: the listing is a page
  // of a paginated read that may be minutes old by the time we act on it, and the ID is what the DNS
  // proof rests on.
  const found = await client.findTunnelsByName(name)
  if (found.length === 0) {
    // Already gone — another run, or a teardown that finally succeeded. The listing this candidate came
    // from is a paginated read that may be minutes stale, so this is expected, not exceptional.
    return "already-gone"
  }

  const record = await client.findDnsRecord(fqdn)
  if (record !== null) {
    const provable = found.some(
      (tunnel) => record.type === "CNAME" && record.content === cnameTargetFor(tunnel.id),
    )
    if (!provable) {
      console.error("reconciliation refusing to delete an unowned dns record", {
        subdomain,
        fqdn,
        recordType: record.type,
        // Never the actual content: it is somebody else's hostname, and this line goes to a log an
        // operator reads.
        expected: found.map((tunnel) => cnameTargetFor(tunnel.id)),
      })
      return "conflict"
    }
    await client.deleteDnsRecord(record.id)
  }

  for (const tunnel of found) {
    await client.deleteTunnel(tunnel.id)
  }
  console.warn("reconciliation removed an orphan", { subdomain })
  return "removed"
}

/** `nport-myapp` → `myapp`. `undefined` for any tunnel NPort did not name. */
function subdomainOf(tunnelName: string): string | undefined {
  const prefix = tunnelNameFor("")
  if (!tunnelName.startsWith(prefix) || tunnelName.length === prefix.length) {
    return undefined
  }
  return tunnelName.slice(prefix.length)
}

/** Whether Cloudflare's ISO timestamp is before `cutoff`. An unparseable or absent date is not. */
function olderThan(createdAt: string | undefined, cutoff: number): boolean {
  if (createdAt === undefined) {
    // No creation date means we cannot rule out a tunnel created seconds ago, and the sweep must never
    // race provisioning. Leaving it for the next run costs nothing.
    return false
  }
  const created = Date.parse(createdAt)
  return Number.isFinite(created) && created < cutoff
}

/**
 * The cron entry point.
 *
 * Swallows its own failures on purpose: a cron that throws is retried by the platform on its own
 * schedule, and reconciliation has nothing time-critical in it. What matters is that a failure is
 * visible in the logs rather than silently reducing the sweep to nothing.
 */
export async function runScheduled(env: Env): Promise<void> {
  const missing = missingBindings(env)
  if (missing.length > 0) {
    // Same reasoning as the request path: name the bindings in the log, never to a caller. There is no
    // caller here, but a half-configured Worker must not quietly stop reconciling either.
    console.error("reconciliation skipped: missing bindings", { missing })
    return
  }

  try {
    const report = await reconcile(env)
    console.log("reconciliation complete", report)
  } catch (error) {
    console.error("reconciliation failed", { error: String(error) })
  }
}
