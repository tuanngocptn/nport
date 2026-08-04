//! The traffic inspector: what went through the tunnel, kept locally and bounded.
//!
//! The desktop app's whole reason to exist beyond a GUI (ADR-0015): the native connector already
//! sees every request, so showing them costs almost nothing. **Almost.** Three constraints shape
//! everything here, and each of them is a rule someone would otherwise discover the hard way.
//!
//! 1. **It is optional, and off by default.** The CLI does not enable it and must not pay for it.
//!    That is why this is a sink the connector holds as an `Option` rather than a buffer it always
//!    fills — an inspector nobody reads is pure overhead on the hot path.
//! 2. **It is bounded.** A busy tunnel serves thousands of requests a minute, and an unbounded
//!    buffer eats memory until something dies. This is a ring: the oldest exchange is dropped to
//!    make room, and the count of what was dropped is kept so a UI can say so rather than silently
//!    showing a partial history.
//! 3. **Bodies are truncated, never stored whole.** A single file download would otherwise put a
//!    gigabyte in memory. [`MAX_BODY_PREVIEW`] is what a person can actually look at.
//!
//! ## Nothing here leaves the machine
//!
//! ADR-0015: no telemetry, no analytics, and **no tunnel traffic ever leaves the machine**. The
//! records below hold request and response bodies in plain form — that is the point of an inspector,
//! and it is exactly why they may never be sent anywhere, written to a crash report, or included in
//! a diagnostic bundle. The fact that we *can* see this traffic is a reason for care, not a licence.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use nport_contract::ErrorCode;

/// How much of one body is kept.
///
/// Enough to read a JSON payload or an HTML head; far short of a file download. A body larger than
/// this is recorded as truncated, with its real size intact — the size is often the interesting part
/// and it costs nothing to keep.
pub const MAX_BODY_PREVIEW: usize = 32 * 1024;

/// How many exchanges a default [`Inspector`] holds.
pub const DEFAULT_CAPACITY: usize = 1000;

/// The first bytes of a body, and how many there really were.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BodyPreview {
    /// Up to [`MAX_BODY_PREVIEW`] bytes. Not necessarily UTF-8 — a body can be anything.
    pub bytes: Vec<u8>,
    /// The full size, whether or not it was kept.
    pub total: u64,
}

impl BodyPreview {
    /// Whether bytes were dropped. A UI showing a preview without saying so is lying quietly.
    #[must_use]
    pub fn truncated(&self) -> bool {
        self.total > self.bytes.len() as u64
    }

    /// Records bytes that passed through, keeping at most `limit` of them.
    ///
    /// `limit` is zero when no inspector is attached, which makes this a counter and nothing else —
    /// the cheap path the CLI takes.
    pub fn push(&mut self, bytes: &[u8], limit: usize) {
        self.total += bytes.len() as u64;
        let room = limit.saturating_sub(self.bytes.len());
        if room > 0 {
            self.bytes
                .extend_from_slice(&bytes[..room.min(bytes.len())]);
        }
    }
}

/// Which kind of exchange this was.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Kind {
    #[default]
    Http,
    /// Past the `101` the record's bodies are the raw frames of the pipe, in each direction.
    Websocket,
    /// Refused: NPort 3.0 exposes HTTP only (ADR-0020).
    Tcp,
}

/// One request and its response, as the connector saw them.
///
/// **This is the contract the desktop inspector's columns are built from** (`apps/desktop/CLAUDE.md`).
/// A field the UI needs is added here first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exchange {
    /// Assigned by the sink, monotonically. Zero until then.
    pub id: u64,
    /// When the request arrived. Wall-clock, because a UI has to render it.
    pub at: SystemTime,
    /// How long the whole exchange took, including the origin's own time.
    pub duration: Duration,
    pub kind: Kind,
    pub method: String,
    /// The full URL the edge asked for.
    pub url: String,
    pub request_headers: Vec<(String, String)>,
    pub request_body: BodyPreview,
    /// Absent when the exchange failed before the origin answered.
    pub status: Option<u16>,
    pub response_headers: Vec<(String, String)>,
    pub response_body: BodyPreview,
    /// Set when the exchange did not complete. Never prose — only `crates/cli` and the desktop app
    /// know the user's language.
    pub failure: Option<Failure>,
}

/// Why an exchange did not finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// One of the registry's codes, for the failures that have one.
    Code(ErrorCode),
    /// The stream ended mid-exchange: the client hung up, or the connection dropped under it.
    ///
    /// **Deliberately not a registry code.** The two codes that describe the tunnel — `TUNNEL_LOST`
    /// and `EDGE_CONNECT_FAILED` — both claim the connection is gone, which is usually false here;
    /// the tunnel is fine and one request was cut. `LOCAL_REQUEST_FAILED` would blame the user's
    /// server for something it did not do. Inventing a code to fill the gap means changing a
    /// contract that was frozen for good reasons (`docs/ERRORS.md`), and this is a line in a local
    /// inspector, not an error anyone has to act on.
    CutShort,
}

