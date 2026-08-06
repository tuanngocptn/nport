import { issueChallenge } from "@nport/worker-kit"
import { Hono } from "hono"

import type { Env, Variables } from "../types"

/**
 * `GET /v1/challenge` — issue a proof-of-work challenge for a registration.
 *
 * Stateless: no challenge is stored, so there is no table of outstanding challenges to fill and
 * issuing cannot be exhausted. **Cheaper than `apps/api`'s**, which reads the caller's `SourceQuota`
 * to find a per-source difficulty — the registry has no equivalent, because ADR-0028's dial escalates
 * on "this source keeps creating" and a node registers once and then refreshes. One flat floor is the
 * honest answer here rather than a control with nothing to control.
 *
 * The difficulty is committed to inside the challenge's MAC, so a client that edits it invalidates
 * the challenge.
 */
export const challengeRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get(
  "/",
  async (context) => {
    const bits = Number(context.env.POW_DIFFICULTY_BITS)
    const issued = await issueChallenge(context.env.POW_SECRET, bits, Date.now())

    return context.json(
      {
        challenge: issued.challenge,
        difficulty: issued.difficulty,
        expiresAt: issued.expiresAt,
      },
      200,
      // Single-use and time-bounded: a cached challenge is worthless at best and replayable at worst.
      { "cache-control": "no-store" },
    )
  },
)
