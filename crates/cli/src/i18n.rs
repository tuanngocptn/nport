//! Languages, and the strings that go with them.
//!
//! **This crate is the only place in the repository that formats text for humans**, and this module
//! is the only place in this crate that decides what the words are. `crates/core` emits
//! `TunnelEvent`s carrying `ErrorCode`s and never a sentence, because a `message: String` down there
//! would be untranslatable by construction — which is exactly what v2 did, building chalk-coloured
//! English inside `Error.message` in its transport layer (defect R20).
//!
//! ## Detection order
//!
//! `--lang` → `NPORT_LANG` → config file → `LC_ALL` / `LC_MESSAGES` / `LANG` → `en`
//! (`crates/CLAUDE.md`, CLI rule 5). Explicit beats ambient, and the fallback is always English
//! rather than an error: an unrecognised locale is a reason to pick a default, not to refuse to run.

use std::fmt;

use nport_contract::ErrorCode;

/// The languages NPort speaks.
///
/// Adding one is a three-part change — this enum, the catalogue below, and the detection tests — and
/// `crates/CLAUDE.md` asks for an issue first, because a half-translated language is worse than an
/// English one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Lang {
    #[default]
    En,
    Vi,
    Es,
}

impl Lang {
    /// Parses a language tag: `vi`, `vi-VN`, `vi_VN.UTF-8` all mean Vietnamese.
    ///
    /// Returns `None` rather than defaulting, so a caller can tell "not specified" from "specified
    /// and not understood" — the detection chain needs that difference to keep looking.
    #[must_use]
    pub fn parse(tag: &str) -> Option<Self> {
        let primary = tag
            .split(['.', '@'])
            .next()
            .unwrap_or(tag)
            .split(['-', '_'])
            .next()
            .unwrap_or(tag)
            .trim()
            .to_ascii_lowercase();

        match primary.as_str() {
            "en" => Some(Self::En),
            "vi" => Some(Self::Vi),
            "es" => Some(Self::Es),
            _ => None,
        }
    }

    /// Resolves the language from every source, in the documented order.
    ///
    /// `env` is a lookup rather than a direct read so the tests can drive the whole chain without
    /// touching the process environment — which is global, and makes tests order-dependent.
    #[must_use]
    pub fn detect(
        flag: Option<&str>,
        configured: Option<&str>,
        env: impl Fn(&str) -> Option<String>,
    ) -> Self {
        // An explicit `--lang xx` that is not understood still falls through rather than failing:
        // being unable to read the interface is not a reason to refuse to open a tunnel.
        flag.and_then(Self::parse)
            .or_else(|| env("NPORT_LANG").as_deref().and_then(Self::parse))
            .or_else(|| configured.and_then(Self::parse))
            .or_else(|| {
                ["LC_ALL", "LC_MESSAGES", "LANG"]
                    .iter()
                    .find_map(|key| env(key).as_deref().and_then(Self::parse))
            })
            .unwrap_or_default()
    }
}

impl fmt::Display for Lang {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::En => "en",
            Self::Vi => "vi",
            Self::Es => "es",
        })
    }
}

/// Everything the CLI can say that is not an error code.
///
/// An enum rather than free-form strings so a missing translation is a non-exhaustive `match` — a
/// compile error — instead of an English sentence that quietly reaches a Vietnamese user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Message {
    Forwarding,
    Expires,
    ConnectionUp,
    ConnectionLost,
    Retrying,
    StopHint,
    ShuttingDown,
    Stopped,
    LeaseEnded,
    PressAgainToForce,
    SeeMore,
}