impl Default for Exchange {
    fn default() -> Self {
        Self {
            id: 0,
            at: SystemTime::now(),
            duration: Duration::ZERO,
            kind: Kind::Http,
            method: String::new(),
            url: String::new(),
            request_headers: Vec::new(),
            request_body: BodyPreview::default(),
            status: None,
            response_headers: Vec::new(),
            response_body: BodyPreview::default(),
            failure: None,
        }
    }
}

/// Somewhere completed exchanges go.
///
/// A trait rather than the concrete [`Inspector`] so the desktop app can forward straight to its
/// WebView without a second buffer, and so tests can assert what was recorded.
///
/// **Implementations must not block.** This is called on the connection's task, once per request,
/// with the exchange already assembled — a sink that takes a lock someone else holds across an
/// `await`, or does I/O, makes every tunnel slower for as long as it is attached.
pub trait Observer: Send + Sync + 'static {
    /// Records one finished exchange. The sink assigns [`Exchange::id`].
    fn record(&self, exchange: Exchange);
}

/// Assembles one [`Exchange`] as it happens, and hands it to the sink when it ends.
///
/// **Flushed on drop, deliberately.** An exchange can end four ways — cleanly, with an error, with
/// the stream cut, or with the task aborted at shutdown — and only the first two are `return`
/// statements someone would remember to instrument. Recording in `Drop` covers all four, and makes
/// "every exchange appears exactly once" a property of the type rather than of the caller's care.
///
/// With no sink attached this is a few stack fields and a no-op destructor: the body limit is zero,
/// so previews count bytes and keep none.
pub struct Recorder {
    sink: Option<std::sync::Arc<dyn Observer>>,
    exchange: Exchange,
    started: std::time::Instant,
}

impl Recorder {
    /// Starts recording. `None` means nothing is watching.
    #[must_use]
    pub fn new(sink: Option<std::sync::Arc<dyn Observer>>) -> Self {
        Self {
            sink,
            exchange: Exchange::default(),
            started: std::time::Instant::now(),
        }
    }

    /// How many body bytes to keep. Zero when no sink is attached.
    #[must_use]
    pub fn body_limit(&self) -> usize {
        if self.sink.is_some() {
            MAX_BODY_PREVIEW
        } else {
            0
        }
    }

    /// Records what the edge asked for.
    pub fn request(
        &mut self,
        kind: Kind,
        method: &str,
        url: &str,
        headers: impl Iterator<Item = (String, String)>,
    ) {
        self.exchange.kind = kind;
        self.exchange.method = method.to_owned();
        self.exchange.url = url.to_owned();
        // Only when someone is watching: a request can carry dozens of headers, and cloning them for
        // nobody is exactly the overhead the CLI must not pay.
        if self.sink.is_some() {
            self.exchange.request_headers = headers.collect();
        }
    }

    /// Records what the origin answered.
    pub fn response(&mut self, status: u16, headers: &[(String, String)]) {
        self.exchange.status = Some(status);
        if self.sink.is_some() {
            self.exchange.response_headers = headers.to_vec();
        }
    }

    /// Records why the exchange did not finish.
    pub fn failed(&mut self, failure: Failure) {
        self.exchange.failure = Some(failure);
    }

    /// The request body's preview, to be filled as bytes pass.
    pub fn request_body(&mut self) -> &mut BodyPreview {
        &mut self.exchange.request_body
    }

    /// The response body's preview, to be filled as bytes pass.
    pub fn response_body(&mut self) -> &mut BodyPreview {
        &mut self.exchange.response_body
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let Some(sink) = self.sink.take() else {
            return;
        };
        let mut exchange = std::mem::take(&mut self.exchange);
        exchange.duration = self.started.elapsed();
        sink.record(exchange);
    }
}

/// A bounded, in-memory ring of recent exchanges.
#[derive(Debug)]
pub struct Inspector {
    capacity: usize,
    exchanges: Mutex<VecDeque<Exchange>>,
    next_id: AtomicU64,
    dropped: AtomicU64,
}

