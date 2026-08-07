/**
 * The only place this Worker talks to Cloudflare.
 *
 * Rule 3 in `apps/node/CLAUDE.md`: never `fetch` the Cloudflare API directly. Retry, backoff,
 * bounded attempts, and error mapping live here so a caller cannot forget any of them, and so the
 * subrequest budget can be reasoned about in one place.
 *
 * **Raw upstream text never leaves this file.** Failures throw [`CloudflareError`], which carries a
 * status and Cloudflare's numeric error codes — enough for the saga to branch on — and the human
 * text goes to `console.error` only. v2 echoed Cloudflare's error strings straight to anonymous
 * callers, leaking account and zone internals (defect R11).
 *
 * ## Which endpoints, and why these
 *
 * Exactly the operations provisioning needs, plus the two lookups that make teardown verifiable.
 * That is a deliberate ceiling: `docs/ARCHITECTURE.md` §6 budgets provisioning at ~4–5 subrequests
 * out of the free plan's 50.
 *
 * v2 used the older `/accounts/{id}/tunnels` alias. `cfd_tunnel` is the current documented name for
 * the same resource, and every path, parameter and response field used here was checked against
 * Cloudflare's published OpenAPI schema and its generated Go SDK on 2026-08-05 (`docs/OPERATIONS.md`
 * § Verifying the Cloudflare API surface). That is not the same as having run against the live API,
 * which has still never happened — but it is what turned two guesses into one known-good call and
 * one documented divergence, both handled below.
 *
 * ## Idempotency
 *
 * The Cloudflare API offers no idempotency key for these calls, so a retry after an ambiguous
 * failure could create a second tunnel. Idempotency comes from **naming instead**: every tunnel
 * NPort creates is named `nport-<subdomain>`, so a compensating step can find it by name and
 * confirm what actually happened rather than assuming (`tunnelNameFor`).
 */

/** cloudflared resolves a tunnel's routable hostname to this; the CNAME must point at it. */
export const CFARGOTUNNEL_SUFFIX = ".cfargotunnel.com"

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

/**
 * Attempts per call, including the first.
 *
 * Three, not "until it works": every attempt is a subrequest, and provisioning makes up to four
 * calls. Three attempts each is a worst case of 12 against a budget of 50, which leaves room for
 * the Durable Object hops. An unbounded retry loop here would turn a Cloudflare outage into a
 * Worker that exceeds its subrequest limit and fails in a way nobody can read.
 */
const MAX_ATTEMPTS = 3

/** Backoff before attempts 2 and 3, in milliseconds, before jitter. */
const BACKOFF_MS = [150, 600] as const

/** Cloudflare's code for "a DNS record with this name already exists". */
export const DNS_RECORD_EXISTS = 81053

/** The tunnel name NPort gives a subdomain's tunnel. */
export function tunnelNameFor(subdomain: string): string {
  // Namespaced on purpose. A self-hoster's account may hold tunnels NPort did not create, and
  // reconciliation must be able to tell them apart before it deletes anything.
  return `nport-${subdomain}`
}

/** The CNAME content a subdomain's DNS record must have for NPort to own it. */
export function cnameTargetFor(tunnelId: string): string {
  return `${tunnelId}${CFARGOTUNNEL_SUFFIX}`
}

export interface CloudflareConfig {
  readonly apiToken: string
  readonly accountId: string
  readonly zoneId: string
  /** The zone every tunnel lives under, e.g. `nport.link`. */
  readonly domain: string
}

export interface CreatedTunnel {
  readonly id: string
  /**
   * The connector credential, in the format `docs/PROTOCOL.md` §3 describes.
   *
   * Returned to the client exactly once and **never logged at any level**. Note that no method here
   * logs a response body, only failure codes — a `createTunnel` success body contains this.
   */
  readonly token: string
}

export interface TunnelSummary {
  readonly id: string
  readonly name: string
  /** ISO 8601, from Cloudflare. Reconciliation needs it to avoid racing a live saga. */
  readonly created_at?: string
}

