//! Captured traffic on its way to the WebView.
//!
//! `docs/FEATURES.md` §5. `core::inspector` records every exchange through a tunnel into a bounded
//! ring; this is the half that gets it onto the screen — a sink per tunnel, and the shape the
//! Inspector screen reads.
//!
//! ## The one hard constraint
//!
//! `Observer::record` is called **on the connection's task, once per request**, and its docblock is
//! explicit: implementations must not block. A sink that took a contended lock or did I/O would make
//! every tunnel slower for as long as the window was open — the app's own gotcha about the inspector
//! changing `core`'s hot path.
//!
//! So `record` does the cheapest thing that can work: it converts and pushes into an **unbounded**
//! channel and returns. A separate task drains it and emits. Unbounded is the deliberate half —
//! a bounded channel would either block the connection task when full or drop exchanges silently,
//! and the ring in `core` is already the thing that bounds memory.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nport_core::inspector::{BodyPreview, Exchange, Failure, Kind, Observer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

/// The Tauri event name the Inspector screen listens on.
pub const EXCHANGE_EVENT: &str = "nport://exchange";

/// One captured exchange, with the tunnel it belongs to.
///
/// The envelope exists for the same reason [`crate::events::TunnelMessage`]'s does: an exchange
/// says nothing about which tunnel carried it, and the screen shows several at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeMessage {
    pub subdomain: String,
    pub exchange: UiExchange,
}

/// An [`Exchange`] in the shape the WebView reads.
///
/// Mirrored rather than serialized directly, for the reasons `events.rs` gives at length: `core`
/// should not grow a wire format, and `Duration` and `SystemTime` have no JSON representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiExchange {
    /// Monotonic per tunnel, assigned by the ring. The row's identity.
    pub id: u64,
    /// Epoch milliseconds. Wall-clock, because a list has to render a time.
    pub at: u64,
    pub duration_ms: u64,
    pub kind: UiKind,
    pub method: String,
    pub url: String,
    /// Absent when the exchange failed before the origin answered.
    pub status: Option<u16>,
    pub request_headers: Vec<Header>,
    pub response_headers: Vec<Header>,
    pub request_body: UiBody,
    pub response_body: UiBody,
    /// A registry code, or `streamEnded` for the one failure that deliberately has none.
    pub failure: Option<String>,
}

/// A header, as a pair the frontend can render without inventing a key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UiKind {
    Http,
    Websocket,
    Tcp,
}

/// The first bytes of a body, and how many there really were.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiBody {
    /// Lossy UTF-8 of what was kept.
    ///
    /// **Lossy on purpose.** A body can be anything — a PNG, a gzip stream — and refusing to send
    /// what is not UTF-8 would blank the pane for exactly the requests somebody is debugging. The
    /// replacement characters are visible, which is the honest rendering of "these bytes are not
    /// text"; `truncated` and `total` say the rest.
    pub text: String,
    /// The full size, whether or not it was kept.
    pub total: u64,
    /// Whether bytes were dropped. A preview that did not say so would be lying quietly.
    pub truncated: bool,
}

impl UiExchange {
    /// Converts one recorded exchange.
    #[must_use]
    pub fn from_core(exchange: &Exchange) -> Self {
        Self {
            id: exchange.id,
            at: epoch_ms(exchange.at),
            duration_ms: duration_ms(exchange.duration),
            kind: match exchange.kind {
                Kind::Http => UiKind::Http,
                Kind::Websocket => UiKind::Websocket,
                Kind::Tcp => UiKind::Tcp,
            },
            method: exchange.method.clone(),
            url: exchange.url.clone(),
            status: exchange.status,
            request_headers: headers(&exchange.request_headers),
            response_headers: headers(&exchange.response_headers),
            request_body: body(&exchange.request_body),
            response_body: body(&exchange.response_body),
            failure: exchange.failure.as_ref().map(failure),
        }
    }
}

