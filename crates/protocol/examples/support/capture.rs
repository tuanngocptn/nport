//! Golden-fixture capture for the `spike` example.
//!
//! `docs/TESTING.md` § Golden byte fixtures. Set `NPORT_FIXTURE_DIR` and the spike records the
//! exact bytes the **edge** sent for each frame type it sees.
//!
//! Why this direction is capturable and the other is not: a `ConnectRequest` originates at
//! Cloudflare, so recording it from our own client still yields authentic edge bytes — arguably
//! better provenance than cloudflared, which would only be relaying them. The frames the
//! *client* sends (`ConnectResponse`, the registration call) must come from cloudflared, and
//! that needs a separate harness.
#![allow(dead_code)]

use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, ReadBuf};

/// Wraps a reader and keeps a copy of every byte pulled through it.
///
/// The point is capturing a frame's **exact** extent. Buffering "enough" bytes and guessing
/// where the message ends does not work — a Cap'n Proto message's length is only knowable by
/// decoding its segment table — and reading to end-of-stream would swallow the request body.
/// Teeing the real reader means the recorded length is by construction the length the decoder
/// consumed.
pub struct Tee<R> {
    inner: R,
    /// Every byte read so far.
    pub seen: Vec<u8>,
}

impl<R> Tee<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            seen: Vec::new(),
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for Tee<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) {
            this.seen.extend_from_slice(&buf.filled()[before..]);
        }
        result
    }
}

/// Metadata keys whose value is the client's own IP address.
///
/// The edge fills these in from the real connecting client, which during a capture is **the
/// person running the spike**. A fixture is a committed file in a public repository, so these
/// values must never reach disk.
///
/// cloudflared does not add them; Cloudflare's edge does, on the way in.
const IP_BEARING_HEADERS: [&str; 4] = [
    "HttpHeader:Cf-Connecting-Ip",
    "HttpHeader:X-Forwarded-For",
    "HttpHeader:True-Client-Ip",
    "HttpHeader:Cf-Connecting-Ipv6",
];

/// Overwrites client IP addresses in a captured frame, in place and **without changing its
/// length**.
///
/// Same-length substitution is what makes this safe to do to a golden fixture: every segment
/// offset, field pointer, and metadata count in the Cap'n Proto message stays exactly as the
/// edge produced it, and only the bytes of those values differ. A shorter placeholder would
/// mean re-encoding, and a re-encoded fixture is our encoder's output, not the edge's — which
/// is the one thing a golden fixture must not be.
///
/// The alternative — not committing the fixtures at all — was rejected: the regression net is
/// the entire point (`docs/TESTING.md`). Redaction is recorded in the fixtures README so no
/// future reader mistakes these twelve bytes for something the edge sent.
pub fn redact_client_ips(bytes: &mut [u8], metadata: &[(String, String)]) -> usize {
    let mut redacted = 0;
    for (key, value) in metadata {
        if !IP_BEARING_HEADERS
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
            || value.is_empty()
        {
            continue;
        }
        // Deterministic, obviously-not-an-address, and exactly as long as what it replaces.
        let mut replacement = b"REDACTED".to_vec();
        replacement.resize(value.len(), b'.');
        replacement.truncate(value.len());

        let needle = value.as_bytes();
        let mut from = 0;
        while let Some(offset) = bytes[from..]
            .windows(needle.len())
            .position(|window| window == needle)
        {
            let at = from + offset;
            bytes[at..at + needle.len()].copy_from_slice(&replacement);
            from = at + needle.len();
            redacted += 1;
        }
    }
    redacted
}

/// Writes a fixture, but **never overwrites one that already exists**.
///
/// A capture run that silently replaced a committed fixture would destroy the only record of
/// what the edge used to send, which is the entire value of the file. Re-capturing is therefore
/// a deliberate act: delete the file first.
pub fn record(dir: &str, name: &str, bytes: &[u8]) {
    let path = Path::new(dir).join(name);
    if path.exists() {
        println!("  = fixture {name} already exists, left alone");
        return;
    }
    if let Err(error) = std::fs::create_dir_all(dir) {
        println!("  ✗ could not create {dir}: {error}");
        return;
    }
    match std::fs::write(&path, bytes) {
        Ok(()) => println!("  + fixture {name} ({} bytes)", bytes.len()),
        Err(error) => println!("  ✗ could not write {name}: {error}"),
    }
}