export interface TunnelPage {
  readonly tunnels: readonly TunnelSummary[]
  /** Whether another page exists, so the sweep cursor knows when to wrap. */
  readonly hasMore: boolean
}

export interface DnsRecord {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly content: string
}

interface CloudflareEnvelope<T> {
  readonly success: boolean
  readonly result: T
  readonly errors?: readonly { readonly code: number; readonly message: string }[]
  // No `result_info`: nothing here reads pagination metadata any more, and the field that used to be
  // read off it does not exist on the endpoint that was being paginated (see `listTunnels`).
}

/**
 * A Cloudflare API failure, reduced to what a caller may branch on.
 *
 * Deliberately carries no upstream message: the field does not exist, so it cannot be forwarded by
 * accident into an error envelope.
 */
export class CloudflareError extends Error {
  readonly status: number
  readonly codes: readonly number[]
  /** Whether retrying could plausibly succeed. Drives `PROVISION_FAILED` vs a compensating retry. */
  readonly retryable: boolean

  constructor(operation: string, status: number, codes: readonly number[], retryable: boolean) {
    super(`cloudflare ${operation} failed with ${status}`)
    this.name = "CloudflareError"
    this.status = status
    this.codes = codes
    this.retryable = retryable
  }

  has(code: number): boolean {
    return this.codes.includes(code)
  }
}

