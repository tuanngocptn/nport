import { docsUrl, ERROR_CODES } from "@nport/contract"
import { describe, expect, it } from "vitest"

import { codeFromSlug, errorPageParams, errorSlug, everySlug } from "./error-codes"

/**
 * The promise `/errors/[code]` exists to keep.
 *
 * Every error envelope `apps/node` returns carries a `docsUrl`, and for the seven codes `crates/cli`
 * does not translate, that URL is the *entire* remedy the user is offered. Thirty-three of them existed
 * before this route did and none resolved — so the test that matters is coverage and round-tripping,
 * not layout.
 */

describe("every code the product can emit has a page", () => {
  it("prerenders one page per registry code", () => {
    // **The function the route exports**, not a lookalike. The first draft asserted
    // `everySlug().length === ERROR_CODES.length`, which is tautological — `everySlug` maps
    // `ERROR_CODES`, so it proved `map` preserves length and nothing about which pages exist.
    //
    // The route re-exports `errorPageParams` under Next's name rather than wrapping it, so this is the
    // same function Next calls. That is as close as a unit test gets: the route module itself cannot be
    // imported here, because `tsconfig.json` sets `jsx: "preserve"` for Next's compiler and Vite then
    // fails to parse it. `next build` listing one prerendered path per code is the other half.
    const params = errorPageParams()
    const rendered = new Set(params.map((param) => param.code))

    expect(rendered.size).toBe(ERROR_CODES.length)
    for (const code of ERROR_CODES) {
      expect(rendered.has(errorSlug(code)), `${code} has no page`).toBe(true)
    }
  })

  it("has one canonical slug per code and no duplicates", () => {
    expect(new Set(everySlug()).size).toBe(everySlug().length)
  })

  it("round-trips every slug back to its code", () => {
    // The failure this catches is a slug the API emits and the site cannot parse — a 404 at the exact
    // moment someone needs help.
    for (const code of ERROR_CODES) {
      expect(codeFromSlug(errorSlug(code)), code).toBe(code)
    }
  })

  it("resolves the URL the contract actually puts in an envelope", () => {
    // Derived from `docsUrl` rather than rebuilt here, because rebuilding it is how the two spellings
    // drift — and `docsUrl` is the function `apps/node` and `crates/cli` both call.
    for (const code of ERROR_CODES) {
      const url = new URL(docsUrl(code))
      const slug = url.pathname.replace("/errors/", "")
      expect(codeFromSlug(slug), url.toString()).toBe(code)
    }
  })

  it("has no slug that needs escaping in a URL", () => {
    for (const slug of everySlug()) {
      expect(encodeURIComponent(slug), slug).toBe(slug)
    }
  })
})

describe("an unknown slug", () => {
  it("is undefined rather than a guess, so the route can 404", () => {
    // A guess here would render a page for a code that does not exist, which is worse than a 404: it
    // would look like documentation.
    expect(codeFromSlug("not-a-code")).toBeUndefined()
    expect(codeFromSlug("")).toBeUndefined()
    expect(codeFromSlug("../../etc/passwd")).toBeUndefined()
  })

  it("does not accept the wire spelling as a slug", () => {
    // `SUBDOMAIN_IN_USE` uppercases to itself, so a lenient mapping would serve two URLs for one code
    // and split whatever search engines make of them.
    expect(codeFromSlug("SUBDOMAIN_IN_USE")).toBe("SUBDOMAIN_IN_USE")
    // …which is why the canonical slug is the only one `generateStaticParams` emits.
    expect(everySlug()).not.toContain("SUBDOMAIN_IN_USE")
  })
})
