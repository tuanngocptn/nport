/**
 * A fake Cloudflare API, good enough to drive the provisioning saga.
 *
 * ## Why a global `fetch` patch
 *
 * `@cloudflare/vitest-pool-workers` 0.20 exports no `fetchMock`, and the Worker under test — Durable
 * Objects included — runs in the **same isolate as the test file**, which the pool's own types state
 * plainly: "any global mocks will apply to it too". So replacing `globalThis.fetch` is the supported
 * seam, and it reaches inside the Durable Object, which no per-request mock could.
 *
 * ## Why a stateful fake rather than canned replies
 *
 * The saga's whole purpose is that state is consistent after a failure. A stub returning fixed
 * responses cannot answer "is there still a tunnel", so it cannot tell a compensated failure from an
 * orphan — the one thing these tests exist to check. This fake keeps tunnels and DNS records in maps
 * and answers lookups from them, so a test asserts on what Cloudflare would be left holding.
 *
 * Failures are injected per operation, which is how the compensation paths get exercised without
 * needing a real outage.
 */

export type Operation =
  | "create-tunnel"
  | "find-tunnel"
  | "clear-connections"
  | "delete-tunnel"
  | "find-dns"
  | "create-dns"
  | "delete-dns"

interface FakeTunnel {
  id: string
  name: string
}

interface FakeDnsRecord {
  id: string
  name: string
  type: string
  content: string
}

export interface FailureSpec {
  /** HTTP status to answer with. */
  readonly status: number
  /** Cloudflare error codes, e.g. `[81053]`. */
  readonly codes?: readonly number[]
  /** Fail this many times, then behave normally. Omit to fail every time. */
  readonly times?: number
}

export class FakeCloudflare {
  readonly tunnels = new Map<string, FakeTunnel>()
  readonly dns = new Map<string, FakeDnsRecord>()
  /** Every operation, in order. Asserting on this is how "nothing was left behind" is checked. */
  readonly calls: Operation[] = []

  #failures = new Map<Operation, { spec: FailureSpec; remaining: number }>()
  #delays = new Map<Operation, number>()
  #nextId = 1
  #original: typeof fetch | undefined

  /** Makes the next `times` (or all) attempts at `operation` fail. */
  fail(operation: Operation, spec: FailureSpec): void {
    this.#failures.set(operation, { spec, remaining: spec.times ?? Number.POSITIVE_INFINITY })
  }

  /** Stops injecting failures. Needed to assert that a name is reclaimable after a failed saga. */
  recover(): void {
    this.#failures.clear()
  }

  /**
   * Makes `operation` take `ms` before answering.
   *
   * The only way to test what happens *during* a saga. A slow Cloudflare is not hypothetical — the
   * client retries each call up to three times with backoff, so an incident where every request hangs
   * puts a saga well past the watchdog window.
   */
  slow(operation: Operation, ms: number): void {
    this.#delays.set(operation, ms)
  }

  /** Pre-existing DNS record, for the conflict paths. */
  seedDns(name: string, type: string, content: string): FakeDnsRecord {
    const record = { id: `rec-${this.#nextId++}`, name, type, content }
    this.dns.set(name, record)
    return record
  }

  install(): void {
    this.#original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(input, init)) as typeof fetch
  }

  restore(): void {
    if (this.#original !== undefined) {
      globalThis.fetch = this.#original
    }
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    const method = (init?.method ?? "GET").toUpperCase()

    if (url.hostname !== "api.cloudflare.com") {
      // Anything else is a bug in the code under test, and letting it reach the network would make
      // the suite depend on someone else's uptime.
      throw new Error(`unexpected outbound request to ${url.hostname}`)
    }

    const operation = classify(url.pathname, method)
    this.calls.push(operation)

    const delay = this.#delays.get(operation)
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    const failure = this.#failures.get(operation)
    if (failure !== undefined && failure.remaining > 0) {
      failure.remaining -= 1
      return json(failure.spec.status, {
        success: false,
        result: null,
        errors: (failure.spec.codes ?? [1000]).map((code) => ({ code, message: "injected" })),
      })
    }

    return this.#dispatch(operation, url, init)
  }

  async #dispatch(operation: Operation, url: URL, init?: RequestInit): Promise<Response> {
    const payload =
      init?.body === null || init?.body === undefined ? {} : JSON.parse(String(init.body))

    switch (operation) {
      case "create-tunnel": {
        const id = `tunnel-${this.#nextId++}`
        const name = String(payload.name)
        this.tunnels.set(id, { id, name })
        // A token shaped like the real thing, so nothing accidentally depends on its contents.
        return json(200, { success: true, result: { id, token: `token-for-${id}` } })
      }
      case "find-tunnel": {
        const name = url.searchParams.get("name")
        const found = [...this.tunnels.values()].filter((tunnel) => tunnel.name === name)
        return json(200, { success: true, result: found })
      }
      case "clear-connections":
        return json(200, { success: true, result: null })
      case "delete-tunnel": {
        const id = url.pathname.split("/").pop() ?? ""
        this.tunnels.delete(id)
        return json(200, { success: true, result: null })
      }
      case "find-dns": {
        const name = url.searchParams.get("name")
        const record = name === null ? undefined : this.dns.get(name)
        return json(200, { success: true, result: record === undefined ? [] : [record] })
      }
      case "create-dns": {
        const name = String(payload.name)
        if (this.dns.has(name)) {
          return json(400, {
            success: false,
            result: null,
            errors: [{ code: 81053, message: "record already exists" }],
          })
        }
        const record = {
          id: `rec-${this.#nextId++}`,
          name,
          type: String(payload.type),
          content: String(payload.content),
        }
        this.dns.set(name, record)
        return json(200, { success: true, result: record })
      }
      case "delete-dns": {
        const id = url.pathname.split("/").pop() ?? ""
        for (const [name, record] of this.dns) {
          if (record.id === id) {
            this.dns.delete(name)
          }
        }
        return json(200, { success: true, result: null })
      }
    }
  }
}

function classify(pathname: string, method: string): Operation {
  if (pathname.includes("/cfd_tunnel")) {
    if (pathname.endsWith("/connections")) return "clear-connections"
    if (method === "POST") return "create-tunnel"
    if (method === "GET") return "find-tunnel"
    return "delete-tunnel"
  }
  if (pathname.includes("/dns_records")) {
    if (method === "POST") return "create-dns"
    if (method === "GET") return "find-dns"
    return "delete-dns"
  }
  throw new Error(`fake cloudflare: unrecognised ${method} ${pathname}`)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
