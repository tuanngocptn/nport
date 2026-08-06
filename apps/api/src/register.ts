/**
 * Self-registration: telling the directory this node exists.
 *
 * Runs on the existing `scheduled` export alongside reconciliation, so a node re-announces itself
 * every cron tick. That is deliberately an **upsert on a schedule rather than a one-off on boot**: a
 * Worker has no boot, the registry delists a node whose probes fail, and a node that came back after
 * an outage has to get itself relisted without anyone intervening.
 *
 * **A node with no `REGISTRY_URL` never registers**, and that is the private deployment
 * `docs/SELF_HOSTING.md` describes (ADR-0031) — reached by setting nothing at all, not by opting out.
 *
 * ## Why this is allowed to fail quietly
 *
 * Registration failing costs this node its *listing*, not its function: it keeps provisioning tunnels
 * for anyone who has its URL, and `--backend` skips discovery entirely. So every failure here is one
 * log line and a return, never a throw — a cron that threw would also abandon the reconciliation
 * sweep running beside it, which does have a job that matters.
 */

import { solveChallenge } from "@nport/worker-kit"

import type { Env } from "./types"

/** How long the registry gets to answer. Short: this is a background nicety, not a request path. */
const REGISTRY_TIMEOUT_MS = 10_000

/**
 * What a node needs to know about itself before it can be listed.
 *
 * Resolved as a group, because a half-configured node is a different thing from a private one: a
 * `NODE_ID` with no `PUBLIC_URL` is a mistake worth a log line, while none of them set is the
 * documented private case and worth silence.
 */
interface NodeIdentity {
  readonly id: string
  readonly url: string
  readonly domain: string
  readonly version: string
  readonly registryUrl: string
}

type Resolution =
  | { readonly kind: "private" }
  | { readonly kind: "incomplete"; readonly missing: string[] }
  | { readonly kind: "ok"; readonly identity: NodeIdentity }

/** Reads the identity out of `env`, distinguishing "not federated" from "misconfigured". */
export function resolveIdentity(env: Env): Resolution {
  const registryUrl = env.REGISTRY_URL?.trim()
  const id = env.NODE_ID?.trim()
  const url = env.PUBLIC_URL?.trim()

  // The private case: nothing about federation is set, so there is nothing to do and nothing wrong.
  if (!registryUrl && !id && !url) {
    return { kind: "private" }
  }

  const missing: string[] = []
  if (!registryUrl) missing.push("REGISTRY_URL")
  if (!id) missing.push("NODE_ID")
  if (!url) missing.push("PUBLIC_URL")
  // `CF_DOMAIN` is required for the Worker to function at all, so it is never missing here — but the
  // registry needs it as the domain being claimed, and reading it explicitly is what makes the
  // relationship visible: the node registers the zone it actually provisions into.
  if (!env.CF_DOMAIN) missing.push("CF_DOMAIN")

  if (missing.length > 0) {
    return { kind: "incomplete", missing }
  }

  return {
    kind: "ok",
    identity: {
      // Non-null asserted by the checks above; TypeScript cannot see through the pushes.
      id: id as string,
      url: url as string,
      domain: String(env.CF_DOMAIN),
      // Display-only in the contract, so an unset value is a cosmetic gap rather than a reason to
      // refuse to register.
      version: env.NODE_VERSION?.trim() || "unknown",
      registryUrl: registryUrl as string,
    },
  }
}

/**
 * Registers or refreshes this node with the directory.
 *
 * Three steps, and each one can fail without consequence beyond a missing listing: fetch a challenge,
 * solve it, post the registration. The solve is the only expensive part — about 1.2 seconds of CPU at
 * the registry's 20-bit floor, measured in `workerd` at ~870k hashes/sec — which is affordable on a
 * five-minute cron and would not be on a request path. That asymmetry is why registration is a cron
 * job rather than something a node does lazily when a client asks.
 */
