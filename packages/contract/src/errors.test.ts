import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { docsUrl, ERROR_CODES, ERRORS, errorSlug, httpStatus, isErrorCode } from "./errors"
import type { RouteDefinition } from "./routes"
import { ROUTES } from "./routes"

// Widened to the interface deliberately: `as const satisfies` narrows ROUTES to a union of
// literal shapes, so `route.response` does not exist on the DELETE member. The tests care about
// the contract, not about each literal.
const routes: readonly RouteDefinition[] = ROUTES

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

describe("the registry itself", () => {
  it("gives every server code an HTTP status and every client code none", () => {
    // The distinction is load-bearing: the Hono error handler calls httpStatus() on anything
    // that reaches it, and a client code with a status would silently become a response.
    for (const [code, definition] of Object.entries(ERRORS)) {
      if (definition.origin === "server") {
        expect(definition.status, code).toBeTypeOf("number")
      } else {
        expect(definition.status, code).toBeNull()
      }
    }
  })

  it("uses only statuses the API documents", () => {
    const allowed = new Set([400, 403, 404, 409, 410, 426, 428, 429, 500, 502, 503])
    for (const [code, definition] of Object.entries(ERRORS)) {
      if (definition.status !== null) {
        expect(allowed.has(definition.status), `${code} uses ${definition.status}`).toBe(true)
      }
    }
  })

  it("never marks a 4xx client-fault code retryable", () => {
    // Retryability drives an automatic retry in the CLI. Retrying a 403 or a 409 cannot
    // succeed, so a wrong value here means hammering a permanent failure.
    for (const [code, definition] of Object.entries(ERRORS)) {
      if (definition.status === 403 || definition.status === 409 || definition.status === 410) {
        expect(definition.retryable, `${code} is retryable but cannot succeed on retry`).toBe(false)
      }
    }
  })

  it("marks every 429 and 503 retryable", () => {
    for (const [code, definition] of Object.entries(ERRORS)) {
      if (definition.status === 429 || definition.status === 503) {
        expect(definition.retryable, code).toBe(true)
      }
    }
  })

  it("gives every code a message, a cause, and an action", () => {
    for (const [code, definition] of Object.entries(ERRORS)) {
      expect(definition.message.length, code).toBeGreaterThan(0)
      expect(definition.cause.length, code).toBeGreaterThan(0)
      expect(definition.action.length, code).toBeGreaterThan(0)
      // The message is shown to a user and translated; it should read as a sentence, not as a
      // fragment or an identifier.
      expect(definition.message, code).toMatch(/^[A-Z"']/)
    }
  })

  it("names codes in SCREAMING_SNAKE_CASE", () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it("has no two codes with the same message", () => {
    // A code whose only difference from another is wording is not a distinct contract.
    const seen = new Map<string, string>()
    for (const [code, definition] of Object.entries(ERRORS)) {
      const previous = seen.get(definition.message)
      expect(previous, `${code} duplicates ${previous}'s message`).toBeUndefined()
      seen.set(definition.message, code)
    }
  })
})

describe("slugs and URLs", () => {
  it("derives a URL-safe slug", () => {
    expect(errorSlug("SUBDOMAIN_IN_USE")).toBe("subdomain-in-use")
    expect(errorSlug("INTERNAL")).toBe("internal")
  })

  it("produces a unique slug per code", () => {
    // Slugs are website routes. A collision means one of two error pages is unreachable.
    const slugs = ERROR_CODES.map(errorSlug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("builds a docs URL that needs no escaping", () => {
    for (const code of ERROR_CODES) {
      const url = docsUrl(code)
      expect(url).toBe(encodeURI(url))
    }
  })

  it("honours a custom origin, for self-hosting", () => {
    expect(docsUrl("INTERNAL", "https://example.test")).toBe("https://example.test/errors/internal")
  })
})

describe("isErrorCode", () => {
  it("accepts every registered code", () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code), code).toBe(true)
    }
  })

  it("rejects an unknown string", () => {
    expect(isErrorCode("NOPE")).toBe(false)
    expect(isErrorCode("")).toBe(false)
  })

  it("rejects inherited Object properties", () => {
    // `code in ERRORS` would return true for these, which is why the implementation uses
    // Object.hasOwn. A client that trusted `"toString"` as a code would branch on nonsense.
    expect(isErrorCode("toString")).toBe(false)
    expect(isErrorCode("constructor")).toBe(false)
    expect(isErrorCode("__proto__")).toBe(false)
  })
})

describe("httpStatus", () => {
  it("returns the registered status", () => {
    expect(httpStatus("SUBDOMAIN_IN_USE")).toBe(409)
  })

  it("throws for a client-side code rather than inventing a status", () => {
    // Unreachable through the type, but both crates/contract and the Worker call this with
    // values that crossed a serialization boundary where the guarantee no longer holds.
    // @ts-expect-error deliberately passing a client code
    expect(() => httpStatus("LOCAL_PORT_CLOSED")).toThrow(/no HTTP status/)
  })
})

describe("routes agree with the registry", () => {
  it("references only real codes", () => {
    for (const route of ROUTES) {
      for (const code of route.errors) {
        expect(isErrorCode(code), `${route.method} ${route.path} → ${code}`).toBe(true)
      }
    }
  })

  it("references only server codes", () => {
    // A client-side code cannot be an HTTP response, so listing one on a route would put an
    // impossible status into the generated OpenAPI document.
    for (const route of ROUTES) {
      for (const code of route.errors) {
        expect(ERRORS[code].origin, `${route.method} ${route.path} → ${code}`).toBe("server")
      }
    }
  })

  it("lists no code twice on one route", () => {
    for (const route of ROUTES) {
      expect(new Set(route.errors).size, `${route.method} ${route.path}`).toBe(route.errors.length)
    }
  })

  it("marks exactly one route non-idempotent", () => {
    // Create is the only endpoint where a blind retry can produce a second tunnel. If this
    // count ever changes, the retry guidance in docs/API.md is wrong.
    const unsafe = ROUTES.filter((route) => !route.idempotent)
    expect(unsafe.map((route) => `${route.method} ${route.path}`)).toEqual(["POST /v1/tunnels"])
  })

  it("requires an owner token on exactly the mutating routes", () => {
    const guarded = ROUTES.filter((route) => route.requiresOwnerToken).map(
      (route) => `${route.method} ${route.path}`,
    )
    expect(guarded.sort()).toEqual([
      "DELETE /v1/tunnels/{subdomain}",
      "POST /v1/tunnels/{subdomain}/heartbeat",
    ])
  })

  it("gives every route a body or an explicitly bodiless success status", () => {
    for (const route of routes) {
      if (route.response === undefined) {
        expect(route.successStatus, `${route.method} ${route.path}`).toBe(204)
      }
    }
  })
})

describe("generated artifacts round-trip", () => {
  // G1.5's gate criterion: every code in docs/ERRORS.md maps back to the registry, and vice
  // versa. Reading the generated file rather than trusting codegen is the point — a generator
  // that drops a row is exactly what this catches.
  const errorsDoc = readFileSync(join(REPO, "docs", "ERRORS.md"), "utf8")

  it("documents every code exactly once", () => {
    for (const code of ERROR_CODES) {
      const rows = errorsDoc.split("\n").filter((line) => line.startsWith(`| \`${code}\` |`))
      expect(rows.length, `${code} appears in ${rows.length} table rows`).toBe(1)
    }
  })

  it("documents no code that is not in the registry", () => {
    const documented = [...errorsDoc.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map(
      (match) => match[1] as string,
    )
    for (const code of documented) {
      expect(isErrorCode(code), `${code} is documented but not registered`).toBe(true)
    }
    expect(documented.length).toBe(ERROR_CODES.length)
  })

  it("carries the generated banner, so nobody edits it by hand", () => {
    expect(errorsDoc).toContain("@generated")
  })

  it("keeps the OpenAPI document in step with the routes", () => {
    const openapi = JSON.parse(
      readFileSync(join(REPO, "schema", "nport-node.openapi.json"), "utf8"),
    ) as { paths: Record<string, Record<string, unknown>> }

    for (const route of ROUTES) {
      const operation = openapi.paths[route.path]?.[route.method.toLowerCase()]
      expect(
        operation,
        `${route.method} ${route.path} missing from the OpenAPI document`,
      ).toBeDefined()
    }
  })
})
