//! Subdomain normalization and validation — the Rust half of
//! `packages/contract/src/subdomain.ts`.
//!
//! **Why this exists:** so `nport -s my_app` fails in a millisecond with `INVALID_SUBDOMAIN` and the
//! reason `invalid-characters`, instead of spending a proof-of-work solve and a round trip to be told
//! the same thing. `packages/contract/src/subdomain.ts` has claimed to be "mirrored in Rust" since
//! Phase 1.5 and was not (`docs/ROADMAP.md`, defect 34).
//!
//! **Hand-written, and only the logic.** Every constant it uses is generated into `generated.rs`
//! from `schema/subdomain.json`, so the 53 reserved names exist once. What is reimplemented is the
//! three rules — NFKC folding, the zone-suffix strip, and label validation — because emitting those
//! into another language would be a generator nobody should have to debug. `fixtures/subdomains.json`
//! is what keeps the two implementations from disagreeing: **both** test suites read it, and a new
//! case goes there first.
//!
//! **Three functions from the TypeScript side are deliberately absent**, rather than forgotten:
//! `checkSubdomainShape`, `isReserved` and `isProtectedFromCleanup`. The first serves the
//! `:subdomain` path parameter and the other two serve the reconciliation sweeper, all three of which
//! run in `apps/api` and have no caller here. Adding them would be untested surface — the fixtures
//! cover what this file does, and nothing would drive the rest.
//!
//! **The server stays authoritative** (invariant 3). This refuses early; it never decides. A name
//! this file accepts still has to survive `POST /v1/tunnels`, which normalizes again and owns the
//! reserved list at the moment of the claim.

use icu_normalizer::ComposingNormalizerBorrowed;

use crate::{
    MAX_SUBDOMAIN_INPUT_LENGTH, MAX_SUBDOMAIN_LENGTH, MIN_SUBDOMAIN_LENGTH, RESERVED_PREFIXES,
    RESERVED_SUBDOMAINS, ZONE_SUFFIX,
};

/// NFKC, with ICU's compiled data. `const`, so there is no initialisation to pay for or to race on.
const NFKC: ComposingNormalizerBorrowed<'static> = ComposingNormalizerBorrowed::new_nfkc();

/// Why a name was rejected.
///
/// The spellings in [`RejectionReason::as_str`] are the contract's: they are exactly what the server
/// puts in `details.reason`, so a locally refused name and a server-refused one render identically.
/// `a_reason_exists_for_every_spelling_the_contract_generates` pins the set against the generated
/// `REJECTION_REASONS`, which is what stops this enum from quietly falling behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RejectionReason {
    /// Nothing was supplied, or normalization consumed all of it.
    Empty,
    /// Shorter than [`MIN_SUBDOMAIN_LENGTH`].
    TooShort,
    /// Longer than [`MAX_SUBDOMAIN_LENGTH`], or the raw input was longer than
    /// [`MAX_SUBDOMAIN_INPUT_LENGTH`].
    TooLong,
    /// Something outside `a-z`, `0-9` and `-`.
    InvalidCharacters,
    /// A DNS label may not begin or end with a hyphen.
    LeadingOrTrailingHyphen,
    /// `xx--` at positions 3–4 is the IDN A-label and RFC 5890 tagged-label space.
    DoubleHyphenPrefix,
    /// On the reserved list.
    Reserved,
    /// Carries a reserved prefix.
    ReservedPrefix,
}

impl RejectionReason {
    /// The contract's spelling, as it appears in `details.reason`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooShort => "too-short",
            Self::TooLong => "too-long",
            Self::InvalidCharacters => "invalid-characters",
            Self::LeadingOrTrailingHyphen => "leading-or-trailing-hyphen",
            Self::DoubleHyphenPrefix => "double-hyphen-prefix",
            Self::Reserved => "reserved",
            Self::ReservedPrefix => "reserved-prefix",
        }
    }
}