impl Inspector {
    /// A ring holding `capacity` exchanges. A capacity of zero records nothing but still counts.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            exchanges: Mutex::new(VecDeque::with_capacity(capacity.min(64))),
            next_id: AtomicU64::new(1),
            dropped: AtomicU64::new(0),
        }
    }

    /// Everything still held, oldest first.
    #[must_use]
    pub fn recent(&self) -> Vec<Exchange> {
        self.exchanges
            .lock()
            .expect("inspector lock poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// How many exchanges are held right now.
    #[must_use]
    pub fn len(&self) -> usize {
        self.exchanges
            .lock()
            .expect("inspector lock poisoned")
            .len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// How many were pushed out by newer ones.
    ///
    /// Surfaced rather than silent: a UI showing 1000 rows of a tunnel that served 50000 requests
    /// should say so, or someone will conclude the other 49000 never happened.
    #[must_use]
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Empties the ring. Ids keep counting — they identify an exchange, not a row.
    pub fn clear(&self) {
        self.exchanges
            .lock()
            .expect("inspector lock poisoned")
            .clear();
    }
}

impl Default for Inspector {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl Observer for Inspector {
    fn record(&self, mut exchange: Exchange) {
        exchange.id = self.next_id.fetch_add(1, Ordering::Relaxed);

        if self.capacity == 0 {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        let mut exchanges = self.exchanges.lock().expect("inspector lock poisoned");
        while exchanges.len() >= self.capacity {
            exchanges.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        exchanges.push_back(exchange);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn exchange(url: &str) -> Exchange {
        Exchange {
            method: "GET".to_owned(),
            url: url.to_owned(),
            ..Exchange::default()
        }
    }

    #[test]
    fn the_oldest_exchange_is_dropped_to_make_room() {
        // Unbounded is the failure this exists to prevent: a tunnel serving thousands of requests a
        // minute would eat memory until something died.
        let inspector = Inspector::new(2);
        for url in ["/a", "/b", "/c"] {
            inspector.record(exchange(url));
        }

        let held: Vec<String> = inspector.recent().into_iter().map(|e| e.url).collect();
        assert_eq!(held, vec!["/b".to_owned(), "/c".to_owned()]);
        assert_eq!(inspector.dropped(), 1);
    }

    #[test]
    fn ids_are_assigned_by_the_sink_and_keep_counting() {
        // The id identifies an exchange, not a row: a UI that reuses one after a `clear` would show
        // stale detail for a new request.
        let inspector = Inspector::new(8);
        inspector.record(exchange("/a"));
        inspector.record(exchange("/b"));
        inspector.clear();
        inspector.record(exchange("/c"));

        let ids: Vec<u64> = inspector.recent().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![3]);
    }

    #[test]
    fn a_preview_stops_at_the_limit_but_the_size_does_not() {
        // The size is often the interesting part — "why is this response 40 MB?" — and keeping it
        // costs nothing.
        let mut preview = BodyPreview::default();
        preview.push(b"hello ", 8);
        preview.push(b"world", 8);

        assert_eq!(preview.bytes, b"hello wo");
        assert_eq!(preview.total, 11);
        assert!(preview.truncated());
    }

    #[test]
    fn a_zero_limit_counts_without_keeping_anything() {
        // The CLI's path. No inspector is attached, so bytes are counted and immediately forgotten.
        let mut preview = BodyPreview::default();
        preview.push(b"never kept", 0);

        assert!(preview.bytes.is_empty());
        assert_eq!(preview.total, 10);
        assert!(preview.truncated());
    }

    #[test]
    fn an_exact_fit_is_not_reported_as_truncated() {
        let mut preview = BodyPreview::default();
        preview.push(b"12345", 5);
        assert!(!preview.truncated());
    }

    #[test]
    fn an_exchange_is_recorded_even_when_nothing_says_it_finished() {
        // The reason recording lives in `Drop`: an exchange ends four ways — cleanly, with an error,
        // with the stream cut, and with the task aborted at shutdown — and only the first two are
        // `return` statements someone would remember to instrument.
        let inspector = Arc::new(Inspector::new(4));
        {
            let mut recorder = Recorder::new(Some(Arc::clone(&inspector) as Arc<dyn Observer>));
            recorder.request(Kind::Http, "GET", "https://x/", std::iter::empty());
            recorder.failed(Failure::CutShort);
            // No explicit flush, and no clean ending. Dropped mid-exchange, as an aborted task
            // would be.
        }

        let recorded = inspector.recent();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "GET");
        assert_eq!(recorded[0].failure, Some(Failure::CutShort));
    }

    #[test]
    fn nothing_is_kept_when_no_sink_is_attached() {
        // The CLI's path. The recorder still exists — the exchange code does not branch — but it
        // holds no headers and keeps no body bytes.
        let mut recorder = Recorder::new(None);
        assert_eq!(recorder.body_limit(), 0);
        recorder.request(
            Kind::Http,
            "POST",
            "https://x/",
            std::iter::once(("cookie".to_owned(), "secret".to_owned())),
        );
        let limit = recorder.body_limit();
        recorder.request_body().push(b"payload", limit);

        assert!(recorder.exchange.request_headers.is_empty());
        assert!(recorder.exchange.request_body.bytes.is_empty());
        assert_eq!(recorder.exchange.request_body.total, 7);
    }

    #[test]
    fn a_sink_can_be_something_other_than_the_ring() {
        // The reason `Observer` is a trait: the desktop app forwards to its WebView rather than
        // keeping a second copy of everything.
        #[derive(Default)]
        struct Counting(AtomicU64);
        impl Observer for Counting {
            fn record(&self, _exchange: Exchange) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }

        let sink: Arc<dyn Observer> = Arc::new(Counting::default());
        sink.record(exchange("/a"));
        sink.record(exchange("/b"));

        // Downcasting is not the point; that it compiles and runs behind `Arc<dyn Observer>` is.
        assert_eq!(Arc::strong_count(&sink), 1);
    }
}
