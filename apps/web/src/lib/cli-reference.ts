// The import attribute is required by Node's ESM loader, which is what runs the Playwright specs that
// import this module. Turbopack does not need it and Vitest transforms it away — so without the attribute
// this file works in the app and in unit tests and fails only in the e2e tier, which is the worst of the
// three places to discover it.
import reference from "../../../../schema/cli.json" with { type: "json" }

/**
 * The CLI flag reference, typed.
 *
 * **Read from `schema/cli.json`, which `cargo xtask codegen` generates from `crates/cli`'s clap
 * definition.** That is the whole point of the file existing: three `CLAUDE.md` files claimed the site
 * carried a generated flag reference for weeks before anything generated one (defect 38), and the fix has
 * to be a data flow rather than a page someone keeps in step with `--help`.
 *
 * Imported by relative path out of `apps/web` on purpose. `schema/` is the language-neutral home for
 * exactly this — `crates/contract` reads the same directory from the other side — and routing it through
 * `packages/contract` instead would put the CLI's argument shape inside the thing that is supposed to be
 * *the API contract and only that* (invariant 7).
 */

export interface CliArgument {
  readonly id: string
  readonly short: string | null
  readonly long: string | null
  readonly valueName: string | null
  readonly help: string | null
  readonly takesValue: boolean
  readonly required: boolean
  /** clap's own `--help`/`--version`, whose text clap owns. Listed apart so the page can say so. */
  readonly builtin: boolean
}

export interface CliReference {
  readonly name: string
  readonly about: string | null
  readonly positionals: readonly CliArgument[]
  readonly flags: readonly CliArgument[]
}

/**
 * The generated document.
 *
 * The `as` is the one place a cast is honest here: the JSON's inferred type is a structural echo of
 * whatever is currently in the file, and naming the interface is what makes a *change* to the generator's
 * shape a type error rather than a silently different page. `cli-reference.test.ts` checks the fields the
 * page actually reads are present, which is the half a cast cannot do.
 */
export const CLI = reference as CliReference

/** How a flag is written in prose: `-s, --subdomain <NAME>`. */
export function usage(argument: CliArgument): string {
  const names = [
    argument.short === null ? null : `-${argument.short}`,
    argument.long === null ? null : `--${argument.long}`,
  ].filter((name): name is string => name !== null)

  const value = argument.takesValue && argument.valueName ? ` <${argument.valueName}>` : ""
  return `${names.join(", ")}${value}`
}

/** Ours, then clap's — a reader looking for `--subdomain` should not scroll past `--help` to find it. */
export function flagsOursFirst(): readonly CliArgument[] {
  return [...CLI.flags].sort((a, b) => Number(a.builtin) - Number(b.builtin))
}