impl std::fmt::Display for RejectionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Canonicalises a user-supplied name, exactly as the server will.
///
/// The order is the TypeScript side's and is not arbitrary: NFKC first, so a full-width `ａ` becomes
/// `a` before anything measures or matches it; lowercase second, since normalization can change case
/// mapping; the zone suffix last, once the string is already lowercase, so `MyApp.NPort.Link` reduces
/// to `myapp` rather than missing the suffix on a case comparison.
///
/// **The result is idempotent**, and a fixture-driven test asserts it. That is load-bearing rather
/// than tidy: the lease key is the normalized name, so if normalizing twice differed from normalizing
/// once, two callers could hold one subdomain.
///
/// Linear in the input's length. It reads as a different implementation from the TypeScript one,
/// which walks an index — and the reason is a language difference rather than a disagreement:
/// JavaScript's `slice` copies, so stripping k suffixes by re-slicing was O(n·k) and measured 12.5 s
/// on a 645 KiB input (`docs/ROADMAP.md`, defect 10). `strip_suffix` and `trim_end_matches` return
/// subslices, so the obvious spelling here is already the fast one.
#[must_use]
pub fn normalize_subdomain(input: &str) -> String {
    let folded = NFKC.normalize(input.trim()).to_lowercase();

    let mut value: &str = &folded;
    loop {
        // A trailing dot is legal in a FQDN and meaningless here. Trimmed before *and* after each
        // suffix removal, because either can expose the other: `myapp.nport.link.` needs the dot gone
        // to see the suffix, and `myapp.nport.link.nport.link` needs it again in between.
        value = value.trim_end_matches('.');
        match value.strip_suffix(ZONE_SUFFIX) {
            Some(shorter) => value = shorter,
            None => break,
        }
    }
    value.to_owned()
}

/// The shape rules alone: length, charset, hyphen placement. **No reserved-name check.**
///
/// Separate from [`validate_subdomain`] because claiming a name and referring to one are different
/// questions — a generated name is `nport-<base32>` and `nport-` is a reserved prefix, so the full
/// validator would reject every generated tunnel's own status and delete endpoints.
pub fn validate_subdomain_shape(subdomain: &str) -> Result<(), RejectionReason> {
    let length = wire_length(subdomain);
    if length == 0 {
        return Err(RejectionReason::Empty);
    }
    if length < MIN_SUBDOMAIN_LENGTH {
        return Err(RejectionReason::TooShort);
    }
    if length > MAX_SUBDOMAIN_LENGTH {
        return Err(RejectionReason::TooLong);
    }
    // Before the charset check, so the reason is specific: the pattern would call a leading hyphen
    // "invalid-characters", which is true and unhelpful.
    if subdomain.starts_with('-') || subdomain.ends_with('-') {
        return Err(RejectionReason::LeadingOrTrailingHyphen);
    }
    if !is_dns_label(subdomain) {
        return Err(RejectionReason::InvalidCharacters);
    }
    // `xx--` at positions 3–4 is the shape of an IDN A-label (`xn--`) and of RFC 5890's reserved
    // tagged-label space. Byte indexing is safe here because `is_dns_label` has already established
    // the string is ASCII.
    if subdomain.as_bytes().get(2..4) == Some(b"--") {
        return Err(RejectionReason::DoubleHyphenPrefix);
    }
    Ok(())
}

/// Validates an already-normalized name for a **claim**: shape, then reserved names and prefixes.
pub fn validate_subdomain(subdomain: &str) -> Result<(), RejectionReason> {
    validate_subdomain_shape(subdomain)?;
    if RESERVED_SUBDOMAINS.contains(&subdomain) {
        return Err(RejectionReason::Reserved);
    }
    if RESERVED_PREFIXES
        .iter()
        .any(|prefix| subdomain.starts_with(prefix))
    {
        return Err(RejectionReason::ReservedPrefix);
    }
    Ok(())
}

/// Normalize then validate — the entry point for a claim, and what the CLI calls.
///
/// Returns the normalized name on success. The CLI sends the user's **raw** input regardless: the
/// server normalizes it again, normalization is idempotent, and keeping one authority for the value
/// that becomes a lease key is worth more than saving the server the work.
pub fn check_subdomain(input: &str) -> Result<String, RejectionReason> {
    if wire_length(input) > MAX_SUBDOMAIN_INPUT_LENGTH {
        // Refused before normalization rather than after, and `too-long` is already the honest
        // reason: nothing this long can normalize to a legal name.
        return Err(RejectionReason::TooLong);
    }
    let normalized = normalize_subdomain(input);
    validate_subdomain(&normalized)?;
    Ok(normalized)
}

