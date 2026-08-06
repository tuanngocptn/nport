/**
 * Subdomain normalization and validation.
 *
 * `docs/ARCHITECTURE.md` §7. **Mirrored in Rust** — `crates/contract/src/subdomain.rs` — so the CLI
 * can reject a bad name instantly instead of spending a round trip on it. Two mechanisms keep the
 * halves honest, and the split between them is deliberate: every **constant** below is generated
 * into Rust through `schema/subdomain.json`, so a reserved name added here cannot be missing there;
 * every **rule** is reimplemented, and both implementations run against `fixtures/subdomains.json`.
 *
 * That claim was false for the whole of Phase 2: the mirror did not exist, and this file said it did
 * (`docs/ROADMAP.md`, defect 34). Adding a case to the fixtures is still the way to change either
 * side — but it is now a case two test suites read rather than one.
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
 * The longest **raw input** any entry point here will look at, before normalization.
 *
 * A normalized name is at most `MAX_LENGTH`, but input is not normalized yet: `.nport.link` is
 * stripped, so `myapp.nport.link` and a trailing dot or two are legal input for a 5-character
 * claim. The headroom covers that and a suffix pasted twice.
 *
 * **This is a resource bound, not a naming rule, and it belongs here rather than in each caller.**
 * `normalizeSubdomain` runs NFKC over its input and strips suffixes in a loop; both are cheap on a
 * name and neither is on a megabyte. `requestedSubdomainSchema` bounds the `/v1` path, but the v2
 * shim reads its own body — v2's request shape is not in the contract, so it cannot use the schema —
 * and it passed whatever arrived straight into normalization. A bound that only one of two callers
 * applies is a bound one caller forgot.
 */
export const MAX_INPUT_LENGTH = MAX_LENGTH + 32

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

/**
 * The prefixes on that list that mark a name as **NPort's own**, rather than as infrastructure.
 *
 * The deny list answers two different questions and only one of them is "may a stranger claim this".
 * The other is the sweeper's: *may cleanup delete the record behind this name?* For `api`, `www` and
 * `_dmarc` the answer is no — those records are load-bearing and deleting one is the failure the list
 * exists to prevent. For these two prefixes the answer is **yes, and it has to be**, because we are
 * the only one who ever creates them.
 *
 * Conflating the two questions cost the sweeper its commonest case. A generated name is
 * `nport-<base32>`, so its tunnel is `nport-nport-<base32>` and the subdomain the sweep extracts
 * begins with `nport-` — reserved, therefore skipped, therefore never reaped. Since a generated name
 * is what every `nport 3000` without `-s` gets, that was most orphans (ADR-0036).
 *
 * `docs/TESTING.md` had the rationale exactly backwards, which is what made it hard to see: it said
 * `smoke-` was reserved "so reconciliation can identify them", when reserving a prefix is precisely
 * what makes reconciliation leave it alone.
 */
export const NPORT_OWNED_PREFIXES: readonly string[] = ["smoke-", "nport-"]

/**
 * Why a name was rejected. Travels in `details.reason` so a client can say something useful.
 *
 * A value rather than a bare type union, because `pnpm codegen` has to enumerate these: the Rust
 * mirror's `RejectionReason` must spell them identically, and a TypeScript *type* cannot be read at
 * runtime. The type is derived from the array, so the two cannot drift.
 */
export const REJECTION_REASONS = [
  "empty",
  "too-short",
  "too-long",
  "invalid-characters",
  "leading-or-trailing-hyphen",
  "double-hyphen-prefix",
  "reserved",
  "reserved-prefix",
] as const

export type RejectionReason = (typeof REJECTION_REASONS)[number]

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
  const value = input.trim().normalize("NFKC").toLowerCase()

  // **Walked with an index rather than re-sliced, because slicing here was quadratic.** Each
  // `slice` copies the whole remaining string, so stripping k suffixes from an n-character input
  // cost O(n·k) — and since every suffix is 11 characters, k grows with n. `"a" + ".nport.link"
  // repeated` measured 4 ms at 11 KiB, 87 ms at 54 KiB, and **12.5 s at 645 KiB**: a single
  // request, on the shim that has no proof of work, ending a Worker invocation on CPU time.
  // Tracking the end instead makes the whole function linear, which is what it always looked like.
  let end = value.length
  // A trailing dot is legal in a FQDN and meaningless here. Stripped before *and* after each
  // suffix removal, since either can expose the other. 46 is `.`.
  const trimDots = (): void => {
    while (end > 0 && value.charCodeAt(end - 1) === 46) {
      end -= 1
    }
  }

  trimDots()
  // `startsWith` with an offset compares in place — no substring is created to throw away.
  while (end >= ZONE_SUFFIX.length && value.startsWith(ZONE_SUFFIX, end - ZONE_SUFFIX.length)) {
    end -= ZONE_SUFFIX.length
    trimDots()
  }
  return value.slice(0, end)
}

