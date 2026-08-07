/**
 * The gateway's bindings.
 *
 * **No Cloudflare credentials appear here, and that absence is the point** — the same property
 * `apps/registry` protects. The gateway terminates every public request, so it is the largest attack
 * surface in a deployment and the one thing that must not be able to provision anything. Tunnels are
 * created by `apps/node`, which is reachable only through a service binding.
 */

/** What a service binding gives us: something that answers a `Request` with a `Response`. */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>
}

export interface Env {
  /** HMAC key for the source hash. Never a raw IP anywhere (rule 11). */
  readonly IP_HASH_SECRET: string
  /** The floor for `nport/<version>` User-Agents. Both internal services see an already-gated request. */
  readonly MIN_CLIENT_VERSION: string
  readonly RATE_LIMITER: RateLimit

  /** The tunnel control plane. Present in every deployment — a gateway with no node serves nothing. */
  readonly NODE: ServiceBinding
  /**
   * The node directory. **Absent on a node-only deployment**, which is the whole point of the split
   * (ADR-0049): a node operator's account never receives the registry's code, so `/v1/nodes` does not
   * 404 there — it does not exist.
   */
  readonly REGISTRY?: ServiceBinding
}

export interface Variables {
  readonly requestId: string
  readonly sourceHash: string
}

/**
 * Headers the gateway adds before forwarding, and the internal services read instead of recomputing.
 *
 * **The trust boundary is deployment, not cryptography.** An internal service believes these because
 * it declares no `routes` and sets `workers_dev: false`, so the only way to reach it is the binding.
 * Give one of them a route and a caller could set `x-nport-source-hash` themselves and impersonate any
 * source — which would defeat every per-source cap at once. `check_internal_workers_are_private` in
 * `scripts/deploy-check.mjs` is what keeps that from happening quietly.
 */
export const FORWARDED_REQUEST_ID = "x-nport-request-id"
export const FORWARDED_SOURCE_HASH = "x-nport-source-hash"
