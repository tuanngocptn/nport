/**
 * Subdomain normalization and validation.
 *
 * `docs/ARCHITECTURE.md` §7. **Mirrored in Rust** so the CLI can reject a bad name instantly
 * instead of spending a round trip on it, and both implementations run against
 * `fixtures/subdomains.json` so they cannot drift.
 *
 * v2 had no validation at all and interpolated the raw value into hostnames and into Cloudflare
 * API query strings unencoded, so `a.b.c`, `*`, and values containing `&` or `#` all passed.
 * That is the bug class this file exists to close, which is why every rule below has a test
 * naming the input it rejects.
 */

/** Length bounds. 63 is the DNS label limit; 3 is ours, to keep the namespace sane. */
export const MIN_LENGTH = 3
export const MAX_LENGTH = 63

/**
 * The zone every tunnel lives under. Stripped during normalization so pasting a whole URL
 * works — people copy `myapp.nport.link` out of their terminal and expect it to mean `myapp`.
 */
export const ZONE_SUFFIX = ".nport.link"

/**
 * A valid DNS label, lowercase only: starts and ends alphanumeric, hyphens allowed inside.
 *
 * Anchored, and deliberately not using `\w` — that would admit `_`, which is legal in some DNS
 * contexts but not in a hostname a browser will accept.
 */
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/

/**
 * Names nobody may claim.
 *
 * v2 reserved exactly `['api']`, which left `www`, `admin`, `mail`, and `_dmarc` claimable —
 * meaning an anonymous caller could take a name that receives our mail or answers our ACME
 * challenges. Grouped by why, because the groups have different review rules: infrastructure is
 * load-bearing, product is ours to hand out later, and the phishing set is judgement.
 *
 * **Shared with the reconciliation sweeper**, so cleanup can never delete a reserved record.
 */
export const RESERVED_SUBDOMAINS: readonly string[] = [
  // Infrastructure — breaking these breaks mail, TLS issuance, or the API itself.
  "api",
  "www",
  "mail",
  "smtp",
  "imap",
  "pop",
  "ns",
  "ns1",
  "ns2",
  "mx",
  "_acme-challenge",
  "_dmarc",
  "_domainkey",
  // Product surface — ours to use, and confusing in a stranger's hands.
  "app",
  "docs",
  "doc",
  "blog",
  "status",
  "cdn",
  "assets",
  "static",
  "admin",
  "dashboard",
  "staging",
  "dev",
  "test",
  "demo",
  "beta",
  "help",
  "support",
  "nport",
  // Phishing-prone — a tunnel named `login.nport.link` is a credential-harvesting page with our
  // domain's reputation behind it.
  "login",
  "signin",
  "signup",
  "logout",
  "secure",
  "verify",
  "verification",
  "account",
  "accounts",
  "billing",
  "payment",
  "payments",
  "invoice",
  "paypal",
  "stripe",
  "wallet",
  "bank",
  "auth",
  "oauth",
  "sso",
  "password",
  "reset",
]

/**
 * Prefixes nobody may claim.
 *
 * `smoke-` belongs to nightly CI, and `nport-` is the generated-name space — a user claiming
 * `nport-abc12345` could collide with a name we hand out.
 *
 * `_` is here for [`isReserved`] alone. No `_`-prefixed name can pass [`validateSubdomain`],
 * since the pattern excludes underscores — but the reconciliation sweeper reads names out of DNS
 * records rather than from user input, and `_dmarc` and `_acme-challenge` records genuinely
 * exist in the zone. Omitting it would let cleanup delete our own mail and ACME records.
 *
 * `xn--` is deliberately **absent**: the positions-3-and-4 double-hyphen rule in
 * [`validateSubdomain`] already covers it and generalises to `ab--cd`, so listing it here would
 * be a second rule for the same input with a different rejection reason.
 */
export const RESERVED_PREFIXES: readonly string[] = ["smoke-", "nport-", "_"]

/** Why a name was rejected. Travels in `details.reason` so a client can say something useful. */
export type RejectionReason =
  | "empty"
  | "too-short"
  | "too-long"
  | "invalid-characters"
  | "leading-or-trailing-hyphen"
  | "double-hyphen-prefix"
  | "reserved"
  | "reserved-prefix"

