import { Hono } from "hono"

import { issueChallenge } from "../domain/pow"
import type { Env, Variables } from "../types"

/**
 * `GET /v1/challenge` — issue a proof-of-work challenge.
 *
 * Still stateless in the sense that matters: no challenge is stored, so there is no table of
 * outstanding challenges to fill and issuing cannot be exhausted (`docs/API.md`). What it now costs is
 * **one Durable Object read**, to ask the caller's own `SourceQuota` what difficulty they should pay.
 *
 * That read is per-source, which is what makes it safe to put on the cheapest endpoint: hammering it
 * loads only the attacker's own object and raises only the attacker's own price, while a first-time
 * caller pays the `POW_DIFFICULTY_BITS` floor of roughly 100 ms. ADR-0028 records the trade.
 *
 * The difficulty is committed to inside the challenge's MAC, so a client that edits it invalidates the
 * challenge — the escalation cannot be negotiated away.
 */
export const challengeRoute = new Hono<{ Bindings: Env; Variables: Variables }>().get(
  "/",
  async (context) => {
    const env = context.env
    const floor = Number(env.POW_DIFFICULTY_BITS)
    const ceiling = Number(env.POW_MAX_DIFFICULTY_BITS)

    const quota = env.SOURCE_QUOTA.get(env.SOURCE_QUOTA.idFromName(context.get("sourceHash")))
    const bits = await quota.difficulty(floor, ceiling)

    const issued = await issueChallenge(env.POW_SECRET, bits, Date.now())

    return context.json(
      {
        challenge: issued.challenge,
        difficulty: issued.difficulty,
        expiresAt: issued.expiresAt,
      },
      200,
      // A challenge is single-use and time-bounded; a cached one is worthless at best and
      // replayable at worst. It is also per-source now, so a shared cache would hand one caller's
      // difficulty to another.
      { "cache-control": "no-store" },
    )
  },
)
