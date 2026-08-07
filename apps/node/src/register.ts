/**
 * Self-registration: telling the directory this node exists.
 *
 * Runs on the existing `scheduled` export alongside reconciliation, so a node re-announces itself
 * every cron tick. That is deliberately an **upsert on a schedule rather than a one-off on boot**: a
 * Worker has no boot, and a node that came back after an outage has to get itself relisted without
 * anyone intervening.
 *
 * **This is also the node's liveness signal** (ADR-0049). The registry no longer probes anybody; it
 * records `last_seen_at` from this call and delists whatever stops arriving. A node that stops
 * registering is a node that is gone — which is a stronger statement than a probe could make, because
 * the probe only ever proved the registry could reach the node, and this proves the node is running,
 * configured, and able to reach the registry.
 *
 * That inversion puts one obligation here: **prove the node is actually serving before claiming it
 * is.** A Worker whose cron fires is not necessarily a Worker anybody can reach — the DNS record
 * could be gone, the route unbound, the gateway undeployed — and a heartbeat sent regardless would
 * keep a dead node listed and hand clients a URL that answers nothing. `selfCheck` closes that.
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
 * Shorter than the registry timeout, because this one is a round trip to our own edge. A node whose
 * own front door takes five seconds to answer a static JSON body has something wrong with it that
 * registering would only hide.
 */
