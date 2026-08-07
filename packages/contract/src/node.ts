/**
 * Node identity and the domain proof that gates registration.
 *
 * `docs/ARCHITECTURE.md` §1 and ADR-0031. A **node** is one deployment of `apps/node` bound to one
 * Cloudflare account and one domain; the **registry** is a directory that lists nodes and holds no
 * credentials. Enrolment is open and anonymous, so the only thing standing between a stranger and a
 * listing is proof of work plus the DNS proof below.
 *
 * **Why the proof lives here rather than in `apps/registry`.** Three parties have to agree on the
 * exact record name and value: the registry that resolves it, the node operator who publishes it, and
 * the documentation that tells them what to publish. Two of those are code and one is prose, which is
 * `CLAUDE.md`'s "anything a human and a program must both agree on is generated" — so the strings are
 * derived from one function and the docs quote it rather than restating it.
 *
 * Unlike a subdomain, a node id is **never normalized**. There is no equivalent of pasting
 * `myapp.nport.link` for a claim on `myapp`, so a `regex` is the honest validator here where it would
 * have been wrong there (see `subdomain.ts` on why `requestedSubdomainSchema` cannot use one).
 */

/**
 * Length bounds on a node id.
 *
 * Shorter than a subdomain's 63 because a node id is not a DNS label — it is a key in a directory and
 * an operator types it into a deploy config once. 32 leaves room for `nport-hk-1` and a region suffix
 * without inviting a sentence.
 */
export const NODE_ID_MIN_LENGTH = 3
export const NODE_ID_MAX_LENGTH = 32

/**
 * Same shape as a DNS label, deliberately: it appears in log lines, in `details.nodeId`, and in a
 * `--node` flag, and an id needing quoting in a shell is an id that will be quoted wrong.
 */
export const NODE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/

/**
 * The longest domain and URL the registry will look at.
 *
 * Resource bounds, in the contract rather than in each caller, for ADR-0034's reason: the registry
 * resolves a DNS name built from the domain and fetches the URL, and both are attacker-supplied on an
 * endpoint that anyone may call. 253 is the DNS maximum; a base URL longer than 512 characters is not
 * a base URL.
 */
export const MAX_NODE_DOMAIN_LENGTH = 253
export const MAX_NODE_URL_LENGTH = 512

/**
 * The two free-text fields a node declares about itself.
 *
 * Both are display-only and neither is ever verified, so the bound is the whole validation: a region
 * is a word like `apac` and a version is a semver string. Bounded anyway, because "display-only"
 * describes what we do with a value, not what a caller may send.
 */
export const MAX_NODE_REGION_LENGTH = 32
export const MAX_NODE_VERSION_LENGTH = 32

/**
 * The label the proof record lives under.
 *
 * Underscore-prefixed so it cannot collide with a tunnel: `_` is a reserved prefix in
 * `subdomain.ts`, and underscores never pass `SUBDOMAIN_PATTERN`, so no claim can ever produce this
 * name. That is the same reasoning `_acme-challenge` rests on.
 */
export const NODE_PROOF_LABEL = "_nport-node"

/** `nport.dev` → `_nport-node.nport.dev`, the TXT record the registry resolves. */
export function nodeProofRecordName(domain: string): string {
  return `${NODE_PROOF_LABEL}.${domain}`
}

/**
 * The TXT value that record must carry.
 *
 * Binds the proof to **one** node id, so a domain's owner authorises a specific listing rather than
 * any listing on their domain. Without the id, one published record would let anyone who noticed it
 * register further nodes claiming the same domain.
 */
export function nodeProofRecordValue(nodeId: string): string {
  return `nport-node=${nodeId}`
}

/**
 * Whether a TXT record set proves control of the domain for this node id.
 *
 * Takes the whole set because a name resolves to many TXT records and only one needs to match — a
 * domain already carrying SPF and verification records is the normal case, not the exception. Exact
 * comparison, not `includes`: a substring check would accept
 * `nport-node=someone-elses-id nport-node=mine`.
 */
export function nodeProofSatisfied(records: readonly string[], nodeId: string): boolean {
  const expected = nodeProofRecordValue(nodeId)
  // Resolvers vary on whether they hand back the surrounding quotes of a TXT record, and a trailing
  // newline survives a copy-paste into a DNS panel. Neither is the operator getting it wrong.
  return records.some((record) => record.trim().replaceAll('"', "") === expected)
}

/** Why a node registration was refused. Travels in `details.reason` on `REGISTRATION_REFUSED`. */
export const NODE_REJECTION_REASONS = [
  "invalid-node-id",
  "invalid-domain",
  "invalid-url",
  /** The TXT record is absent, or none of the records at that name match. */
  "proof-missing",
  /**
   * **No longer sent by any registry** (ADR-0049), and kept because removing it would be a breaking
   * contract change for a string clients already parse.
   *
   * It meant "the node's own `GET /v1/meta` did not answer", raised by a probe the registry made
   * during registration. Nothing probes now: a node checks its own public URL before it calls, so an
   * unreachable node does not register at all rather than registering and being refused. A client that
   * still handles this reason handles a case it will not see, which costs nothing; a client that
   * stopped handling it would break if a future registry found a reason to send it again.
   */
  "unreachable",
  /** The id is listed already, against a different domain. */
  "id-taken",
] as const

export type NodeRejectionReason = (typeof NODE_REJECTION_REASONS)[number]

/** Whether a string is a usable node id. Shape only — the registry decides whether it is free. */
export function isValidNodeId(id: string): boolean {
  return (
    id.length >= NODE_ID_MIN_LENGTH && id.length <= NODE_ID_MAX_LENGTH && NODE_ID_PATTERN.test(id)
  )
}
