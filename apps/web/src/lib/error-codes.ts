import { ERROR_CODES, type ErrorCode, errorSlug, isErrorCode } from "@nport/contract"

/**
 * The mapping between a `docsUrl` slug and a registry code.
 *
 * In its own module rather than inside the page so it can be tested without importing a Next route —
 * and because the property that matters is not how the page looks but that **every URL the product
 * emits resolves to one**. `apps/node` puts `https://nport.link/errors/<slug>` in every error envelope
 * and `crates/cli` prints it as the whole remedy for the codes it does not translate, so a slug that
 * does not round-trip is a 404 at the exact moment someone needs help.
 */

/** `SUBDOMAIN_IN_USE` → `subdomain-in-use`. Re-exported so callers need one import, not two. */
export { errorSlug }

/** `subdomain-in-use` → `SUBDOMAIN_IN_USE`, or `undefined` if the slug names nothing. */
export function codeFromSlug(slug: string): ErrorCode | undefined {
  const wire = slug.toUpperCase().replaceAll("-", "_")
  return isErrorCode(wire) ? wire : undefined
}

/** Every slug the site serves a page for. */
export function everySlug(): string[] {
  return ERROR_CODES.map(errorSlug)
}

/**
 * Next's `generateStaticParams` for `/errors/[code]`, living here rather than in the route.
 *
 * The route **re-exports this under that name** instead of wrapping it, and the reason is testability:
 * a unit test cannot import the route module (it is `.tsx`, and `tsconfig.json` sets `jsx: "preserve"`
 * for Next's own compiler, which Vite then cannot parse). Wrapping it would have left the wrapper
 * untested — `docs/ROADMAP.md`'s defect 25, where a passing test of a helper says nothing about whether
 * anything calls it. A re-export has no body to get wrong, so the only untested step is an identity the
 * compiler checks.
 *
 * The build is the other half of the proof: `next build` lists one prerendered path per code, so a
 * route that stopped using this would show up as a page count rather than as a silent 404.
 */
export function errorPageParams(): Array<{ code: string }> {
  return everySlug().map((code) => ({ code }))
}
