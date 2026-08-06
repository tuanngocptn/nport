import { describe, expect, it } from "vitest"

import { CLI, flagsOursFirst, usage } from "./cli-reference"

/**
 * The generated reference has the fields the page reads.
 *
 * `schema/cli.json` is written by `cargo xtask codegen`, and `crates/xtask` already tests the *content* —
 * that every flag is present, that `--quiet` is a switch, that `--help` is marked built in. What it cannot
 * test is the consumer's assumption: this module casts the JSON to an interface, and a cast is a promise
 * the compiler takes on faith. These are the checks that keep the promise honest across a language
 * boundary, which is the seam the four "claimed elsewhere" defects all lived on.
 */

describe("the generated document", () => {
  it("is the nport command", () => {
    expect(CLI.name).toBe("nport")
    expect(CLI.about).toBeTruthy()
  })

  it("carries the flags and the positional the page renders", () => {
    expect(CLI.flags.length).toBeGreaterThanOrEqual(7)
    expect(CLI.positionals).toHaveLength(1)
  })

  it("gives every entry the fields the table reads", () => {
    // Reading a missing field would render "undefined" into a documentation page, which is worse than an
    // empty cell — so the shape is asserted rather than assumed from the cast.
    for (const argument of [...CLI.flags, ...CLI.positionals]) {
      expect(typeof argument.id, JSON.stringify(argument)).toBe("string")
      expect(typeof argument.takesValue).toBe("boolean")
      expect(typeof argument.builtin).toBe("boolean")
      // `null` rather than absent for the optional ones: `usage()` branches on `=== null`.
      expect(argument).toHaveProperty("short")
      expect(argument).toHaveProperty("long")
      expect(argument).toHaveProperty("valueName")
      expect(argument).toHaveProperty("help")
    }
  })
})

describe("usage", () => {
  /** Throws with the flag's name rather than returning `undefined` for a `!` to paper over. */
  function flag(long: string) {
    const found = CLI.flags.find((entry) => entry.long === long)
    if (found === undefined) throw new Error(`no --${long} in schema/cli.json`)
    return found
  }

  it("writes both forms when a flag has both", () => {
    expect(usage(flag("subdomain"))).toBe("-s, --subdomain <NAME>")
  })

  it("writes only the long form when there is no short one", () => {
    expect(usage(flag("backend"))).toBe("--backend <URL>")
  })

  it("appends no value to a switch", () => {
    // The bug this guards: `--quiet QUIET` on a published page, which is what the generator emitted before
    // `Command::build()` was called (`crates/xtask/src/cli_reference.rs`). Asserted on this side too,
    // because the page is where a reader would believe it.
    expect(usage(flag("quiet"))).toBe("-q, --quiet")
  })
})

describe("flagsOursFirst", () => {
  it("puts clap's own flags last", () => {
    // A reader looking for `--subdomain` should not scroll past `--help` to find it.
    const ordered = flagsOursFirst()
    const firstBuiltin = ordered.findIndex((flag) => flag.builtin)
    const lastOurs = ordered.map((flag) => flag.builtin).lastIndexOf(false)
    expect(firstBuiltin).toBeGreaterThan(lastOurs)
  })

  it("loses nothing", () => {
    expect(flagsOursFirst()).toHaveLength(CLI.flags.length)
  })
})
