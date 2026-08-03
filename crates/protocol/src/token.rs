//! Tunnel token parsing.
//!
//! `docs/PROTOCOL.md` §3. The token is standard padded base64 of a small JSON object,
//! and it is credential material for a Cloudflare resource: it must never be logged,
//! written to disk, or passed in argv. v2 passed it as a command-line argument, where
//! `ps` exposed it to every local user on the machine.
//!
//! Everything in this module exists to make that hard to get wrong: there is no
//! `Debug` derive, the secret lives in a `Zeroizing` buffer, and no error variant
//! carries any part of the input.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

/// Minimum decoded length of the tunnel secret.
///
/// cloudflared: `connection/connection.go` → `Credentials.Auth` requires a non-empty
/// secret; the API mints 32 bytes and `docs/PROTOCOL.md` §3 records ≥32 as the contract.
const MIN_SECRET_LEN: usize = 32;

/// Which regional edge the token selects.
///
/// cloudflared: `cmd/cloudflared/tunnel/subcommands.go` → `ParseToken`, field `e`.
/// It selects the SRV and region hostnames only and is **never sent in any RPC**.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Endpoint {
    /// The global edge. Absent or empty `e`.
    #[default]
    Global,
    /// FedRAMP edge. `e == "fed"`.
    Fed,
}

/// Errors from parsing a tunnel token.
///
/// No variant carries any part of the input, not even a length or an offset into the
/// decoded JSON — an error message is the easiest place for credential material to leak,
/// because errors get logged by definition. The cost is that a malformed token gives a
/// coarse diagnosis, which is the right trade for something that must never appear in a
/// log line.
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    /// The outer string is not standard padded base64.
    #[error("tunnel token is not valid base64")]
    Base64,
    /// The decoded bytes are not the expected JSON object.
    #[error("tunnel token is not the expected JSON object")]
    Json,
    /// Field `s` is not valid base64.
    #[error("tunnel token secret is not valid base64")]
    SecretBase64,
    /// Field `s` decoded to fewer than [`MIN_SECRET_LEN`] bytes.
    #[error("tunnel token secret is shorter than {MIN_SECRET_LEN} bytes")]
    SecretTooShort,
    /// Field `t` is not a UUID.
    #[error("tunnel token tunnel id is not a UUID")]
    TunnelId,
    /// Field `e` held something other than `""` or `"fed"`.
    ///
    /// Deliberately an error rather than a fallback to [`Endpoint::Global`]: `e` decides
    /// which edge we hand a credential to, so guessing is the wrong behaviour.
    #[error("tunnel token endpoint is not recognized")]
    UnknownEndpoint,
}

/// The JSON shape inside the base64.
///
/// `s` holds the secret in base64, so this struct zeroizes it on drop rather than
/// leaving a copy in whatever allocation serde used.
#[derive(Deserialize)]
struct RawToken {
    a: String,
    s: String,
    t: String,
    #[serde(default)]
    e: Option<String>,
}

impl Drop for RawToken {
    fn drop(&mut self) {
        self.s.zeroize();
    }
}

/// A parsed tunnel token.
///
/// Construct with [`TunnelToken::parse`]. There is deliberately no `Clone`: every copy
/// is another buffer to zeroize.
pub struct TunnelToken {
    account_tag: String,
    tunnel_secret: Zeroizing<Vec<u8>>,
    tunnel_id: Uuid,
    endpoint: Endpoint,
}

impl TunnelToken {
    /// Parses a token as returned by `POST /v1/tunnels`.
    pub fn parse(token: &str) -> Result<Self, TokenError> {
        // The decoded JSON contains the secret in base64, so it is zeroized on drop too.
        let json = Zeroizing::new(
            STANDARD
                .decode(token.trim())
                .map_err(|_| TokenError::Base64)?,
        );

        let mut raw: RawToken = serde_json::from_slice(&json).map_err(|_| TokenError::Json)?;

        let secret = Zeroizing::new(
            STANDARD
                .decode(raw.s.as_bytes())
                .map_err(|_| TokenError::SecretBase64)?,
        );
        if secret.len() < MIN_SECRET_LEN {
            return Err(TokenError::SecretTooShort);
        }

        let tunnel_id = Uuid::parse_str(&raw.t).map_err(|_| TokenError::TunnelId)?;

        let endpoint = match raw.e.as_deref() {
            None | Some("") => Endpoint::Global,
            Some(e) if e.eq_ignore_ascii_case("fed") => Endpoint::Fed,
            Some(_) => return Err(TokenError::UnknownEndpoint),
        };

        Ok(Self {
            account_tag: std::mem::take(&mut raw.a),
            tunnel_secret: secret,
            tunnel_id,
            endpoint,
        })
    }

    /// The account tag, sent as `TunnelAuth.accountTag` (`docs/PROTOCOL.md` §8).
    #[must_use]
    pub fn account_tag(&self) -> &str {
        &self.account_tag
    }

