//! Rust mirror of the NPort API contract: request and response types, and the error-code enum.
//!
//! **Both services**, not just the control plane — the node API and the registry (ADR-0046) — because
//! `crates/core` is a client of both: it provisions against a node and discovers through the
//! registry. `Node` and `NodeListResponse` come from the registry's document, everything else from
//! the node's.
//!
//! Generated from `packages/contract` via the two service documents in `schema/`, plus
//! `schema/errors.json` and `schema/subdomain.json` (ADR-0009, ADR-0025). **`src/generated.rs` is
//! off-limits to hand edits** — it carries a `@generated` banner and CI fails on drift (invariant 6).
//! Change `packages/contract`, then run `pnpm codegen && cargo xtask codegen`.
//!
//! This file is the hand-written shell. It holds only what codegen cannot express: the error
//! envelope, which needs a typed [`ErrorCode`] where JSON Schema can only say "string".
//!
//! [`subdomain`] is hand-written for the same reason and is the other half of the contract the CLI
//! needs locally — normalization and validation, so `-s my_app` fails instantly instead of after a
//! round trip. Its *constants* are generated like everything else; only its rules are not.

#![forbid(unsafe_code)]

mod generated;

pub mod subdomain;

pub use generated::*;

use serde::{Deserialize, Serialize};

/// The single error envelope for every failure the API returns.
///
/// Hand-written rather than generated because `code` must be an [`ErrorCode`], not a `String`.
/// The whole point of the registry is that callers branch on a closed set (ADR-0018); a generated
/// `code: String` would hand every caller the same stringly-typed matching that v2 got wrong.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    /// The error itself. Nested to match the wire shape: `{"error": {...}}`.
    pub error: ApiError,
}

/// The body of an [`ErrorEnvelope`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    /// Stable code. Branch on this.
    pub code: ErrorCode,
    /// Human-readable and translated. **Never match on it.**
    pub message: String,
    /// Code-specific. Deliberately untyped: its shape depends on `code`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
    /// Quote this in a bug report.
    pub request_id: String,
    /// Where to read more.
    pub docs_url: String,
}

impl ApiError {
    /// The HTTP status this code maps to, if it is a server-side code.
    #[must_use]
    pub const fn http_status(&self) -> Option<u16> {
        self.code.http_status()
    }