/// The word for `message` in `lang`.
#[must_use]
pub fn text(lang: Lang, message: Message) -> &'static str {
    use Message as M;
    match (lang, message) {
        (Lang::En, M::Forwarding) => "forwarding to",
        (Lang::En, M::Expires) => "expires",
        (Lang::En, M::ConnectionUp) => "connection up",
        (Lang::En, M::ConnectionLost) => "connection lost",
        (Lang::En, M::Retrying) => "retrying",
        (Lang::En, M::StopHint) => "press Ctrl+C to stop",
        (Lang::En, M::ShuttingDown) => "shutting down",
        (Lang::En, M::Stopped) => "stopped",
        (Lang::En, M::LeaseEnded) => "your tunnel's time is up",
        (Lang::En, M::PressAgainToForce) => "press Ctrl+C again to exit immediately",
        (Lang::En, M::SeeMore) => "more",

        (Lang::Vi, M::Forwarding) => "chuyển tiếp tới",
        (Lang::Vi, M::Expires) => "hết hạn",
        (Lang::Vi, M::ConnectionUp) => "kết nối đã sẵn sàng",
        (Lang::Vi, M::ConnectionLost) => "mất kết nối",
        (Lang::Vi, M::Retrying) => "đang thử lại",
        (Lang::Vi, M::StopHint) => "nhấn Ctrl+C để dừng",
        (Lang::Vi, M::ShuttingDown) => "đang tắt",
        (Lang::Vi, M::Stopped) => "đã dừng",
        (Lang::Vi, M::LeaseEnded) => "đường hầm của bạn đã hết thời gian",
        (Lang::Vi, M::PressAgainToForce) => "nhấn Ctrl+C lần nữa để thoát ngay",
        (Lang::Vi, M::SeeMore) => "chi tiết",

        (Lang::Es, M::Forwarding) => "reenviando a",
        (Lang::Es, M::Expires) => "caduca",
        (Lang::Es, M::ConnectionUp) => "conexión establecida",
        (Lang::Es, M::ConnectionLost) => "conexión perdida",
        (Lang::Es, M::Retrying) => "reintentando",
        (Lang::Es, M::StopHint) => "pulsa Ctrl+C para detener",
        (Lang::Es, M::ShuttingDown) => "cerrando",
        (Lang::Es, M::Stopped) => "detenido",
        (Lang::Es, M::LeaseEnded) => "se acabó el tiempo de tu túnel",
        (Lang::Es, M::PressAgainToForce) => "pulsa Ctrl+C otra vez para salir de inmediato",
        (Lang::Es, M::SeeMore) => "más",
    }
}

/// Codes deliberately left untranslated, with the reason each one is not a user's problem.
///
/// **This list is the rule, and a test enforces it in both directions**: everything here must have no
/// translation, and everything *not* here must have all three. Adding a code to the registry
/// therefore forces a decision rather than silently falling through — which is how six client-facing
/// codes ended up rendering as bare `[CODE]` lines, including the one every `pnpm dev` run produces.
/// Test-only, because production needs no list: the fallback triggers on `describe` returning
/// `None`, and this exists to say *which* `None`s are intentional.
#[cfg(test)]
pub const UNTRANSLATED: [ErrorCode; 6] = [
    // Server-side, and nothing a user can act on. `docs/ERRORS.md` is the right place for these.
    ErrorCode::Internal,
    ErrorCode::UpstreamCloudflareError,
    // A client bug if it ever reaches a user: the CLI solves proof of work itself, so a missing or
    // invalid solution means *nport* got it wrong, and a translated sentence would imply otherwise.
    ErrorCode::PowRequired,
    ErrorCode::PowInvalid,
    // Likewise. The CLI holds the `ownerToken` it was issued and sends the body the contract defines,
    // so these mean a bug here or a proxy rewriting requests — not something to phrase for a user.
    ErrorCode::InvalidOwnerToken,
    ErrorCode::InvalidRequest,
];