const SELF_CHECK_TIMEOUT_MS = 5_000

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
 * Four steps, and each one can fail without consequence beyond a missing listing: check the node's own
 * public URL, fetch a challenge, solve it, post the registration. The solve is the only expensive part
 * — about 1.2 seconds of CPU at the registry's 20-bit floor, measured in `workerd` at ~870k
 * hashes/sec — which is affordable on a five-minute cron and would not be on a request path. That
 * asymmetry is why registration is a cron job rather than something a node does lazily when a client
 * asks.
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
    if (!(await selfCheck(identity.url, fetcher))) {
      return
    }

    const challenge = await fetchChallenge(identity.registryUrl, env, fetcher)
    if (!challenge) {
      return
    }

    const nonce = await solveChallenge(challenge.challenge, challenge.difficulty)

    const response = await fetcher(registryEndpoint(identity.registryUrl, "/v1/nodes"), {
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
        ...(await claimedCapacity(env)),
      }),
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })

    if (!response.ok) {
      // **The `reason` is the diagnosis; the code is not.** Every refusal here is
      // `REGISTRATION_REFUSED`, and which check failed lives in `details.reason` —
      // `proof-missing` if the TXT record is absent, `id-taken` if someone else holds the id,
      // `invalid-url` if the URL is not under the proved domain. This logged only the code for a
      // while, and the docblock above it claimed the reason "names which check failed" while the
      // code fetched and discarded it, so a refused node said `403 REGISTRATION_REFUSED` and
      // nothing else. Still a code and a reason rather than the whole body, so an upstream that
      // answers HTML cannot fill the log.
      const refusal = await refusalDetail(response)
      console.error("node registration refused", {
        nodeId: identity.id,
        status: response.status,
        ...refusal,
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

/**
 * Fetches this node's own public URL and reports whether it answered.
 *
 * **The gate the registry's probe used to be** (ADR-0049). It asks a narrower question than a probe
 * could — "can I be reached from the outside" is not answerable from inside a Worker — but it covers
 * every failure that a probe covered *and* is affordable on every tick rather than once per node per
 * five minutes across the whole directory.
 *
 * `GET /v1/health` is the right target because it is the one endpoint the gateway answers itself: a
 * 200 proves DNS resolves, the route is bound, and the gateway is deployed and serving. It does not
 * prove this Worker's own service binding is healthy, which is the honest limit of a self-check and
 * the reason `docs/ARCHITECTURE.md` §7 keeps `GET /v1/meta` reporting real numbers on the request
 * path — a node that lies about being up gets found out by the first client that tries it.
 *
 * A subrequest to your own hostname costs one of the 50 the cron budget allows and is meant to exercise
 * the path a client would take.
 *
 * **On a master deployment it is a same-zone round trip, and that is not proven to be reliable.**
 * `PUBLIC_URL` and `REGISTRY_URL` are both the gateway's hostname there, so all three of this cron's
 * subrequests leave the node Worker and re-enter the same zone. Staging registered on roughly two ticks
 * in twenty-four while the identical code registered first time from a laptop — see `docs/ROADMAP.md`
 * defect 41. Whether the failure is here or in the two registry calls is not yet known; the logging
 * above is what will say.
 */
async function selfCheck(publicUrl: string, fetcher: typeof fetch): Promise<boolean> {
  const target = registryEndpoint(publicUrl, "/v1/health")
  const started = Date.now()
  try {
    const response = await fetcher(target, {
      // No NPort headers: health is exempt from the client gate precisely so an uptime monitor can
      // reach it, and this is one. Sending a User-Agent the gate would accept would mean this check
      // passing on a deployment where a real monitor's would fail.
      signal: AbortSignal.timeout(SELF_CHECK_TIMEOUT_MS),
    })
    if (!response.ok) {
      // **The edge answered and refused.** That is a real signal about the outside world.
      console.error("node self-check failed; not registering", {
        target,
        status: response.status,
        elapsedMs: Date.now() - started,
      })
      return false
    }
    return true
  } catch (error) {
    // **The edge did not answer.** A timeout or a network error here proves far less than a status
    // does — on a master deployment this fetch leaves the Worker and comes back into its own zone,
    // so a failure may say nothing about whether a *client* could reach the same URL. The elapsed
    // time is what separates the two: at or near `SELF_CHECK_TIMEOUT_MS` it timed out, well under it
    // the request was refused outright.
    console.error("node self-check failed; not registering", {
      target,
      error: String(error),
      elapsedMs: Date.now() - started,
      timedOut: Date.now() - started >= SELF_CHECK_TIMEOUT_MS - 250,
    })
    return false
  }
}

/**
 * What this node claims about its own headroom, or `{}` if it cannot say.
 *
 * **Claimed rather than measured** (ADR-0049 supersedes ADR-0046's probe). The registry used to read
 * these off `GET /v1/meta` itself; a node reporting its own numbers is one hop instead of N and is
 * necessarily fresher, at the cost of being unverified. The accepted risk is a node overstating its
 * headroom to attract traffic — which buys it nothing, since the node then has to serve that traffic
 * and its own `MAX_ACTIVE_TUNNELS` refuses past the cap anyway.
 *
 * Both fields are optional in the contract, so a `Registry` DO that will not answer costs a listing
 * without capacity rather than no listing at all — the node is still selectable, just ranked blind.
 */
async function claimedCapacity(
  env: Env,
): Promise<{ activeTunnels?: number; maxActiveTunnels?: number }> {
  const max = Number(env.MAX_ACTIVE_TUNNELS)
  try {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"))
    return {
      activeTunnels: await registry.activeCount(),
      ...(Number.isFinite(max) ? { maxActiveTunnels: max } : {}),
    }
  } catch (error) {
    console.error("node capacity unavailable; registering without it", { error: String(error) })
    return {}
  }
}

interface IssuedChallenge {
  readonly challenge: string
  readonly difficulty: number
}

/**
 * Joins a registry path onto `REGISTRY_URL`, **keeping any path the URL already has**.
 *
 * `new URL("/v1/nodes", base)` looks right and is wrong: a leading slash makes the path absolute, so
 * it replaces the base's path entirely. Point `REGISTRY_URL` at `https://host/registry` and the node
 * would POST to `https://host/v1/nodes` — and since every failure in this file is swallowed by design,
 * it would do so silently, for ever. `crates/core`'s client has always handled prefixes (`api.rs`
 * `Backend::parse`); this side had not.
 */
function registryEndpoint(registryUrl: string, path: string): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`
  return new URL(path.replace(/^\//, ""), base).toString()
}

/** Fetches a challenge from the registry, or `null` if it did not answer with one. */
async function fetchChallenge(
  registryUrl: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<IssuedChallenge | null> {
  const response = await fetcher(registryEndpoint(registryUrl, "/v1/nodes/challenge"), {
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

/** The registry's error code and the reason behind it, or `{}` if the body was not an envelope. */
async function refusalDetail(
  response: Response,
): Promise<{ code?: string; reason?: string; detail?: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; details?: { reason?: unknown; detail?: unknown } }
    }
    const details = body.error?.details
    return {
      ...(body.error?.code === undefined ? {} : { code: body.error.code }),
      ...(typeof details?.reason === "string" ? { reason: details.reason } : {}),
      // `invalid-url` carries a second level — `not-under-domain`, `not-https`, `unparseable` —
      // and which of those it is changes what an operator has to fix.
      ...(typeof details?.detail === "string" ? { detail: details.detail } : {}),
    }
  } catch {
    return {}
  }
}
