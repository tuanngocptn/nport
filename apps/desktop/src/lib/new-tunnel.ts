import { checkSubdomain, type RejectionReason } from "@nport/contract/subdomain"

/**
 * Validating the New tunnel form, and mirroring it as a CLI command.
 *
 * Pure, so it is tested without a renderer — same arrangement as `tunnel-state.ts`.
 *
 * **The subdomain rules come from `packages/contract` and are not restated here** (ADR-0045). That
 * package is the authority the server validates against too, so a name this form accepts is a name
 * the server accepts, and adding a reserved word happens in one place. Restating even the length
 * bounds would be a second copy to drift.
 *
 * Imported from `@nport/contract/subdomain` rather than the package root, which costs 90 kB of zod
 * in the bundle for rules that are pure string work. The subpath export exists for exactly this, and
 * that module imports nothing.
 */

/** What a port field can hold. Cheap to check, and the CLI checks the same thing. */
export type PortCheck =
  | { ok: true; port: number }
  | { ok: false; reason: "empty" | "not-a-number" | "out-of-range" }

/**
 * Ports are 1–65535, and 0 is not "any port" here.
 *
 * `LOCAL_PORT_INVALID` is a registry code, so this refusal has a real counterpart server-side; the
 * form just says it sooner. Rejecting before provisioning is `crates/CLAUDE.md`'s CLI rule 6 — a
 * tunnel to nothing is worse than a refusal.
 */
export function checkPort(input: string): PortCheck {
  const trimmed = input.trim()
  if (trimmed === "") return { ok: false, reason: "empty" }

  // `Number` rather than `parseInt`, which happily reads "3000abc" as 3000 and would let the form
  // accept a value the field does not show.
  const port = Number(trimmed)
  if (!Number.isInteger(port)) return { ok: false, reason: "not-a-number" }
  if (port < 1 || port > 65535) return { ok: false, reason: "out-of-range" }

  return { ok: true, port }
}

/** What the subdomain hint shows. `undefined` input means "generate one", which is always fine. */
export type SubdomainHint =
  | { state: "generated" }
  | { state: "ok"; subdomain: string }
  | { state: "rejected"; reason: RejectionReason }

/**
 * Checks a requested name against the shared rules.
 *
 * **Advisory only.** The server normalizes again and owns the value that becomes the lease key
 * (defect 36); this exists so a name that cannot possibly work says so before a round trip, not so
 * the client can decide. A name this accepts can still lose a race for the lease.
 */
export function checkRequestedSubdomain(input: string): SubdomainHint {
  if (input.trim() === "") return { state: "generated" }

  const check = checkSubdomain(input)
  return check.ok
    ? { state: "ok", subdomain: check.subdomain }
    : { state: "rejected", reason: check.reason }
}

/** Everything the form can put into a tunnel. */
export interface NewTunnelForm {
  port: string
  subdomain: string
  backend?: string
  registry?: string
}

/**
 * The same tunnel, as a command someone can paste.
 *
 * The mockup calls this the *Equivalent command* and gives it a whole panel: "Every control maps to
 * a CLI flag. Copy this into CI, a Makefile, or a teammate's terminal." That is worth honouring
 * precisely — a mirror that is subtly wrong is worse than no mirror, because it is copied into a
 * script and fails somewhere else.
 *
 * Flags are the real ones from `schema/cli.json`, which is generated from the binary's own clap
 * definition, so this cannot name a flag `nport` does not accept.
 */
export function equivalentCommand(form: NewTunnelForm): string {
  const port = checkPort(form.port)
  const parts = ["nport", port.ok ? String(port.port) : "<port>"]

  const subdomain = form.subdomain.trim()
  if (subdomain !== "") {
    // The **raw** request, exactly what the app sends. Showing the normalized form would print a
    // command that differs from the one being run.
    parts.push("-s", subdomain)
  }

  // Only when they differ from the defaults: a mirror cluttered with flags the user did not set is
  // one they stop reading.
  if (form.backend !== undefined && form.backend !== "") parts.push("--backend", form.backend)
  if (form.registry !== undefined && form.registry !== "") parts.push("--registry", form.registry)

  return parts.join(" ")
}

/** Whether the form can be submitted at all. */
export function canStart(form: NewTunnelForm): boolean {
  return checkPort(form.port).ok && checkRequestedSubdomain(form.subdomain).state !== "rejected"
}