    /// The raw secret bytes, sent as `TunnelAuth.tunnelSecret` — **`Data`, not text.**
    #[must_use]
    pub fn tunnel_secret(&self) -> &[u8] {
        &self.tunnel_secret
    }

    /// The tunnel UUID. Sent as `tunnelId` in its **16 raw bytes**, not dashed.
    #[must_use]
    pub fn tunnel_id(&self) -> Uuid {
        self.tunnel_id
    }

    /// Which regional edge to discover. Never sent to the edge.
    #[must_use]
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
}

/// Redacts. The whole point of the type.
impl fmt::Debug for TunnelToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TunnelToken(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [0xAB; 32];
    const TUNNEL_ID: &str = "1b1cf0a5-4bd7-4a19-b1cc-3f6f8a7b0e5d";

    fn token_with(secret: &[u8], tunnel_id: &str, endpoint: Option<&str>) -> String {
        let mut json = format!(
            r#"{{"a":"deadbeefcafe","s":"{}","t":"{tunnel_id}""#,
            STANDARD.encode(secret)
        );
        if let Some(e) = endpoint {
            json.push_str(&format!(r#","e":"{e}""#));
        }
        json.push('}');
        STANDARD.encode(json)
    }

    fn valid() -> String {
        token_with(&SECRET, TUNNEL_ID, None)
    }

    #[test]
    fn parses_a_well_formed_token() {
        let token = TunnelToken::parse(&valid()).expect("should parse");
        assert_eq!(token.account_tag(), "deadbeefcafe");
        assert_eq!(token.tunnel_secret(), SECRET);
        assert_eq!(token.tunnel_id().to_string(), TUNNEL_ID);
        assert_eq!(token.endpoint(), Endpoint::Global);
    }

    #[test]
    fn tunnel_id_is_sixteen_raw_bytes() {
        // The wire form is `tunnelID[:]`, not the dashed string (docs/PROTOCOL.md §8).
        let token = TunnelToken::parse(&valid()).expect("should parse");
        assert_eq!(token.tunnel_id().as_bytes().len(), 16);
    }

    #[test]
    fn debug_never_leaks_the_secret() {
        let token = TunnelToken::parse(&valid()).expect("should parse");
        let rendered = format!("{token:?}");
        assert_eq!(rendered, "TunnelToken(<redacted>)");
        assert!(!rendered.contains(&STANDARD.encode(SECRET)));
        assert!(!rendered.contains("deadbeefcafe"));
    }

    #[test]
    fn error_messages_never_contain_the_input() {
        let cases = [
            "not base64 at all !!!",
            &STANDARD.encode("{}"),
            &token_with(b"tooshort", TUNNEL_ID, None),
            &token_with(&SECRET, "not-a-uuid", None),
            &token_with(&SECRET, TUNNEL_ID, Some("moon")),
        ];
        for case in cases {
            let err = TunnelToken::parse(case).expect_err("should reject");
            let rendered = err.to_string();
            assert!(
                !rendered.contains(case),
                "error message echoed the token: {rendered}"
            );
            assert!(
                !rendered.contains(&STANDARD.encode(SECRET)),
                "error message leaked the secret: {rendered}"
            );
        }
    }

    #[test]
    fn rejects_a_secret_below_the_minimum() {
        let err = TunnelToken::parse(&token_with(&[0u8; 31], TUNNEL_ID, None))
            .expect_err("31 bytes is too short");
        assert!(matches!(err, TokenError::SecretTooShort));
    }

    #[test]
    fn accepts_exactly_the_minimum_secret_length() {
        TunnelToken::parse(&token_with(&[0u8; MIN_SECRET_LEN], TUNNEL_ID, None))
            .expect("32 bytes is the documented minimum");
    }

    #[test]
    fn reads_the_fedramp_endpoint() {
        let token =
            TunnelToken::parse(&token_with(&SECRET, TUNNEL_ID, Some("fed"))).expect("should parse");
        assert_eq!(token.endpoint(), Endpoint::Fed);
    }

    #[test]
    fn treats_an_empty_endpoint_as_global() {
        let token =
            TunnelToken::parse(&token_with(&SECRET, TUNNEL_ID, Some(""))).expect("should parse");
        assert_eq!(token.endpoint(), Endpoint::Global);
    }

    #[test]
    fn rejects_an_unrecognized_endpoint_rather_than_guessing() {
        let err = TunnelToken::parse(&token_with(&SECRET, TUNNEL_ID, Some("mars")))
            .expect_err("unknown endpoints must not silently fall back");
        assert!(matches!(err, TokenError::UnknownEndpoint));
    }

    #[test]
    fn rejects_url_safe_base64() {
        // Upstream uses base64.StdEncoding — not URL-safe, not raw (docs/PROTOCOL.md §3).
        // A token containing `-` or `_` in place of `+` or `/` is not one we accept.
        let err = TunnelToken::parse("e30-_").expect_err("URL-safe alphabet must not parse");
        assert!(matches!(err, TokenError::Base64));
    }
}
