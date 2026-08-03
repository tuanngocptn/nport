import { Hono } from "hono"

import { issueChallenge } from "../domain/pow"
import type { Env, Variables } from "../types"

/**
 * `GET /v1/challenge` — issue a proof-of-work challenge.
 *
 * One HMAC, nothing stored, so this endpoint cannot be exhausted (`docs/API.md`). Difficulty comes
 * from `POW_DIFFICULTY_BITS`, which is a floor; the dynamic raise under load arrives with the
 * Registry DO, since a var change needs a deploy.
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
      // A challenge is single-use and time-bounded; a cached one is worthless at best and
      // replayable at worst.
      { "cache-control": "no-store" },
    )
  },
)
