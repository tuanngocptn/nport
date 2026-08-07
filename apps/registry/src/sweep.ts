/**
 * The cron sweep: age what nodes told us, and delist what stopped telling us anything.
 *
 * **This fetches nothing** (ADR-0049). It used to probe every listed node's `/v1/meta` every five
 * minutes, sequentially from one Durable Object — a fan-out that grew with the directory, spent one
 * subrequest per node per run, and existed to learn something each node already knew about itself.
 * Nodes now push: `apps/node/src/register.ts` re-registers on its own cron, having first confirmed its
 * public URL answers, and carries its capacity in the request.
 *
 * So the honest question here is no longer "is this node up" but **"when did it last say so"**, and
 * that is a single SQL statement over rows this object already holds. No subrequests, no timeouts, no
 * amplification complaint from a burst of fetches to strangers' servers, and nothing that grows with
 * the size of the directory.
 *
 * **A node that stops registering is gone.** That is the whole liveness model, and it is stronger than
 * the probe was: a probe proved only that the registry could reach the node, while a heartbeat proves
 * the node is running, configured, and able to reach the registry — and the node checks its own public
 * URL before sending one, which is closer still to what a client experiences.
 *
 * Two thresholds rather than one, because "quiet" and "gone" deserve different answers: a node goes
 * `down` after `NODE_DOWN_AFTER_SECONDS` of silence and is deleted after `NODE_DELIST_AFTER_SECONDS`.
 * A client is meant to *show* a down node as unavailable rather than have it vanish and reappear
 * (`docs/FEATURES.md` §3), and a node that missed two cron ticks during a deploy should not have to
 * re-solve a proof of work to get its listing back.
 *
 * `env` is the only parameter now. The old signature took a `fetcher` so a test could inject
 * `test/fake-upstream.ts`; with no outbound call there is nothing to inject, and a parameter that
 * exists only for tests is one a reader has to rule out.
 */

import type { Env } from "./types"

export async function runScheduled(env: Env): Promise<void> {
  const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))

  const downAfterMs = Number(env.NODE_DOWN_AFTER_SECONDS) * 1000
  const delistAfterMs = Number(env.NODE_DELIST_AFTER_SECONDS) * 1000

  const swept = await directory.sweepStale(downAfterMs, delistAfterMs, Date.now())

  for (const nodeId of swept.delisted) {
    // Worth a line each: a delisting is the one thing this sweep does that a human might need to
    // explain to a node operator. Never a URL, never an IP.
    console.log("node delisted", { nodeId })
  }

  // One summary line per run, so the log answers "is the directory healthy" without reading every
  // entry. `apps/node`'s sweep logs the same way.
  console.log("staleness sweep", {
    listed: swept.listed,
    up: swept.up,
    down: swept.down,
    delisted: swept.delisted.length,
  })
}