/**
 * The longest `Retry-After` this client will wait out rather than give up on.
 *
 * The whole ladder is ~1.2 s before jitter, and a Worker request has a user waiting at the end of it,
 * so anything longer is not a delay we can absorb. Past this the remaining attempts are spent, not
 * saved: two more subrequests aimed at a service that just said stop.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 1_000

/**
 * `Retry-After` in milliseconds, or `undefined` when there is nothing usable to read.
 *
 * Delta-seconds only. The HTTP-date form is legal and Cloudflare does not send it; treating it as
 * absent falls back to the fixed ladder, which is the safe direction — a slightly short wait beats
 * mis-parsing a date into a wait of zero.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const text = header.trim()
  // `Number("")` is `0`, which would read as "retry immediately".
  if (text === "") return undefined
  const seconds = Number(text)
  if (!Number.isInteger(seconds) || seconds < 0) return undefined
  return seconds * 1_000
}

/** 408, 429, and 5xx are worth another attempt; everything else is our request being wrong. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export class CloudflareClient {
  readonly #config: CloudflareConfig
  readonly #fetcher: typeof fetch

  /**
   * `fetcher` defaults to the global `fetch`, resolved at construction and **bound to `globalThis`**.
   *
   * The bind is load-bearing. `this.#fetcher(…)` is a method call, so it passes *this client* as the
   * receiver, and workerd's `fetch` refuses any receiver but the global with `TypeError: Illegal
   * invocation`. Nothing catches that before production: every test injects a plain function, which
   * does not care what `this` is, and the dev fake is a plain function too — so the only code path
   * that reaches the real `fetch` is the one that only runs against the real API. It failed there on
   * the first provisioning attempt, on every operation at once.
   *
   * Only the default is bound. An injected fetcher is called as given, in case it is a method that
   * needs its own receiver.
   *
   * It is injectable so `client.test.ts` can drive every branch — retry, backoff, error mapping —
   * without a network or a workerd binding. The Durable Object always uses the default.
   */
  constructor(config: CloudflareConfig, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.#config = config
    this.#fetcher = fetcher
  }

  /** `myapp` → `myapp.nport.link`. */
  fqdn(subdomain: string): string {
    return `${subdomain}.${this.#config.domain}`
  }

  /**
   * Creates a tunnel and returns it with a usable connector credential.
   *
   * **The token is fetched separately when the create response does not carry one, and that branch is
   * the documented path rather than the fallback.** Cloudflare's schema for `POST .../cfd_tunnel`
   * returns the shared tunnel object, which has no `token` field — and its generated Go SDK agrees,
   * so `GET .../cfd_tunnel/{id}/token` is where a remotely-managed tunnel's credential officially
   * comes from. v2 nevertheless read `result.token` straight off a create, against the legacy
   * `/accounts/{id}/tunnels` alias, and did so in production for years. Since `/tunnels` documents no
   * POST at all yet plainly serves one, the two paths are the same handler with the schema describing
   * only one of them — which leaves it genuinely unknown whether the create response carries a token.
   *
   * So both are accepted: the field if it is there, the endpoint if it is not. Betting on either alone
   * risks a control plane where **every** provision fails on the first deploy, which is the single
   * largest first-deploy risk in `docs/ROADMAP.md` § The critical path. The cost of being right twice
   * is one conditional subrequest. Once the live API has answered, delete the branch it does not take
   * — a permanently dead path is worse than either half.
   */
  async createTunnel(name: string): Promise<CreatedTunnel> {
    const created = await this.#call<{ id: string; token?: string }>(
      "create-tunnel",
      "POST",
      `/accounts/${this.#config.accountId}/cfd_tunnel`,
      // `config_src: "cloudflare"` makes the tunnel remotely managed, which is what makes a token
      // sufficient — no `cert.pem`, no local config file. NPort writes no ingress rules: the
      // connector forwards every request to the single local port it was told about, and the edge
      // routes by the DNS CNAME (`docs/ARCHITECTURE.md` §3b).
      { name, config_src: "cloudflare" },
    )
    if (typeof created.token === "string" && created.token.length > 0) {
      return { id: created.id, token: created.token }
    }
    return { id: created.id, token: await this.#tunnelToken(created.id) }
  }

  /**
   * The connector credential for an existing tunnel.
   *
   * Unlike every other endpoint here, `result` is a bare **string** rather than an object — the token
   * itself. A throw leaves an orphan tunnel behind, which is exactly what `#provision`'s `create-tunnel`
   * compensation is for: it finds the tunnel by its derived name and deletes it, so this failing is no
   * worse than the create failing.
   */
  async #tunnelToken(tunnelId: string): Promise<string> {
    const result = await this.#call<unknown>(
      "tunnel-token",
      "GET",
      `/accounts/${this.#config.accountId}/cfd_tunnel/${tunnelId}/token`,
      null,
    )
    if (typeof result !== "string" || result.length === 0) {
      // A tunnel with no token is unusable and would strand the caller with an orphan, so treat it
      // as a failed call and let the saga compensate.
      throw new CloudflareError("tunnel-token", 502, [], true)
    }
    return result
  }

  /**
   * Tunnels with this exact name that are not deleted.
   *
   * The compensation path's ground truth: after an ambiguous `createTunnel`, this answers "did it
   * actually happen" without needing an ID we never received.
   */
  async findTunnelsByName(name: string): Promise<TunnelSummary[]> {
    const query = new URLSearchParams({ name, is_deleted: "false" })
    const result = await this.#call<TunnelSummary[] | null>(
      "find-tunnel",
      "GET",
      `/accounts/${this.#config.accountId}/cfd_tunnel?${query}`,
      null,
    )
    return (result ?? []).filter((tunnel) => tunnel.name === name)
  }

  /**
   * One page of the account's tunnels, for reconciliation.
   *
   * Paginated because the sweep is deliberately bounded per invocation: a Worker has 50 subrequests on
   * the free plan, and an unbounded list would spend them all before deleting anything. The cursor
   * lives in the `Registry` (`docs/ARCHITECTURE.md` §3f), so each run resumes where the last stopped —
   * bounded per run, unbounded over time, which is the fix for v2's starving cleanup (defect R8).
   *
   * Cloudflare offers no prefix filter, only exact `name`, so the caller filters `nport-` itself.
   *
   * **`hasMore` is page fullness, not pagination metadata, and that is not a shortcut.** The tunnels
   * list answers with a `result_info` holding `count`, `page`, `per_page` and `total_count` — and no
   * `total_pages`. The DNS list *does* have `total_pages`, which is where the original assumption came
   * from, and reading a field the endpoint never sends made `hasMore` permanently `false`: the sweep
   * cursor reset to page 1 on every run and nothing past the first page was ever examined. That is
   * v2's starving cleanup (defect R8) for the third time, so the replacement deliberately depends on
   * no metadata at all. `total_count` would not do either — the schema defines it as the count
   * *without* search parameters, and this call filters on `is_deleted`.
   *
   * A full page means there may be more; a short page is the last one. The one imprecision is a total
   * that divides exactly by `perPage`, which costs one extra run over an empty page before wrapping.
   */
  async listTunnels(page: number, perPage: number): Promise<TunnelPage> {
    const query = new URLSearchParams({
      is_deleted: "false",
      page: String(page),
      per_page: String(perPage),
    })
    const result = await this.#call<TunnelSummary[] | null>(
      "list-tunnels",
      "GET",
      `/accounts/${this.#config.accountId}/cfd_tunnel?${query}`,
      null,
    )
    const tunnels = result ?? []
    // `>=` rather than `===` so a page longer than requested — a clamped `per_page`, a future default
    // — still reads as "keep going" instead of silently ending the sweep.
    return { tunnels, hasMore: tunnels.length >= perPage }
  }

  /**
   * Deletes a tunnel, clearing its connections first.
   *
   * Cloudflare refuses to delete a tunnel that still has registered connections, and a connector
   * that was SIGKILLed leaves them behind — so the clearing step is the common case, not the
   * exception. Its failure is logged and swallowed: if the connections were already gone, the
   * delete that follows is what matters.
   */
  async deleteTunnel(tunnelId: string): Promise<void> {
    try {
      await this.#call<unknown>(
        "clear-connections",
        "DELETE",
        `/accounts/${this.#config.accountId}/cfd_tunnel/${tunnelId}/connections`,
        null,
      )
    } catch (error) {
      console.warn("cloudflare clear-connections failed, continuing to delete", {
        tunnelId,
        status: error instanceof CloudflareError ? error.status : undefined,
      })
    }

    try {
      await this.#call<unknown>(
        "delete-tunnel",
        "DELETE",
        `/accounts/${this.#config.accountId}/cfd_tunnel/${tunnelId}`,
        null,
        // Declared here as well as handled below, so the client logs it as routine rather than as
        // an error. The two have to agree: tolerating a status while still shouting about it is
        // the worst of both.
        [404],
      )
    } catch (error) {
      // **A tunnel that is already gone is this method's whole purpose, achieved.** Alarms are
      // at-least-once (rule 5), so a teardown that succeeded and then lost its response is
      // redelivered — and without this the retry answers 404, the lease stays in `RELEASING`, and
      // the alarm reschedules itself every 30 seconds forever while holding the subdomain. The DNS
      // half of `#releaseCloudflare` never had this problem because it deletes only what
      // `findDnsRecord` just returned; the tunnel half deletes straight from the stored ID.
      //
      // A 404 can also mean a wrong `CF_ACCOUNT_ID`, which this now swallows. That is the lesser
      // failure by a distance: a wrong account fails at `createTunnel` long before anything is
      // torn down, and the alternative is a name nobody can ever reclaim.
      if (error instanceof CloudflareError && error.status === 404) {
        return
      }
      throw error
    }
  }

  /** The record for an exact name, or `null`. Any type — the caller decides what is acceptable. */
  async findDnsRecord(name: string): Promise<DnsRecord | null> {
    // `name` is a query parameter, so it is encoded rather than interpolated. v2 interpolated the
    // raw user value into this URL, which is how `&` and `#` in a subdomain became a Cloudflare API
    // call nobody intended (defect R2).
    const query = new URLSearchParams({ name })
    const result = await this.#call<DnsRecord[] | null>(
      "find-dns",
      "GET",
      `/zones/${this.#config.zoneId}/dns_records?${query}`,
      null,
    )
    return (result ?? []).find((record) => record.name === name) ?? null
  }

  async createDnsRecord(name: string, target: string): Promise<DnsRecord> {
    return this.#call<DnsRecord>(
      "create-dns",
      "POST",
      `/zones/${this.#config.zoneId}/dns_records`,
      {
        type: "CNAME",
        name,
        content: target,
        // Proxied, so the edge terminates TLS and the tunnel is reachable over HTTPS at all.
        proxied: true,
        ttl: 1,
      },
    )
  }

  async deleteDnsRecord(recordId: string): Promise<void> {
    await this.#call<unknown>(
      "delete-dns",
      "DELETE",
      `/zones/${this.#config.zoneId}/dns_records/${recordId}`,
      null,
    )
  }

  async #call<T>(
    operation: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: object | null,
    tolerate: readonly number[] = [],
  ): Promise<T> {
    let lastError: CloudflareError | undefined
    /** Set when Cloudflare named a delay, so the next wait is its number rather than ours. */
    let honouredDelayMs: number | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        // `sleep` jitters upward, so honouring a delay always waits at least as long as asked.
        await sleep(honouredDelayMs ?? BACKOFF_MS[attempt - 2] ?? 600)
        honouredDelayMs = undefined
      }

      let response: Response
      try {
        response = await this.#fetcher(`${CF_API_BASE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.#config.apiToken}`,
            "content-type": "application/json",
          },
          body: body === null ? null : JSON.stringify(body),
        })
      } catch (cause) {
        // A transport failure is indistinguishable from a timeout here, and both are worth
        // retrying. The cause is logged rather than attached, so it cannot reach a response.
        console.error("cloudflare request failed", { operation, error: String(cause) })
        lastError = new CloudflareError(operation, 0, [], true)
        continue
      }

      const text = await response.text()
      let envelope: CloudflareEnvelope<T> | undefined
      try {
        envelope = JSON.parse(text) as CloudflareEnvelope<T>
      } catch {
        // Cloudflare returning non-JSON means something upstream is very wrong — a proxy error
        // page, usually. Never log `text`: on a partial success it could contain a tunnel token.
        console.error("cloudflare returned non-JSON", { operation, status: response.status })
      }

      if (response.ok && envelope?.success === true) {
        return envelope.result
      }

      const codes = (envelope?.errors ?? []).map((error) => error.code)
      const detail = {
        operation,
        status: response.status,
        // Codes and messages from the `errors` array only. A failure envelope carries no token,
        // and this is the detail an operator needs (rule 8: log it, never return it).
        errors: (envelope?.errors ?? []).map((error) => `[${error.code}] ${error.message}`),
      }
      // A status the caller has said it expects is not an error, and logging it as one trains
      // people to ignore the ones that are. `deleteTunnel` tolerating 404 is the case in hand: on a
      // second alarm delivery it is the normal outcome, and it was printing a red `[ERROR]` on an
      // otherwise clean `pnpm dev` start. Still logged — an operator wants to know a delete found
      // nothing — just not at a level that implies something needs doing.
      if (tolerate.includes(response.status)) {
        console.info("cloudflare api returned a tolerated status", detail)
      } else {
        console.error("cloudflare api error", detail)
      }

      const retryable = isRetryableStatus(response.status)
      lastError = new CloudflareError(operation, response.status, codes, retryable)
      if (!retryable) {
        throw lastError
      }

      // **What Cloudflare asked for beats what we guessed.** Retrying a 429 on a fixed 150 ms ladder
      // ignores the one number the upstream actually supplied, and the account this whole service runs
      // on is the thing being rate-limited (ADR-0031) — hammering through a 429 is how a short block
      // becomes a long one. Honour a delay we can absorb; stop immediately when we cannot, because
      // spending two more subrequests on a service that said "wait 30 s" helps nobody.
      const asked = retryAfterMs(response.headers.get("retry-after"))
      if (asked !== undefined) {
        if (asked > MAX_HONOURED_RETRY_AFTER_MS) {
          throw lastError
        }
        honouredDelayMs = asked
      }
    }

    throw lastError ?? new CloudflareError(operation, 0, [], true)
  }
}

/**
 * Jittered sleep.
 *
 * Jitter matters more than the delay: without it, every request that fails during a Cloudflare
 * blip retries in lockstep and the recovery is a second thundering herd.
 */
function sleep(baseMs: number): Promise<void> {
  const delay = baseMs + Math.floor(Math.random() * baseMs)
  return new Promise((resolve) => {
    setTimeout(resolve, delay)
  })
}