export async function registerWithRegistry(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  const resolved = resolveIdentity(env)

  if (resolved.kind === "private") {
    return
  }
  if (resolved.kind === "incomplete") {
    // Worth a line: somebody meant to federate this node and left a var out. Never the values —
    // `PUBLIC_URL` is not a secret, but keeping the log to names is the habit rule 12 asks for.
    console.error("node registration skipped: incomplete identity", { missing: resolved.missing })
    return
  }

  const { identity } = resolved

  try {
    const challenge = await fetchChallenge(identity.registryUrl, env, fetcher)
    if (!challenge) {
      return
    }

    const nonce = await solveChallenge(challenge.challenge, challenge.difficulty)

    const response = await fetcher(new URL("/v1/nodes", identity.registryUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The registry gates on a client version like every other NPort surface, and a node is not
        // exempt: a build too old to be trusted with the current contract is as unwelcome as an old
        // CLI. Same User-Agent shape the CLI sends.
        "user-agent": `nport/${nodeUserAgentVersion(env)} (worker; node)`,
      },
      body: JSON.stringify({
        id: identity.id,
        url: identity.url,
        domain: identity.domain,
        version: identity.version,
        challenge: challenge.challenge,
        nonce,
      }),
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })

    if (!response.ok) {
      // The body carries a `details.reason` naming which check failed — `proof-missing` if the TXT
      // record is absent, `id-taken` if someone else holds the id. Logged as a status and a code
      // rather than the whole body, so an upstream that answers HTML cannot fill the log.
      const code = await refusalCode(response)
      console.error("node registration refused", {
        nodeId: identity.id,
        status: response.status,
        code,
      })
      return
    }

    console.log("node registered", { nodeId: identity.id })
  } catch (error) {
    // A registry that is down, a timeout, a DNS failure. All of them mean "not listed this tick", and
    // the next tick tries again — which is the whole reason this is a schedule rather than a one-off.
    console.error("node registration failed", { nodeId: identity.id, error: String(error) })
  }
}

interface IssuedChallenge {
  readonly challenge: string
  readonly difficulty: number
}

/** Fetches a challenge from the registry, or `null` if it did not answer with one. */
async function fetchChallenge(
  registryUrl: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<IssuedChallenge | null> {
  const response = await fetcher(new URL("/v1/challenge", registryUrl).toString(), {
    headers: {
      accept: "application/json",
      "user-agent": `nport/${nodeUserAgentVersion(env)} (worker; node)`,
    },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  })
  if (!response.ok) {
    console.error("registry refused a challenge", { status: response.status })
    return null
  }

  const body = (await response.json()) as Partial<IssuedChallenge>
  if (typeof body.challenge !== "string" || typeof body.difficulty !== "number") {
    console.error("registry answered with an unrecognised challenge")
    return null
  }
  // A difficulty this node cannot afford is better refused here than discovered by spending a minute
  // of cron CPU on it. 24 bits is ~19 s at the measured rate; anything beyond that is a registry
  // asking for more than a background job should pay.
  if (!Number.isInteger(body.difficulty) || body.difficulty < 1 || body.difficulty > 24) {
    console.error("registry asked for an unaffordable difficulty", { difficulty: body.difficulty })
    return null
  }
  return { challenge: body.challenge, difficulty: body.difficulty }
}

/**
 * The version this node identifies itself as to the registry's client gate.
 *
 * Deliberately **not** `NODE_VERSION`: that field is free text a human sets for display, and the gate
 * parses `nport/<major.minor.patch>`. Sending an unparseable value there would get the node refused
 * as an unrecognised client, which is a confusing way to fail. `MIN_CLIENT_VERSION` is a real semver
 * this node already trusts, and a node is never older than the floor it enforces.
 */
function nodeUserAgentVersion(env: Env): string {
  return String(env.MIN_CLIENT_VERSION)
}

/** The registry's error code, or `undefined` if the body was not an envelope. */
async function refusalCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string; details?: unknown } }
    return body.error?.code
  } catch {
    return undefined
  }
}
