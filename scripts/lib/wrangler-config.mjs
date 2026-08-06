/**
 * Reading `wrangler.jsonc` from Node, and resolving an environment the way wrangler does.
 *
 * Shared by `deploy-check.mjs` and `verify-deployment.mjs` because both need the same two things and
 * a second copy of a JSONC parser is a second thing to get wrong.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * Strips `//` and block comments from JSONC without eating them inside strings.
 *
 * `JSON.parse` cannot read these files and Node has no JSONC parser. A naive regex would corrupt any
 * string containing `//` — a URL, say — so this walks the text tracking whether it is inside a
 * string and whether the previous character escaped the next.
 */
export function stripJsonc(text) {
  let out = ""
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    const next = text[at + 1]

    if (inLine) {
      if (char === "\n") {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false
        at += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      inLine = true
      at += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlock = true
      at += 1
      continue
    }
    out += char
  }

  // Trailing commas are legal in jsonc and not in JSON.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Parses a `wrangler.jsonc`, with a sanity check that the comment stripper did not mangle it. */
export function loadWranglerConfig(relative) {
  const parsed = JSON.parse(stripJsonc(readFileSync(join(ROOT, relative), "utf8")))
  if (typeof parsed?.name !== "string") {
    throw new Error(`${relative}: parsed but has no "name" — the comment stripper is wrong`)
  }
  return parsed
}

/**
 * The `vars` a named environment actually deploys with.
 *
 * **Not merged with the top level, because wrangler does not merge them.** `vars` is marked
 * `notInheritable` in wrangler's own config parser: an environment block replaces the top-level one
 * outright. Anything that reasons about a deployed Worker has to model that, or it will compute an
 * expectation the Worker was never given — which is precisely the failure these scripts exist to
 * catch, so getting it wrong here would hide it twice.
 */
export function varsFor(config, envName) {
  if (envName === undefined || envName === "") return config.vars ?? {}

  const env = config.env?.[envName]
  if (env === undefined) {
    throw new Error(`no env.${envName} in this config`)
  }
  return env.vars ?? {}
}
