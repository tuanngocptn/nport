/**
 * The client-version gate's pure half.
 *
 * Both Workers impose a `MIN_CLIENT_VERSION` floor, and the *middleware* that does it belongs to each
 * app — it reads a binding and throws a Hono-shaped error, which is outside this package's boundary.
 * What is shared is the two functions that decide the answer, because they are the part that must not
 * diverge: pre-release ordering is subtle enough that `apps/api`'s `wrangler.jsonc` carries a paragraph
 * about it, and two implementations disagreeing would mean one service admitting a client the other
 * refuses.
 *
 * **Not authentication** — there are no accounts (ADR-0007), and anyone can send any header. The gate
 * exists because NPort owns the connector protocol now: when Cloudflare's edge changes, installed
 * clients break in ways only a new binary can fix, and this is the only channel for saying so.
 */

/**
 * Extracts the version from `nport/<version> (<os>; <arch>)`.
 *
 * Anchored to the start so a hostile User-Agent cannot smuggle a high version in a trailing comment.
 * Pre-release suffixes are kept, because `3.0.0-beta.1` must stay distinguishable from `3.0.0`.
 */
export function parseVersion(userAgent: string): string | undefined {
  const match = /^nport\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(userAgent)
  return match?.[1]
}

/**
 * Semver-ish comparison: -1, 0, or 1.
 *
 * Only what the gate needs — numeric triples plus the rule that any pre-release sorts *below* the
 * release it precedes. That last part matters at a release boundary: without it `3.0.0-beta.1` would
 * satisfy a `3.0.0` floor, letting every beta client through the moment the floor moves.
 */
export function compareVersions(left: string, right: string): number {
  const split = (version: string) => {
    const [core = "", pre] = version.split("-", 2)
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0)
    return { parts, pre }
  }

  const a = split(left)
  const b = split(right)

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }

  if (a.pre === undefined && b.pre === undefined) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre === b.pre ? 0 : a.pre < b.pre ? -1 : 1
}