/// Length as the **server** counts it: UTF-16 code units, which is what JavaScript's
/// `String.length` returns.
///
/// Deliberately not `chars().count()`. Every length check here runs before the charset check, so a
/// non-ASCII input's length decides which *reason* it is refused with — and a client that reports a
/// different reason from the server for the same input is a mirror that does not mirror. The two
/// agree for anything that could ever be valid, since a legal name is ASCII and all three counts
/// coincide there; they part company on astral characters, where a surrogate pair is 2 to JavaScript
/// and 1 to `chars()`. `an_astral_input_is_refused_for_the_same_reason_as_on_the_server` is the case
/// that pins it.
fn wire_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$`, without a regex engine.
///
/// Written out rather than compiled because a regex crate for one anchored pattern is a dependency
/// this crate does not otherwise need. Note what the pattern implies and the length checks already
/// enforce: a *two*-character name matches nothing, since the optional group is at least three
/// characters wide.
fn is_dns_label(subdomain: &str) -> bool {
    let alnum = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    // Non-ASCII fails `alnum` at the first byte of the character, so comparing bytes is the same as
    // comparing characters and cannot split one.
    match subdomain.as_bytes() {
        [] => false,
        [only] => alnum(*only),
        [first, middle @ .., last] => {
            alnum(*first)
                && alnum(*last)
                && !middle.is_empty()
                && middle.len() <= MAX_SUBDOMAIN_LENGTH - 2
                && middle.iter().all(|byte| alnum(*byte) || *byte == b'-')
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NPORT_OWNED_PREFIXES, REJECTION_REASONS};

    /// The shared cases, read at compile time so editing the fixture rebuilds this test.
    const FIXTURES: &str = include_str!("../../../packages/contract/fixtures/subdomains.json");

    #[derive(serde::Deserialize)]
    struct Fixtures {
        normalize: Vec<NormalizeCase>,
        valid: Vec<ValidCase>,
        invalid: Vec<InvalidCase>,
    }

    #[derive(serde::Deserialize)]
    struct NormalizeCase {
        input: String,
        output: String,
        why: String,
    }

    #[derive(serde::Deserialize)]
    struct ValidCase {
        input: String,
        why: String,
    }

    #[derive(serde::Deserialize)]
    struct InvalidCase {
        input: String,
        reason: String,
        why: String,
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(FIXTURES).expect("the fixture file is valid JSON")
    }

    /// The whole point of the file: the same inputs, the same answers, in both languages.
    #[test]
    fn normalization_matches_the_shared_fixtures() {
        let cases = fixtures().normalize;
        assert!(!cases.is_empty(), "the fixture file has no normalize cases");
        for case in cases {
            assert_eq!(
                normalize_subdomain(&case.input),
                case.output,
                "{:?} ({})",
                case.input,
                case.why
            );
        }
    }

    #[test]
    fn every_valid_fixture_is_accepted() {
        for case in fixtures().valid {
            assert_eq!(
                check_subdomain(&case.input),
                Ok(case.input.clone()),
                "{:?} ({})",
                case.input,
                case.why
            );
        }
    }

    /// **The reason, not merely the refusal.** Matching only "it was rejected" would let this pass
    /// with the rules in the wrong order — and the order is what makes `-myapp` report a hyphen
    /// problem instead of a charset one.
    #[test]
    fn every_invalid_fixture_is_refused_for_the_documented_reason() {
        for case in fixtures().invalid {
            let reason = check_subdomain(&case.input).expect_err(&format!(
                "{:?} should be refused ({})",
                case.input, case.why
            ));
            assert_eq!(
                reason.as_str(),
                case.reason,
                "{:?} ({})",
                case.input,
                case.why
            );
        }
    }

    /// Idempotence, on every fixture input rather than on a chosen one.
    ///
    /// The lease key is the normalized name, so a second pass that differed would let two callers
    /// hold one subdomain. The trailing-dot strip running *inside* the suffix loop is what makes it
    /// hold; moving it out passes the case above and fails this one.
    #[test]
    fn normalizing_twice_is_normalizing_once() {
        let all = fixtures();
        let inputs = all
            .normalize
            .iter()
            .map(|case| case.input.clone())
            .chain(all.valid.iter().map(|case| case.input.clone()))
            .chain(all.invalid.iter().map(|case| case.input.clone()));
        for input in inputs {
            let once = normalize_subdomain(&input);
            assert_eq!(normalize_subdomain(&once), once, "{input:?}");
        }
    }

    /// The enum cannot fall behind the contract's set of reasons.
    ///
    /// Both directions, because either alone rots: a reason the contract adds must have a variant,
    /// and a variant must not invent a spelling the contract does not know.
    #[test]
    fn a_reason_exists_for_every_spelling_the_contract_generates() {
        let mine = [
            RejectionReason::Empty,
            RejectionReason::TooShort,
            RejectionReason::TooLong,
            RejectionReason::InvalidCharacters,
            RejectionReason::LeadingOrTrailingHyphen,
            RejectionReason::DoubleHyphenPrefix,
            RejectionReason::Reserved,
            RejectionReason::ReservedPrefix,
        ];
        for spelling in REJECTION_REASONS {
            assert!(
                mine.iter().any(|reason| reason.as_str() == spelling),
                "the contract carries `{spelling}` and this enum has no variant for it"
            );
        }
        for reason in mine {
            assert!(
                REJECTION_REASONS.contains(&reason.as_str()),
                "{reason:?} spells itself `{}`, which the contract does not define",
                reason.as_str()
            );
        }
    }

    /// A non-ASCII name is refused the same way here as on the server.
    ///
    /// `wire_length` counts UTF-16 code units for this reason alone. Two astral characters are 4 to
    /// JavaScript's `String.length` — past `MIN_LENGTH`, so the charset check is what refuses them —
    /// and 2 to `chars().count()`, which would refuse them as `too-short` instead. Both reject; only
    /// one agrees with the server, and disagreeing about *why* is how a "mirror" misleads someone
    /// reading two error messages side by side.
    #[test]
    fn an_astral_input_is_refused_for_the_same_reason_as_on_the_server() {
        assert_eq!(
            check_subdomain("🎉🎉"),
            Err(RejectionReason::InvalidCharacters)
        );
        // One astral character is 2 code units, still under the minimum in both counts.
        assert_eq!(check_subdomain("🎉"), Err(RejectionReason::TooShort));
    }

    /// The quadratic normalizer that defect 10 fixed, from the other language.
    ///
    /// Not a benchmark — a wall-clock bound would be the flaky assertion defect 24 is about. It
    /// asserts the answer on an input large enough that a quadratic implementation would not finish
    /// inside the suite.
    #[test]
    fn a_pathological_suffix_pile_still_normalizes() {
        let input = format!("a{}", ZONE_SUFFIX.repeat(60_000));
        assert_eq!(normalize_subdomain(&input), "a");
    }

    #[test]
    fn the_generated_lists_arrived_intact() {
        // A cheap guard on the pipeline rather than on the rules: if `schema/subdomain.json` were
        // missing a key, the emitter would fail, but an *empty* array would sail through and quietly
        // make every reserved name claimable.
        assert!(
            RESERVED_SUBDOMAINS.len() > 40,
            "the reserved list looks truncated: {}",
            RESERVED_SUBDOMAINS.len()
        );
        assert!(RESERVED_SUBDOMAINS.contains(&"api"));
        assert!(RESERVED_SUBDOMAINS.contains(&"paypal"));
        assert_eq!(RESERVED_PREFIXES.len(), 3);
        assert_eq!(NPORT_OWNED_PREFIXES.len(), 2);
        assert_eq!(REJECTION_REASONS.len(), 8);
    }

    /// The generated bounds are the ones the rules were written against.
    #[test]
    fn the_bounds_are_the_dns_label_limits() {
        assert_eq!(MIN_SUBDOMAIN_LENGTH, 3);
        assert_eq!(MAX_SUBDOMAIN_LENGTH, 63);
        assert_eq!(ZONE_SUFFIX, ".nport.link");
        // Room for the suffix pasted twice, which is what the headroom is for.
        assert!(MAX_SUBDOMAIN_INPUT_LENGTH > MAX_SUBDOMAIN_LENGTH + ZONE_SUFFIX.len());
    }
}
