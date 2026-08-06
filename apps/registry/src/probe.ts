/**
 * The cron sweep: probe every listed node, and delist the long-dead.
 *
 * `apps/api`'s reconciliation cron exists to clean up *its own* leaks; this one exists because the
 * directory's contents are claims made by strangers that go stale on their own. A node stops
 * answering and nothing tells us — so the only way the list stays honest is by asking.
 *
 * **Every node, every run, sequentially.** Not a paginating cursor like `apps/api`'s sweep, and the
 * difference is scale rather than taste: there are at most `MAX_NODES` rows — hundreds, bounded on
 * purpose — and each probe is one subrequest. A cursor would buy nothing and cost the property that
 * makes this simple to reason about: after one run, every node's status is at most one cron interval
 * old.
 *
 * Sequential rather than concurrent because the subrequest budget is per-invocation and a burst of
 * parallel fetches to strangers' servers is the shape of an amplification complaint. At five minutes
 * per run there is no deadline pressure.
 *
 * The `fetcher` parameter is injected for the same reason `createApp`'s is: a test must drive **this**
 * function rather than a copy of its loop. The first draft of `test/probe.test.ts` re-implemented the
 * loop to get a fake in, which tested the Durable Object's policy and left the sweep itself
 * unexercised — `docs/ROADMAP.md`'s defect 25 exactly, committed while writing a comment warning
 * about it.
 */

import type { Env } from "./types"
import { probeNode } from "./upstream"

export async function runScheduled(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))
  const targets = await directory.probeTargets()

  const failuresBeforeDown = Number(env.PROBE_FAILURES_BEFORE_DOWN)
  const failuresBeforeDelist = Number(env.PROBE_FAILURES_BEFORE_DELIST)

  let up = 0
  let failed = 0
  let delisted = 0

  for (const target of targets) {
    const now = Date.now()
    const observed = await probeNode(target.url, fetcher)

    if (observed === null) {
      const outcome = await directory.recordFailure(
        target.id,
        failuresBeforeDown,
        failuresBeforeDelist,
        now,
      )
      failed += 1
      if (outcome.delisted) {
        delisted += 1
        // Worth a line each: a delisting is the one thing this sweep does that a human might need to
        // explain to a node operator. Never the URL's credentials — there are none — and never an IP.
        console.log("node delisted", { nodeId: target.id })
      }
      continue
    }

    await directory.recordSuccess(target.id, observed, now)
    up += 1
  }

  // One summary line per run, so the log answers "is the directory healthy" without reading every
  // entry. `apps/api`'s sweep logs the same way.
  console.log("probe sweep", { probed: targets.length, up, failed, delisted })
}