/**
 * The shape rules alone: length, charset, hyphen placement. **No reserved-name check.**
 *
 * Split out from [`validateSubdomain`] because claiming a name and *referring* to one are
 * different questions. A generated name is `nport-<base32>`, and `nport-` is a reserved prefix —
 * so `GET /v1/tunnels/nport-ab12cd34ef5gh` would be rejected by the full validator as
 * `reserved-prefix`, making every generated tunnel's own status, heartbeat, and delete endpoints
 * unreachable. Reserved-ness is a rule about what a stranger may *take*, not about what may be
 * looked up.
 *
 * This is still the guard that stops arbitrary junk becoming a Durable Object name, which is the
 * property that matters for a path parameter: an unbounded key space is an unbounded number of
 * objects. A reserved-but-well-formed name simply has no lease and answers `TUNNEL_NOT_FOUND`,
 * which leaks nothing.
 */
export function validateSubdomainShape(subdomain: string): SubdomainCheck {
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
  return { ok: true, subdomain }
}

/**
 * Validates an already-normalized name for a **claim**: shape, then reserved names and prefixes.
 *
 * Returns the reason rather than a boolean: `INVALID_SUBDOMAIN` carries `details.reason`, and
 * "invalid" alone is a useless thing to tell someone who typed 64 characters.
 */
export function validateSubdomain(subdomain: string): SubdomainCheck {
  const shape = validateSubdomainShape(subdomain)
  if (!shape.ok) {
    return shape
  }
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return { ok: false, reason: "reserved" }
  }
  if (RESERVED_PREFIXES.some((prefix) => subdomain.startsWith(prefix))) {
    return { ok: false, reason: "reserved-prefix" }
  }
  return { ok: true, subdomain }
}

/** Normalize then validate — the entry point for a **claim**. */
export function checkSubdomain(input: string): SubdomainCheck {
  if (input.length > MAX_INPUT_LENGTH) {
    // Refused before normalization, not after. `too-long` is already the honest reason, and no new
    // code is needed: anything this long cannot normalize to a legal name anyway.
    return { ok: false, reason: "too-long" }
  }
  return validateSubdomain(normalizeSubdomain(input))
}

/**
 * Normalize then shape-check — the entry point for a **reference** to an existing lease.
 *
 * Used by the `:subdomain` path parameter on status, heartbeat, and delete. See
 * [`validateSubdomainShape`] for why those cannot use [`checkSubdomain`].
 */
export function checkSubdomainShape(input: string): SubdomainCheck {
  if (input.length > MAX_INPUT_LENGTH) {
    return { ok: false, reason: "too-long" }
  }
  return validateSubdomainShape(normalizeSubdomain(input))
}

/**
 * Whether a name is reserved, ignoring every other rule.
 *
 * The claim-time question: *may a stranger take this?* Length and charset are somebody else's
 * problem, which is why this exists separately from [`validateSubdomain`].
 *
 * **Not the sweeper's question.** Cleanup wants [`isProtectedFromCleanup`] — see there for the
 * difference, and for the bug that came of treating them as one.
 */
export function isReserved(subdomain: string): boolean {
  if (subdomain.length > MAX_INPUT_LENGTH) {
    // Nothing this long is one of our names, and the sweeper's input comes from Cloudflare rather
    // than from a request — but the bound is free and this is the third entry point.
    return false
  }
  const normalized = normalizeSubdomain(subdomain)
  return (
    RESERVED_SUBDOMAINS.includes(normalized) ||
    RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
}

/**
 * Whether cleanup must leave this name's DNS record alone.
 *
 * The reconciliation sweeper's question, and it is **narrower than [`isReserved`]**: a name can be
 * un-claimable and still be ours to delete. Reserved *names* — `api`, `www`, `_dmarc` — are
 * infrastructure, and deleting one is the failure `docs/ARCHITECTURE.md` §7's deny list exists to
 * prevent. The two NPort-owned prefixes are the opposite: nobody but us creates them, so an orphan
 * carrying one is exactly what the sweep is for (ADR-0036).
 *
 * Using `isReserved` here meant the sweep skipped every orphaned generated name — the default naming
 * for any `nport 3000` without `-s`, and therefore most orphans. Three tests in
 * `apps/api/test/reconcile.test.ts` pin both halves: `nport-` and `smoke-` are reaped, `api`,
 * `www` and `_dmarc` are not.
 */
export function isProtectedFromCleanup(subdomain: string): boolean {
  if (!isReserved(subdomain)) {
    return false
  }
  const normalized = normalizeSubdomain(subdomain)
  return !NPORT_OWNED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}