    /// Whether retrying is worthwhile.
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        self.code.is_retryable()
    }

    /// A `details` value, if the code set one.
    #[must_use]
    pub fn detail(&self, key: &str) -> Option<&serde_json::Value> {
        self.details.as_ref()?.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_round_trips_through_its_wire_spelling() {
        // The claim the whole registry rests on: a code survives the trip to the wire and back
        // unchanged. If `parse` and `as_str` ever disagree, a client silently stops recognising
        // an error it is supposed to branch on.
        for code in ErrorCode::ALL {
            let wire = code.as_str();
            assert_eq!(
                ErrorCode::parse(wire),
                Some(code),
                "{wire} did not round-trip"
            );
        }
    }

    #[test]
    fn serde_uses_the_wire_spelling_not_the_variant_name() {
        let json = serde_json::to_string(&ErrorCode::SubdomainInUse).expect("serializes");
        assert_eq!(json, "\"SUBDOMAIN_IN_USE\"");
        let parsed: ErrorCode = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(parsed, ErrorCode::SubdomainInUse);
    }

    #[test]
    fn an_unknown_code_is_none_rather_than_a_guess() {
        assert_eq!(ErrorCode::parse("NOPE"), None);
        assert_eq!(ErrorCode::parse(""), None);
        assert_eq!(ErrorCode::parse("subdomain_in_use"), None, "case matters");
    }

    #[test]
    fn statuses_match_the_registry() {
        assert_eq!(ErrorCode::SubdomainInUse.http_status(), Some(409));
        assert_eq!(ErrorCode::ClientTooOld.http_status(), Some(426));
        assert_eq!(ErrorCode::CapacityExhausted.http_status(), Some(503));
        // Client-side codes never cross the network, so they have no status at all.
        assert_eq!(ErrorCode::LocalPortClosed.http_status(), None);
        assert_eq!(ErrorCode::EdgeProtocolError.http_status(), None);
    }

    #[test]
    fn retryability_matches_the_registry() {
        assert!(ErrorCode::RateLimited.is_retryable());
        assert!(ErrorCode::CapacityExhausted.is_retryable());
        assert!(!ErrorCode::SubdomainInUse.is_retryable());
        assert!(!ErrorCode::InvalidOwnerToken.is_retryable());
        // The one to watch: a protocol change is not something a retry fixes.
        assert!(!ErrorCode::EdgeProtocolError.is_retryable());
    }

    #[test]
    fn slugs_are_lowercase_and_hyphenated() {
        assert_eq!(ErrorCode::SubdomainInUse.slug(), "subdomain-in-use");
        assert_eq!(ErrorCode::Internal.slug(), "internal");
        for code in ErrorCode::ALL {
            let slug = code.slug();
            assert!(
                slug.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{slug} is not a URL-safe slug"
            );
        }
    }

    #[test]
    fn the_registry_has_the_expected_size() {
        // A bare count, so adding a code without regenerating the Rust side fails here rather
        // than at whatever call site happens to need the new variant first.
        assert_eq!(ErrorCode::ALL.len(), 33);
    }

    #[test]
    fn display_prints_the_wire_code() {
        assert_eq!(ErrorCode::DnsConflict.to_string(), "DNS_CONFLICT");
    }

    /// The registry's document reaches Rust, and its array of objects became a `Vec`.
    ///
    /// The emitter had no array support at all before federation, and the failure mode without it is
    /// not a compile error in this crate — it is `cargo xtask codegen` refusing, or worse, emitting
    /// something structural. This is the assertion that the whole `GET /v1/nodes` shape survives the
    /// trip, since `crates/core::discovery` will parse exactly this body.
    #[test]
    fn the_node_directory_parses_from_the_registrys_shape() {
        let json = r#"{
            "nodes": [
                {
                    "id": "hk1",
                    "url": "https://api.nport.link",
                    "domain": "nport.link",
                    "region": "apac",
                    "version": "3.0.0",
                    "status": "up",
                    "activeTunnels": 12,
                    "maxActiveTunnels": 100,
                    "lastSeenAt": 1767225600000
                },
                {
                    "id": "eu1",
                    "url": "https://api.nport.dev",
                    "domain": "nport.dev",
                    "version": "3.0.0",
                    "status": "down",
                    "lastSeenAt": 1767225600000
                }
            ],
            "refreshAfterMs": 300000
        }"#;

        let list: NodeListResponse = serde_json::from_str(json).expect("the registry's shape");

        assert_eq!(list.nodes.len(), 2);
        assert_eq!(list.refresh_after_ms, 300_000);

        let hk = &list.nodes[0];
        assert_eq!(hk.status, NodeStatus::Up);
        assert_eq!(hk.active_tunnels, Some(12));
        assert_eq!(hk.region.as_deref(), Some("apac"));
        // `lastSeenAt` → `last_seen_at` is where a rename_all mistake shows up, and it would show
        // up at runtime as a missing field rather than at compile time.
        assert_eq!(hk.last_seen_at, 1_767_225_600_000);

        // **Absent capacity is `None`, not zero.** A node that does not say is not a node that says
        // no — discovery treats unknown as usable, and a `0` default would make an older node look
        // empty and get picked first by everyone.
        let eu = &list.nodes[1];
        assert_eq!(eu.active_tunnels, None);
        assert_eq!(eu.max_active_tunnels, None);
        assert_eq!(eu.status, NodeStatus::Down);
    }

    /// The node status is a closed set, not a string.
    ///
    /// The same argument as `ErrorCode`: a `String` here would hand every caller stringly-typed
    /// matching, and `crates/core::discovery` branches on this to decide what to offer.
    #[test]
    fn an_unknown_node_status_is_a_parse_error() {
        let json = r#"{"id":"x","url":"https://x.test","domain":"x.test","version":"3.0.0",
                        "status":"healthy","lastSeenAt":1}"#;
        assert!(serde_json::from_str::<Node>(json).is_err());
    }

    /// `activeTunnels` on `/v1/meta` is optional in both directions.
    ///
    /// Additive to `contract-v1`: a node running an older build publishes neither field, and its
    /// `/v1/meta` still has to parse or discovery would delist it for the wrong reason.
    #[test]
    fn meta_parses_with_and_without_the_capacity_fields() {
        let without = r#"{"minClientVersion":"3.0.0","tunnelDurationMs":1,"heartbeatIntervalMs":1,
                          "powDifficulty":20,"maxConcurrentPerSource":3,
                          "maxCreatesPerHourPerSource":10}"#;
        let parsed: MetaResponse = serde_json::from_str(without).expect("an older node's meta");
        assert_eq!(parsed.active_tunnels, None);

        let with = r#"{"minClientVersion":"3.0.0","tunnelDurationMs":1,"heartbeatIntervalMs":1,
                       "powDifficulty":20,"maxConcurrentPerSource":3,
                       "maxCreatesPerHourPerSource":10,"activeTunnels":7,"maxActiveTunnels":100}"#;
        let parsed: MetaResponse = serde_json::from_str(with).expect("a current node's meta");
        assert_eq!(parsed.active_tunnels, Some(7));
        assert_eq!(parsed.max_active_tunnels, Some(100));
    }

    #[test]
    fn an_error_envelope_deserializes_from_the_documented_shape() {
        // Exactly the JSON in docs/ERRORS.md § Response shape. If the envelope and the doc ever
        // disagree, one of them is lying to every client author who reads it.
        let json = r#"{
            "error": {
                "code": "SUBDOMAIN_IN_USE",
                "message": "That subdomain is currently in use.",
                "details": { "expiresAt": 1767225600000 },
                "requestId": "abc123",
                "docsUrl": "https://nport.link/errors/subdomain-in-use"
            }
        }"#;
        let envelope: ErrorEnvelope = serde_json::from_str(json).expect("the documented shape");

        assert_eq!(envelope.error.code, ErrorCode::SubdomainInUse);
        assert_eq!(envelope.error.http_status(), Some(409));
        assert!(!envelope.error.is_retryable());
        assert_eq!(envelope.error.request_id, "abc123");
        assert_eq!(
            envelope.error.detail("expiresAt").and_then(|v| v.as_u64()),
            Some(1_767_225_600_000)
        );
    }

    #[test]
    fn an_envelope_without_details_still_parses() {
        // `details` is optional in the contract, and a required field here would reject most of
        // the registry's responses.
        let json = r#"{"error":{"code":"INTERNAL","message":"x","requestId":"r","docsUrl":"u"}}"#;
        let envelope: ErrorEnvelope = serde_json::from_str(json).expect("no details");
        assert!(envelope.error.details.is_none());
        assert_eq!(envelope.error.detail("anything"), None);
    }

    #[test]
    fn an_unknown_code_on_the_wire_is_a_parse_error_not_a_silent_default() {
        // Better to fail loudly: a client that mapped an unrecognised code onto some default
        // would take the wrong recovery action with no way to notice.
        let json =
            r#"{"error":{"code":"FROM_THE_FUTURE","message":"x","requestId":"r","docsUrl":"u"}}"#;
        assert!(serde_json::from_str::<ErrorEnvelope>(json).is_err());
    }

    #[test]
    fn generated_request_types_use_camel_case_on_the_wire() {
        let request = CreateTunnelRequest {
            subdomain: Some("myapp".to_owned()),
            challenge: "c".to_owned(),
            nonce: "n".to_owned(),
            client: ClientKind::Cli,
        };
        let json = serde_json::to_string(&request).expect("serializes");
        assert!(json.contains("\"subdomain\":\"myapp\""), "{json}");
        assert!(json.contains("\"client\":\"cli\""), "{json}");
    }

    #[test]
    fn generated_response_types_parse_camel_case_fields() {
        // `expiresAt` → `expires_at` is where a rename_all mistake would show up, and it would
        // show up as a missing-field error at runtime rather than at compile time.
        let json = r#"{
            "subdomain":"myapp",
            "url":"https://myapp.nport.link",
            "tunnelId":"11111111-2222-3333-4444-555555555555",
            "tunnelToken":"t",
            "ownerToken":"o",
            "expiresAt":1767225600000
        }"#;
        let response: CreateTunnelResponse = serde_json::from_str(json).expect("camelCase");
        assert_eq!(response.subdomain, "myapp");
        assert_eq!(response.expires_at, 1_767_225_600_000);
    }

    /// A credential must never reach a `Debug` output — including through a struct that merely holds
    /// one.
    ///
    /// `docs/conventions/rust.md` forbids deriving `Debug` on a struct with a secret in it, and the
    /// generated `tunnel_token` field's own doc comment says "Never logged". The generator emits a
    /// redacting impl instead, keyed on the field *name* so a credential added later is covered
    /// without anyone editing a list. This asserts the output rather than the generator, because the
    /// output is what a stray `{:?}` would actually print.
    #[test]
    fn a_debug_output_never_carries_a_credential() {
        let response = CreateTunnelResponse {
            expires_at: 1_767_225_600_000,
            owner_token: "owner-secret-do-not-print".to_owned(),
            subdomain: "myapp".to_owned(),
            tunnel_id: "1d2e3f40-0000-4000-8000-000000000000".to_owned(),
            tunnel_token: "connector-secret-do-not-print".to_owned(),
            url: "https://myapp.nport.link".to_owned(),
        };

        let rendered = format!("{response:?}");

        assert!(
            !rendered.contains("owner-secret-do-not-print"),
            "{rendered}"
        );
        assert!(
            !rendered.contains("connector-secret-do-not-print"),
            "{rendered}"
        );
        // The rest still has to be there, or the redaction has cost the debugging it exists to serve.
        assert!(rendered.contains("myapp"), "{rendered}");
        assert!(rendered.contains("1767225600000"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
    }

    #[test]
    fn the_request_types_redact_their_owner_token_too() {
        // `CreateTunnelResponse` is the obvious one; the two request types carry the same bearer proof
        // and would leak it just as readily.
        let delete = DeleteTunnelRequest {
            owner_token: "owner-secret-do-not-print".to_owned(),
        };
        let heartbeat = HeartbeatRequest {
            owner_token: "owner-secret-do-not-print".to_owned(),
        };

        for rendered in [format!("{delete:?}"), format!("{heartbeat:?}")] {
            assert!(
                !rendered.contains("owner-secret-do-not-print"),
                "{rendered}"
            );
            assert!(rendered.contains("redacted"), "{rendered}");
        }
    }
}