export type SubdomainCheck =
  | { readonly ok: true; readonly subdomain: string }
  | { readonly ok: false; readonly reason: RejectionReason }

/**
 * Canonicalises a user-supplied name **before** validation and before use as a Durable Object
 * key.
 *
 * Order matters and is not arbitrary:
 *
 * 1. NFKC first, so a full-width `ａ` becomes `a` before anything measures length or matches a
 *    pattern. Doing it after would let a visually identical name past a rule.
 * 2. Lowercase after NFKC, since normalization can change case mapping.
 * 3. Strip the zone suffix last, once the string is already lowercase, so `MyApp.NPort.Link`
 *    reduces to `myapp` rather than missing the suffix on a case comparison.
 *
 * `MyApp`, `myapp`, and `myapp.nport.link` are therefore one claim, which is what makes the
 * lease key sound: normalizing after choosing the key would let two callers hold the same name.
 *
 * **The result is idempotent**, and there is a test for it. That is not a nicety: the lease key
 * is the normalized name, so if normalizing twice differed from normalizing once, two callers
 * could hold the same subdomain. The trailing-dot strip has to run *inside* the suffix loop for
 * this to hold — `myapp.nport.link.` is a legal FQDN, and stripping dots only at the end left it
 * as `myapp.nport.link`, a second normalization away from `myapp`.
 */
export function normalizeSubdomain(input: string): string {
  let value = input.trim().normalize("NFKC").toLowerCase()
  // A trailing dot is legal in a FQDN and meaningless here. Strip before *and* after each
  // suffix removal, since either can expose the other.
  value = value.replace(/\.+$/, "")
  while (value.endsWith(ZONE_SUFFIX)) {
    value = value.slice(0, -ZONE_SUFFIX.length).replace(/\.+$/, "")
  }
  return value
}

/**
 * Validates an already-normalized name.
 *
 * Returns the reason rather than a boolean: `INVALID_SUBDOMAIN` carries `details.reason`, and
 * "invalid" alone is a useless thing to tell someone who typed 64 characters.
 */
export function validateSubdomain(subdomain: string): SubdomainCheck {
  if (subdomain.length === 0) {
    return { ok: false, reason: "empty" }
  }
  if (subdomain.length < MIN_LENGTH) {
    return { ok: false, reason: "too-short" }
  }
  if (subdomain.length > MAX_LENGTH) {
    return { ok: false, reason: "too-long" }
  }
  // Checked before the pattern so the reason is specific: the pattern would reject a leading
  // hyphen as "invalid-characters", which is true but unhelpful.
  if (subdomain.startsWith("-") || subdomain.endsWith("-")) {
    return { ok: false, reason: "leading-or-trailing-hyphen" }
  }
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    return { ok: false, reason: "invalid-characters" }
  }
  // `xx--` at positions 3–4 is the shape of an IDN A-label (`xn--`) and of the reserved
  // "tagged" label space in RFC 5890. Browsers and registrars treat those specially, so a
  // tunnel named that way behaves unpredictably.
  if (subdomain.slice(2, 4) === "--") {
    return { ok: false, reason: "double-hyphen-prefix" }
  }
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return { ok: false, reason: "reserved" }
  }
  if (RESERVED_PREFIXES.some((prefix) => subdomain.startsWith(prefix))) {
    return { ok: false, reason: "reserved-prefix" }
  }
  return { ok: true, subdomain }
}

/** Normalize then validate — the only entry point callers should need. */
export function checkSubdomain(input: string): SubdomainCheck {
  return validateSubdomain(normalizeSubdomain(input))
}

/**
 * Whether a name is reserved, ignoring every other rule.
 *
 * The reconciliation sweeper needs exactly this and nothing else: before deleting an orphaned
 * DNS record it must confirm the name is not one of ours, and it does not care whether the name
 * would have passed length or charset validation.
 */
export function isReserved(subdomain: string): boolean {
  const normalized = normalizeSubdomain(subdomain)
  return (
    RESERVED_SUBDOMAINS.includes(normalized) ||
    RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
}