/// What to tell the user about an error code.
///
/// **Not every code is translated, and that is deliberate rather than unfinished** — see
/// [`UNTRANSLATED`] for the six and why each is excluded. Everything else a person running `nport` can
/// cause is here in all three languages. An untranslated code falls back to the code itself plus its
/// documentation URL, which is a worse experience than a sentence and a much better one than a guess —
/// and `docs/ERRORS.md` is generated, so the page behind that URL is always current in a way a
/// hand-written translation is not.
#[must_use]
pub fn describe(lang: Lang, code: ErrorCode) -> Option<&'static str> {
    use ErrorCode as E;
    Some(match (lang, code) {
        (Lang::En, E::SubdomainInUse) => "that name is taken — try another, or omit -s",
        (Lang::En, E::SubdomainReserved) => "that name is reserved",
        (Lang::En, E::InvalidSubdomain) => "that name is not a valid subdomain",
        (Lang::En, E::LocalPortClosed) => "nothing is listening on that port",
        (Lang::En, E::LocalPortInvalid) => "that is not a usable port",
        (Lang::En, E::LocalRequestFailed) => "your local server refused a request",
        (Lang::En, E::RateLimited) => "too many requests — wait a moment",
        (Lang::En, E::ConcurrencyLimit) => "you already have as many tunnels as are allowed",
        (Lang::En, E::CreateQuotaExceeded) => "you have created too many tunnels this hour",
        (Lang::En, E::CapacityExhausted) => "NPort is at capacity right now",
        (Lang::En, E::ClientTooOld) => "this version of nport is too old — please upgrade",
        (Lang::En, E::EdgeConnectFailed) => "could not reach Cloudflare's edge",
        (Lang::En, E::EdgeDiscoveryFailed) => "could not find Cloudflare's edge",
        (Lang::En, E::EdgeProtocolError) => {
            "Cloudflare's edge answered in a way nport did not understand — please upgrade, then report it"
        }
        (Lang::En, E::EdgeRegistrationRefused) => {
            "Cloudflare's edge refused this tunnel's credential — it may have expired or been revoked"
        }
        (Lang::En, E::TunnelLost) => "the tunnel connection was lost",
        (Lang::En, E::LeaseExpired) => "the tunnel's time is up",
        (Lang::En, E::ProvisionFailed) => "the tunnel could not be created",
        (Lang::En, E::DnsConflict) => "that name already points somewhere else — try another",
        (Lang::En, E::TunnelNotFound) => "that tunnel no longer exists",
        (Lang::En, E::ChallengeExpired) => "that took too long — nport will try again",
        (Lang::En, E::ShutdownTimeout) => "some requests were still in flight when time ran out",
        (Lang::En, E::ConfigUnreadable) => "~/.nport/config.toml could not be read",
        (Lang::En, E::ConfigUnwritable) => "~/.nport/config.toml could not be written",

        (Lang::Vi, E::SubdomainInUse) => "tên đó đã có người dùng — hãy thử tên khác, hoặc bỏ -s",
        (Lang::Vi, E::SubdomainReserved) => "tên đó được giữ riêng",
        (Lang::Vi, E::InvalidSubdomain) => "tên đó không phải là tên miền phụ hợp lệ",
        (Lang::Vi, E::LocalPortClosed) => "không có gì đang lắng nghe ở cổng đó",
        (Lang::Vi, E::LocalPortInvalid) => "đó không phải là cổng dùng được",
        (Lang::Vi, E::LocalRequestFailed) => "máy chủ nội bộ của bạn đã từ chối một yêu cầu",
        (Lang::Vi, E::RateLimited) => "quá nhiều yêu cầu — hãy đợi một lát",
        (Lang::Vi, E::ConcurrencyLimit) => "bạn đã dùng hết số đường hầm được phép",
        (Lang::Vi, E::CreateQuotaExceeded) => "bạn đã tạo quá nhiều đường hầm trong giờ này",
        (Lang::Vi, E::CapacityExhausted) => "NPort đang quá tải",
        (Lang::Vi, E::ClientTooOld) => "phiên bản nport này quá cũ — vui lòng nâng cấp",
        (Lang::Vi, E::EdgeConnectFailed) => "không kết nối được tới biên Cloudflare",
        (Lang::Vi, E::EdgeDiscoveryFailed) => "không tìm được biên Cloudflare",
        (Lang::Vi, E::EdgeProtocolError) => {
            "biên Cloudflare trả lời theo cách nport không hiểu — hãy nâng cấp, rồi báo lỗi"
        }
        (Lang::Vi, E::EdgeRegistrationRefused) => {
            "biên Cloudflare đã từ chối thông tin xác thực của đường hầm này — có thể nó đã hết hạn hoặc bị thu hồi"
        }
        (Lang::Vi, E::TunnelLost) => "đã mất kết nối đường hầm",
        (Lang::Vi, E::LeaseExpired) => "đường hầm đã hết thời gian",
        (Lang::Vi, E::ProvisionFailed) => "không tạo được đường hầm",
        (Lang::Vi, E::DnsConflict) => "tên đó đã trỏ tới nơi khác — hãy thử tên khác",
        (Lang::Vi, E::TunnelNotFound) => "đường hầm đó không còn tồn tại",
        (Lang::Vi, E::ChallengeExpired) => "việc đó mất quá nhiều thời gian — nport sẽ thử lại",
        (Lang::Vi, E::ShutdownTimeout) => "vẫn còn một số yêu cầu đang dở khi hết thời gian",
        (Lang::Vi, E::ConfigUnreadable) => "không đọc được ~/.nport/config.toml",
        (Lang::Vi, E::ConfigUnwritable) => "không ghi được ~/.nport/config.toml",

        (Lang::Es, E::SubdomainInUse) => "ese nombre ya está en uso — prueba otro, u omite -s",
        (Lang::Es, E::SubdomainReserved) => "ese nombre está reservado",
        (Lang::Es, E::InvalidSubdomain) => "ese nombre no es un subdominio válido",
        (Lang::Es, E::LocalPortClosed) => "no hay nada escuchando en ese puerto",
        (Lang::Es, E::LocalPortInvalid) => "ese puerto no se puede usar",
        (Lang::Es, E::LocalRequestFailed) => "tu servidor local rechazó una petición",
        (Lang::Es, E::RateLimited) => "demasiadas peticiones — espera un momento",
        (Lang::Es, E::ConcurrencyLimit) => "ya tienes tantos túneles como se permiten",
        (Lang::Es, E::CreateQuotaExceeded) => "has creado demasiados túneles esta hora",
        (Lang::Es, E::CapacityExhausted) => "NPort está al límite de capacidad",
        (Lang::Es, E::ClientTooOld) => "esta versión de nport es demasiado antigua — actualiza",
        (Lang::Es, E::EdgeConnectFailed) => "no se pudo contactar con el borde de Cloudflare",
        (Lang::Es, E::EdgeDiscoveryFailed) => "no se pudo encontrar el borde de Cloudflare",
        (Lang::Es, E::EdgeProtocolError) => {
            "el borde de Cloudflare respondió de un modo que nport no entiende — actualiza y repórtalo"
        }
        (Lang::Es, E::EdgeRegistrationRefused) => {
            "el borde de Cloudflare rechazó la credencial de este túnel — puede haber caducado o haber sido revocada"
        }
        (Lang::Es, E::TunnelLost) => "se perdió la conexión del túnel",
        (Lang::Es, E::LeaseExpired) => "se acabó el tiempo del túnel",
        (Lang::Es, E::ProvisionFailed) => "no se pudo crear el túnel",
        (Lang::Es, E::DnsConflict) => "ese nombre ya apunta a otro sitio — prueba otro",
        (Lang::Es, E::TunnelNotFound) => "ese túnel ya no existe",
        (Lang::Es, E::ChallengeExpired) => "eso tardó demasiado — nport lo intentará de nuevo",
        (Lang::Es, E::ShutdownTimeout) => {
            "algunas peticiones seguían en curso cuando se agotó el tiempo"
        }
        (Lang::Es, E::ConfigUnreadable) => "no se pudo leer ~/.nport/config.toml",
        (Lang::Es, E::ConfigUnwritable) => "no se pudo escribir ~/.nport/config.toml",

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every code a user can reach has a sentence, in every language.
    ///
    /// The gap this closes was real and unglamorous: `EDGE_REGISTRATION_REFUSED` — what the edge says
    /// when it refuses a credential, and the ending of every `pnpm dev` run — rendered as
    /// `0: [EDGE_REGISTRATION_REFUSED] — more: …` while its three sibling edge codes all had prose.
    #[test]
    fn every_user_facing_code_is_translated_everywhere() {
        for code in ErrorCode::ALL {
            if UNTRANSLATED.contains(&code) {
                continue;
            }
            for lang in [Lang::En, Lang::Vi, Lang::Es] {
                assert!(
                    describe(lang, code).is_some(),
                    "{code:?} has no {lang:?} sentence — translate it, or add it to UNTRANSLATED \
                     with the reason it is not a user's problem"
                );
            }
        }
    }

    /// And the exclusion list does not rot into a list of things that *are* translated.
    #[test]
    fn the_untranslated_list_says_what_is_true() {
        for code in UNTRANSLATED {
            for lang in [Lang::En, Lang::Vi, Lang::Es] {
                assert!(
                    describe(lang, code).is_none(),
                    "{code:?} is translated but still listed as UNTRANSLATED — remove it from the list"
                );
            }
        }
    }

    /// A sentence is a sentence, not a code wearing one.
    #[test]
    fn no_translation_smuggles_in_a_code() {
        // `docs/ERRORS.md` owns the code and the renderer appends it; a sentence repeating it would
        // print it twice, and one that *is* it would defeat translating at all.
        for code in ErrorCode::ALL {
            for lang in [Lang::En, Lang::Vi, Lang::Es] {
                if let Some(sentence) = describe(lang, code) {
                    assert!(
                        !sentence.contains(code.as_str()),
                        "{code:?} in {lang:?} repeats its own code: {sentence}"
                    );
                    assert!(!sentence.is_empty(), "{code:?} in {lang:?} is empty");
                }
            }
        }
    }

    /// A stand-in environment, so no test touches the real one.
    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn a_locale_is_read_down_to_its_language() {
        // What is actually in `LANG` on a real machine.
        assert_eq!(Lang::parse("vi_VN.UTF-8"), Some(Lang::Vi));
        assert_eq!(Lang::parse("es-ES"), Some(Lang::Es));
        assert_eq!(Lang::parse("en_GB.UTF-8@euro"), Some(Lang::En));
        assert_eq!(
            Lang::parse("de"),
            None,
            "unknown is not English, it is unknown"
        );
    }

    #[test]
    fn the_flag_beats_everything_else() {
        let detected = Lang::detect(
            Some("es"),
            Some("vi"),
            env(&[("NPORT_LANG", "vi"), ("LANG", "vi_VN.UTF-8")]),
        );
        assert_eq!(detected, Lang::Es);
    }

    #[test]
    fn the_documented_order_holds_all_the_way_down() {
        // NPORT_LANG over the config file, the config file over the ambient locale, and English when
        // nothing says otherwise.
        assert_eq!(
            Lang::detect(None, Some("es"), env(&[("NPORT_LANG", "vi")])),
            Lang::Vi
        );
        assert_eq!(
            Lang::detect(None, Some("es"), env(&[("LANG", "vi_VN.UTF-8")])),
            Lang::Es
        );
        assert_eq!(
            Lang::detect(
                None,
                None,
                env(&[("LC_ALL", "es_ES.UTF-8"), ("LANG", "vi_VN")])
            ),
            Lang::Es,
            "LC_ALL outranks LANG"
        );
        assert_eq!(Lang::detect(None, None, env(&[])), Lang::En);
    }

    #[test]
    fn an_unreadable_language_setting_does_not_stop_the_tunnel() {
        // Being unable to read the interface is a reason to fall back, never a reason to refuse to
        // open a tunnel — and `--lang klingon` is a typo, not an emergency.
        assert_eq!(Lang::detect(Some("klingon"), None, env(&[])), Lang::En);
        assert_eq!(
            Lang::detect(Some("klingon"), None, env(&[("LANG", "vi_VN")])),
            Lang::Vi,
            "an unusable flag keeps looking rather than short-circuiting to English"
        );
    }

    #[test]
    fn every_message_exists_in_every_language() {
        // The property the enum buys: a missing translation is a compile error, and this asserts the
        // catalogue is not quietly returning English for another language.
        let all = [
            Message::Forwarding,
            Message::Expires,
            Message::ConnectionUp,
            Message::ConnectionLost,
            Message::Retrying,
            Message::StopHint,
            Message::ShuttingDown,
            Message::Stopped,
            Message::LeaseEnded,
            Message::PressAgainToForce,
            Message::SeeMore,
        ];

        for message in all {
            for lang in [Lang::En, Lang::Vi, Lang::Es] {
                assert!(!text(lang, message).is_empty(), "{lang} {message:?}");
            }
            assert_ne!(
                text(Lang::En, message),
                text(Lang::Vi, message),
                "{message:?} is not translated into Vietnamese"
            );
        }
    }

    #[test]
    fn the_codes_a_user_can_cause_are_translated() {
        // The subset that matters: what someone running `nport` can actually produce and act on.
        // Everything else falls back to the code and its docs URL, which is honest rather than
        // guessed.
        for code in [
            ErrorCode::SubdomainInUse,
            ErrorCode::LocalPortClosed,
            ErrorCode::RateLimited,
            ErrorCode::EdgeProtocolError,
        ] {
            for lang in [Lang::En, Lang::Vi, Lang::Es] {
                assert!(describe(lang, code).is_some(), "{lang} {code}");
            }
        }
    }

    #[test]
    fn an_untranslated_code_is_absent_rather_than_english() {
        // `None` is what makes the caller fall back to the code plus its documentation URL. Silently
        // returning English here would hide the gap and ship it to a Vietnamese user.
        //
        // Uses a code from `UNTRANSLATED` on purpose. This test used to name `DnsConflict`, which was
        // an example of the gap rather than of the policy — and it quietly became wrong the moment
        // that code got the sentence it should always have had.
        assert_eq!(describe(Lang::Vi, ErrorCode::Internal), None);
    }
}