fn headers(pairs: &[(String, String)]) -> Vec<Header> {
    pairs
        .iter()
        .map(|(name, value)| Header {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

fn body(preview: &BodyPreview) -> UiBody {
    UiBody {
        text: String::from_utf8_lossy(&preview.bytes).into_owned(),
        total: preview.total,
        truncated: preview.truncated(),
    }
}

/// A failure as a string the frontend can key on.
///
/// Registry codes keep their spelling — `LOCAL_REQUEST_FAILED` — so the same catalogue that
/// translates a tunnel error translates this one. `streamEnded` is deliberately not a code:
/// `core`'s own docblock explains that none of the three candidates is true, and inventing one
/// would change a frozen contract for a line in a local inspector.
fn failure(failure: &Failure) -> String {
    match failure {
        Failure::Code(code) => serde_json::to_value(code)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "INTERNAL".to_owned()),
        _ => "streamEnded".to_owned(),
    }
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// The sink one tunnel records into.
///
/// Holds only a channel sender, which is what keeps `record` as cheap as its contract demands.
pub struct Sink {
    exchanges: UnboundedSender<UiExchange>,
}

impl Sink {
    /// Builds a sink and starts the task that forwards what it records.
    ///
    /// **The subdomain is supplied afterwards**, through the returned sender, because of an ordering
    /// that cannot be avoided: `Tunnel::start` needs the sink, and the claimed name — normalized, or
    /// generated by the server — is not known until it returns. The forwarding task awaits the name
    /// before emitting anything, and the channel is unbounded, so an exchange captured in that
    /// window is queued rather than lost. In practice there are none: nothing reaches the origin
    /// until the tunnel is serving.
    ///
    /// The task ends when the sink is dropped — which happens when the `Tunnel` holding it drops, so
    /// it has the same defined shutdown path the event pump does and needs no cancellation. If the
    /// name never arrives, the task ends when the sender is dropped rather than waiting forever.
    #[must_use]
    pub fn spawn(app: AppHandle) -> (Self, tokio::sync::oneshot::Sender<String>) {
        let (exchanges, mut received) = unbounded_channel::<UiExchange>();
        let (name, named) = tokio::sync::oneshot::channel::<String>();

        tauri::async_runtime::spawn(async move {
            let Ok(subdomain) = named.await else {
                return;
            };

            while let Some(exchange) = received.recv().await {
                // A failed emit means the window is gone, which no tunnel can act on.
                let _ = app.emit(
                    EXCHANGE_EVENT,
                    ExchangeMessage {
                        subdomain: subdomain.clone(),
                        exchange,
                    },
                );
            }
        });

        (Self { exchanges }, name)
    }
}

impl Observer for Sink {
    fn record(&self, exchange: Exchange) {
        // Converts and sends, and does neither lock nor I/O. A closed channel means the forwarding
        // task is gone, which is not a reason to fail a request.
        let _ = self.exchanges.send(UiExchange::from_core(&exchange));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Exchange {
        Exchange {
            id: 7,
            at: UNIX_EPOCH + Duration::from_millis(1_786_000_000_000),
            duration: Duration::from_millis(38),
            kind: Kind::Http,
            method: "POST".to_owned(),
            url: "https://myapp.nport.link/api/webhooks/stripe".to_owned(),
            request_headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            request_body: BodyPreview::default(),
            status: Some(200),
            response_headers: vec![("x-powered-by".to_owned(), "next.js".to_owned())],
            response_body: BodyPreview::default(),
            failure: None,
        }
    }

    /// The wire shape the Inspector screen is written against, pinned whole.
    ///
    /// Whole rather than field by field for the reason `events.rs` gives: the casing and the key
    /// names are the contract, and each has its own way of going quietly wrong.
    #[test]
    fn the_payload_is_camel_case() {
        let ui = UiExchange::from_core(&sample());
        let json = serde_json::to_string(&ui).expect("serialize");

        assert!(json.contains(r#""durationMs":38"#), "{json}");
        assert!(json.contains(r#""at":1786000000000"#), "{json}");
        assert!(json.contains(r#""kind":"http""#), "{json}");
        assert!(
            json.contains(r#""requestHeaders":[{"name":"content-type""#),
            "{json}"
        );
    }

    /// A body that is not UTF-8 still renders, because those are the requests people debug.
    #[test]
    fn a_body_that_is_not_text_is_lossy_rather_than_missing() {
        let mut exchange = sample();
        exchange.response_body.bytes = vec![0xff, 0xfe, b'h', b'i'];
        exchange.response_body.total = 4;

        let ui = UiExchange::from_core(&exchange);
        assert!(ui.response_body.text.contains("hi"));
        assert_eq!(ui.response_body.total, 4);
    }

    /// The size survives even when the bytes did not — it is often the interesting part.
    #[test]
    fn a_truncated_body_keeps_its_real_size_and_says_so() {
        let mut exchange = sample();
        exchange.response_body.bytes = vec![b'a'; 8];
        exchange.response_body.total = 9_000_000;

        let ui = UiExchange::from_core(&exchange);
        assert!(ui.response_body.truncated);
        assert_eq!(ui.response_body.total, 9_000_000);
    }

    /// A failure travels as its registry spelling, so one catalogue translates both it and a
    /// tunnel error.
    #[test]
    fn a_failure_code_keeps_its_registry_name() {
        let mut exchange = sample();
        exchange.status = None;
        exchange.failure = Some(Failure::Code(nport_contract::ErrorCode::LocalRequestFailed));

        let ui = UiExchange::from_core(&exchange);
        assert_eq!(ui.failure.as_deref(), Some("LOCAL_REQUEST_FAILED"));
    }
}
