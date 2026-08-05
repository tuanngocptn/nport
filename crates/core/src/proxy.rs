//! The local origin's side of an exchange: what the user's own server said, in a form the edge
//! can carry.
//!
//! Everything here is about **HTTP/1.1 toward `localhost`**, not about Cloudflare's wire. That split
//! is the layering rule in `crates/CLAUDE.md` — `crates/protocol` "speaks the wire and nothing else",
//! and `crates/core` owns "provision → connect → proxy → teardown". The mirror image of this module,
//! turning a `ConnectRequest` into a request head, lives in `nport_protocol::connect` because *that*
//! mapping is protocol-defined (`docs/PROTOCOL.md` §7).
//!
//! ## Why this code exists at all, rather than a HTTP client crate
//!
//! It is deliberately small and will stay that way. The connector is a *proxy*: it must forward what
//! the origin actually said, byte for byte, including things a well-behaved client library would
//! normalise away. A general HTTP client would re-encode bodies, rewrite headers, and follow
//! redirects — all of which would be wrong here, and the first two would be invisible until a user
//! noticed their page had changed in transit.
//!
//! The one transformation that *is* correct is dechunking, and it is correct only because the
//! response is re-framed for the edge with a recomputed length. That is the bug this module exists to
//! prevent recurring: forwarding `Transfer-Encoding: chunked` with an unchunked body made a real
//! Next.js app render its chunk-size lines as page content.

use nport_protocol::connect::{is_hop_by_hop, splits_a_head};
use tokio::io::{AsyncRead, AsyncReadExt as _};

/// Ceiling on an origin's response head.
///
/// A non-HTTP server listening on the port — or one that never terminates its head — must not make
/// the connector buffer without bound. 64 KiB is far past any real head.
pub const MAX_RESPONSE_HEAD: usize = 64 * 1024;

/// Ceiling on one chunk-size line.
///
/// The same reasoning as [`MAX_RESPONSE_HEAD`], applied where it had not been: a chunk-size line is
/// read until a newline, so an origin that never sends one makes the connector buffer without bound.
/// Sixteen hex digits is the largest a `usize` can be, and extensions are ignored — a kilobyte is far
/// past anything real, and the point is that it is finite.
pub const MAX_CHUNK_SIZE_LINE: usize = 1024;

/// Finds the blank line that ends a response head: where the head's text stops, and how many bytes
/// the terminator occupies.
///
/// **Not just `\r\n\r\n`.** RFC 9112 §2.2 says the line terminator is CRLF but "a recipient MAY
/// recognize a single LF as a line terminator and ignore any preceding CR" — and curl and llhttp both
/// do, so a hand-rolled server that writes bare LFs works with every tool its author tried and then
/// fails only through the tunnel. That is the population NPort serves: a small server someone wrote
/// this afternoon. Scanning for CRLF alone gave them `HeadTruncated` and no response at all.
///
/// The longest match at a position wins, so a real `\r\n\r\n` is never mistaken for the shorter
/// mixed forms that are its prefixes.
fn find_head_end(raw: &[u8]) -> Option<(usize, usize)> {
    const TERMINATORS: [&[u8]; 4] = [b"\r\n\r\n", b"\r\n\n", b"\n\r\n", b"\n\n"];

    (0..raw.len()).find_map(|at| {
        TERMINATORS
            .iter()
            .find(|terminator| raw[at..].starts_with(terminator))
            .map(|terminator| (at, terminator.len()))
    })
}

/// The longest terminator [`find_head_end`] can match, and therefore how many bytes of overlap an
/// incremental scan has to keep so a terminator split across two reads is still seen.
const MAX_TERMINATOR: usize = 4;

/// What went wrong reading the origin's response.
///
/// Every variant means the *local* server misbehaved or vanished, never the edge — which is why they
/// map to `LOCAL_REQUEST_FAILED` rather than to anything tunnel-shaped. The user's next move is to
/// look at their own app.
#[derive(Debug, thiserror::Error)]
pub enum OriginError {
    #[error("the origin closed the connection before finishing its response head")]
    HeadTruncated,
    #[error("the origin's response head exceeded {MAX_RESPONSE_HEAD} bytes")]
    HeadTooLarge,
    #[error("the origin's response had no status code")]
    NoStatus,
    #[error("the origin sent a malformed chunked body: {reason}")]
    MalformedChunk { reason: String },
    #[error("the origin's response could not be read")]
    Read(#[source] std::io::Error),
}

/// A parsed origin response head, with hop-by-hop headers already removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    /// End-to-end headers only. `content-length` is **not** among them — see [`ResponseHead::parse`].
    pub headers: Vec<(String, String)>,
    /// Bytes read past the `\r\n\r\n`. On a `101` these are already WebSocket frames.
    pub leftover: Vec<u8>,
    /// Whether the body arrives chunk-framed.
    ///
    /// Captured *before* `Transfer-Encoding` is stripped, and surfaced rather than dropped with it:
    /// the framing is still in the body, and forwarding it raw sends chunk-size lines to the browser
    /// as content.
    pub chunked: bool,
    /// What the origin claimed the body's length was, if it said.
    ///
    /// Surfaced for the same reason as [`ResponseHead::chunked`], and with the same discipline: the
    /// header is stripped from [`ResponseHead::headers`] so it can never be *copied* past a
    /// transformation, but a relay forwarding the body untouched still needs the number. Absent on a
    /// chunked response, and absent means the body is delimited by end-of-stream
    /// (`docs/PROTOCOL.md` §11).
    pub content_length: Option<usize>,
}

impl ResponseHead {
    /// Parses a complete response head. `raw` must contain the terminating `\r\n\r\n`.
    ///
    /// Header lines are split on the colon, with the optional whitespace around the value trimmed —
    /// see the comment on the split for why `": "` was wrong and why the leniency is safe here.
    ///
    /// Two headers are then removed and neither is optional:
    ///
    /// - **Hop-by-hop headers** describe one connection and must not be relayed
    ///   ([`is_hop_by_hop`]). On a `101` this strips `Connection` and `Upgrade`, matching upstream —
    ///   the edge learns about the upgrade from the status code and `Sec-WebSocket-Accept`, not from
    ///   headers.
    /// - **`content-length`**, because it is re-derived from the body actually assembled. A length
    ///   copied from the origin is wrong the moment the body is dechunked, and a wrong
    ///   `content-length` truncates the response in the browser.
    pub fn parse(raw: &[u8]) -> Result<Self, OriginError> {
        let (split, terminator) = find_head_end(raw).ok_or(OriginError::HeadTruncated)?;

        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let leftover = raw[split + terminator..].to_vec();

        // Split on the LF and drop a CR that was in front of it, which handles CRLF, bare LF, and a
        // head that mixes them line by line — the shape a server assembling its head from string
        // concatenation actually produces.
        let mut lines = head
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line));
        let status: u16 = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .ok_or(OriginError::NoStatus)?;

        // Split on the colon, not on `": "`. The space is optional — RFC 9110 §5.1 is
        // `field-line = field-name ":" OWS field-value OWS`, and `OWS` may be empty or a tab — so
        // requiring it silently *dropped* every header an origin wrote as `Name:value`. Harmless for a
        // header nobody reads; not harmless for the two read below, where an undetected
        // `Transfer-Encoding:chunked` sends chunk-size lines to the browser as content.
        //
        // The name is trimmed too, which is leniency toward something RFC 9112 §5.1 says to reject
        // (whitespace before the colon). It fails safe *here* specifically because this parser is the
        // only one downstream: `transfer-encoding` is hop-by-hop and `content-length` is stripped
        // below, so the framing is always re-derived and the origin's own framing headers are never
        // relayed for a second parser to read differently. Do not copy this leniency somewhere that
        // forwards them.
        let all: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
            .collect();

        let chunked = all.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
        });

        let content_length = all
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse().ok());

        let headers = all
            .into_iter()
            .filter(|(name, value)| {
                !is_hop_by_hop(name)
                    && !name.eq_ignore_ascii_case("content-length")
                    // The mirror of the check `nport_protocol::connect` applies to metadata arriving
                    // from the edge. Splitting on the LF above means a value can no longer contain one,
                    // but a bare CR mid-value survives, and these headers go back to the edge as
                    // metadata for it to write into a response head toward the browser. Dropped rather
                    // than relayed, for the same reason and with the same caveat: no known path makes
                    // the edge emit it unsanitised, and the guarantee is not ours to rely on.
                    && !splits_a_head(name)
                    && !splits_a_head(value)
            })
            .collect();

        Ok(Self {
            status,
            headers,
            leftover,
            chunked,
            content_length,
        })
    }

    /// Reads one response head from the origin, stopping at the `\r\n\r\n`.
    ///
    /// Incremental rather than read-to-end for two independent reasons. A `101` has no body to read
    /// to the end *of* — the socket becomes a byte pipe — and even an ordinary response should start
    /// reaching the browser before the origin has finished producing it.
    ///
    /// Whatever arrived past the terminator comes back in [`ResponseHead::leftover`] rather than
    /// being dropped: after a `101` those bytes are already WebSocket frames, and a scratch buffer
    /// that goes out of scope loses the origin's first frame with nothing to show for it.
    ///
    /// # Errors
    ///
    /// [`OriginError::HeadTruncated`] if the origin closed first, [`OriginError::HeadTooLarge`] past
    /// [`MAX_RESPONSE_HEAD`] — which is what stops a non-HTTP server on the port from making the
    /// connector buffer without bound — and [`OriginError::Read`] on an I/O failure.
    pub async fn read<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Self, OriginError> {
        let mut raw = Vec::new();
        let mut scratch = [0u8; 4096];
        // Where to resume scanning. Rescanning the whole buffer per read is quadratic in the head's
        // size, and the terminator can straddle two reads by at most `MAX_TERMINATOR - 1` bytes.
        let mut scanned = 0usize;

        loop {
            if find_head_end(&raw[scanned..]).is_some() {
                break;
            }
            scanned = raw.len().saturating_sub(MAX_TERMINATOR - 1);

            if raw.len() > MAX_RESPONSE_HEAD {
                return Err(OriginError::HeadTooLarge);
            }
            let read = reader.read(&mut scratch).await.map_err(OriginError::Read)?;
            if read == 0 {
                return Err(OriginError::HeadTruncated);
            }
            raw.extend_from_slice(&scratch[..read]);
        }

        Self::parse(&raw)
    }
}

/// Reads a chunk-size line: hexadecimal, with optional `;ext=value` extensions.
///
/// Shared with the streaming decoder in [`crate::exchange`], which reads the same lines off a socket
/// one at a time. Two decoders that disagreed about the radix would be a bug nobody would find
/// twice: `1c8d` read as decimal is where the whole class starts.
///
/// # Errors
///
/// [`OriginError::MalformedChunk`] if the line is not UTF-8 or not hexadecimal.
pub fn chunk_size(line: &[u8]) -> Result<usize, OriginError> {
    // Extensions are ignored, but must not be allowed to corrupt the size.
    let text = line.split(|byte| *byte == b';').next().unwrap_or(line);
    let text = std::str::from_utf8(text)
        .map_err(|_| OriginError::MalformedChunk {
            reason: "size line is not UTF-8".to_owned(),
        })?
        .trim();

    usize::from_str_radix(text, 16).map_err(|_| OriginError::MalformedChunk {
        reason: format!("size {text:?} is not hexadecimal"),
    })
}

/// Removes HTTP/1.1 chunked framing, yielding the body the origin meant to send.
///
/// The response is re-framed for the edge with a recomputed length, so the framing must come off
/// here or the browser is handed hex chunk sizes as page content — which is exactly what shipped
/// once. Trailers after the terminating chunk are dropped: nothing downstream can act on them, and
/// forwarding them would mean inventing a place to put them.
pub fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, OriginError> {
    let mut out = Vec::with_capacity(body.len());
    let mut rest = body;

    loop {
        // Terminated by the LF, with any preceding CR left for `chunk_size` to trim — the same
        // leniency [`find_head_end`] applies, and for the same origins.
        let line_end = rest.iter().position(|byte| *byte == b'\n').ok_or_else(|| {
            OriginError::MalformedChunk {
                reason: "ended mid-size-line".to_owned(),
            }
        })?;
        let size = chunk_size(&rest[..line_end])?;

        rest = &rest[line_end + 1..];
        if size == 0 {
            break;
        }
        // **Checked, because `size` comes off the wire.** A size line of `ffffffffffffffff` parses to
        // `usize::MAX`, and `size + 2` then overflows: a panic in debug, and in release a wrap to 1
        // that sails past this check and panics on the slice below instead. Either way a malformed
        // origin response takes the process down, and `crates/CLAUDE.md` is explicit that a panic here
        // kills the desktop app's window.
        // `+ 1` rather than `+ 2`: the data plus at least a bare LF, the shortest terminator accepted
        // below. Still checked, because `size` comes off the wire — a size line of `ffffffffffffffff`
        // parses to `usize::MAX` and the add overflows: a panic in debug, and in release a wrap that
        // sails past this check and panics on the slice instead. Either way a malformed origin response
        // takes the process down, and `crates/CLAUDE.md` is explicit that a panic here kills the desktop
        // app's window.
        let needed = size
            .checked_add(1)
            .ok_or_else(|| OriginError::MalformedChunk {
                reason: format!("chunk size {size} cannot be framed"),
            })?;
        if rest.len() < needed {
            return Err(OriginError::MalformedChunk {
                reason: format!("chunk claims {size} bytes but only {} remain", rest.len()),
            });
        }
        out.extend_from_slice(&rest[..size]);
        // Each chunk is followed by its own line terminator. Matched rather than skipped: the old
        // `+ 2` consumed whatever two bytes were there, so a bare LF ate the first digit of the next
        // size line and turned a decodable body into a parse error one chunk later.
        rest = match &rest[size..] {
            [b'\r', b'\n', tail @ ..] | [b'\n', tail @ ..] => tail,
            _ => {
                return Err(OriginError::MalformedChunk {
                    reason: format!("chunk of {size} bytes is not followed by a line terminator"),
                });
            }
        };
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(raw: &str) -> ResponseHead {
        ResponseHead::parse(raw.as_bytes()).expect("should parse")
    }

    /// The same, for a head whose line endings matter and so cannot go through a `&str` literal
    /// without the escapes being the point of the test.
    fn head_bytes(raw: &[u8]) -> ResponseHead {
        ResponseHead::parse(raw).expect("should parse")
    }

    /// A size a malformed origin can simply send, and the arithmetic that used to follow it.
    ///
    /// `ffffffffffffffff` is `usize::MAX`. `size + 2` overflowed: a panic in debug, and in release a
    /// wrap to 1 that sailed past the bounds check and panicked on the slice instead. `crates/CLAUDE.md`
    /// is explicit that a panic in `crates/core` takes the desktop app's window with it, so an origin's
    /// bad framing must be an error, never a crash.
    #[test]
    fn an_impossible_chunk_size_is_an_error_not_a_panic() {
        let error = decode_chunked(b"ffffffffffffffff\r\nx").expect_err("must refuse");
        assert!(
            matches!(error, OriginError::MalformedChunk { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn a_chunk_larger_than_the_body_is_an_error() {
        // The ordinary case the overflow check must not have broken.
        let error = decode_chunked(b"10\r\nshort\r\n").expect_err("must refuse");
        assert!(
            matches!(error, OriginError::MalformedChunk { .. }),
            "{error:?}"
        );
    }

    /// The space after the colon is optional, and two of these headers change how the body is framed.
    ///
    /// `field-line = field-name ":" OWS field-value OWS` (RFC 9110 §5.1), and `OWS` may be empty. A
    /// `": "` split dropped every one of these — silently, so the response looked fine until the
    /// undetected `Transfer-Encoding` put chunk-size lines in the browser as content.
    #[test]
    fn reads_headers_written_without_a_space_after_the_colon() {
        let parsed = head(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding:chunked\r\nContent-Length:42\r\nLocation:/x\r\n\r\n",
        );

        assert!(
            parsed.chunked,
            "the body would be forwarded still chunk-framed"
        );
        assert_eq!(parsed.content_length, Some(42));
        assert_eq!(
            parsed.headers,
            vec![("Location".to_owned(), "/x".to_owned())],
            "framing headers are stripped, the rest is relayed"
        );
    }

    #[test]
    fn reads_headers_written_with_a_tab_or_extra_spaces() {
        // `OWS = *( SP / HTAB )`, so both of these are as valid as one space.
        let parsed = head("HTTP/1.1 200 OK\r\nLocation:\t/tab\r\nX-Pad:   spaced   \r\n\r\n");

        assert_eq!(
            parsed.headers,
            vec![
                ("Location".to_owned(), "/tab".to_owned()),
                ("X-Pad".to_owned(), "spaced".to_owned()),
            ]
        );
    }

    #[test]
    fn a_value_containing_a_colon_survives_the_split() {
        // The first colon separates; the rest belongs to the value. `Date` and any absolute URL would
        // otherwise be truncated by a split-on-every-colon.
        let parsed = head("HTTP/1.1 302 Found\r\nLocation: https://x.test:8443/a\r\n\r\n");

        assert_eq!(
            parsed.headers,
            vec![("Location".to_owned(), "https://x.test:8443/a".to_owned())]
        );
    }

    #[test]
    fn a_line_with_no_colon_is_ignored() {
        let parsed = head("HTTP/1.1 200 OK\r\ngarbage\r\nLocation: /x\r\n\r\n");

        assert_eq!(
            parsed.headers,
            vec![("Location".to_owned(), "/x".to_owned())]
        );
    }

    /// A head terminated with bare LFs must parse, because curl accepts it and so the author never
    /// found out.
    ///
    /// RFC 9112 §2.2: the terminator is CRLF, but "a recipient MAY recognize a single LF as a line
    /// terminator and ignore any preceding CR". Scanning for `\r\n\r\n` alone never found the end of
    /// this head at all — the connector read to `MAX_RESPONSE_HEAD` or to EOF and reported
    /// `LOCAL_REQUEST_FAILED` for a server that answers every other client correctly.
    #[test]
    fn parses_a_head_terminated_with_bare_lf() {
        let parsed =
            head_bytes(b"HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 5\n\nhello");

        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.content_length, Some(5));
        assert_eq!(
            parsed.leftover, b"hello",
            "the body must not eat the terminator"
        );
        assert_eq!(
            parsed.headers,
            vec![("Content-Type".to_owned(), "text/plain".to_owned())]
        );
    }

    #[test]
    fn parses_a_head_that_mixes_crlf_and_bare_lf() {
        // What a server assembling its head by string concatenation actually produces. A
        // `split("\r\n")` merged these into one header whose value carried a raw newline.
        let parsed = head_bytes(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\nX-Real: yes\r\nContent-Length: 2\r\n\r\nhi",
        );

        assert_eq!(
            parsed.headers,
            vec![
                ("Content-Type".to_owned(), "text/plain".to_owned()),
                ("X-Real".to_owned(), "yes".to_owned()),
            ]
        );
        assert_eq!(parsed.content_length, Some(2));
        assert_eq!(parsed.leftover, b"hi");
    }

    #[test]
    fn a_crlf_head_is_not_mistaken_for_a_shorter_terminator() {
        // `\r\n\r\n` has `\n\r\n` and `\r\n\n` as near-misses; matching one of those would leave a
        // stray byte at the front of the body. The longest match at a position has to win.
        let parsed = head_bytes(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody");

        assert_eq!(parsed.leftover, b"body");
    }

    #[test]
    fn a_header_value_with_a_bare_cr_is_dropped() {
        // These go back to the edge as metadata for it to write into a response head, so the check
        // `nport_protocol` applies to metadata arriving from the edge applies here with roles swapped.
        let parsed = head_bytes(b"HTTP/1.1 200 OK\r\nX-Split: a\rb\r\nX-Fine: ok\r\n\r\n");

        assert_eq!(parsed.headers, vec![("X-Fine".to_owned(), "ok".to_owned())]);
    }

    /// Chunk framing with bare LFs, from the same server whose head uses them.
    ///
    /// The head fix alone was not enough: a server that writes `\n` in its status line writes `\n`
    /// after each chunk too, and the two halves are one origin. curl decodes this body.
    #[test]
    fn decodes_chunk_framing_that_uses_bare_lf() {
        let out = decode_chunked(b"5\nhello\n6\n world\n0\n\n").expect("must decode");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn decodes_chunk_framing_that_mixes_terminators() {
        // A CRLF size line and a bare-LF chunk terminator, which is what a server built by
        // concatenating strings from two places produces.
        let out = decode_chunked(b"5\r\nhello\n6\r\n world\r\n0\r\n\r\n").expect("must decode");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn a_chunk_not_followed_by_a_terminator_is_refused() {
        // The old code skipped two bytes without looking at them, so garbage here was consumed
        // silently and surfaced as a hex-parse error on the *next* size line — a message pointing at
        // the wrong chunk. Matching the terminator means the complaint names the right one.
        let error = decode_chunked(b"5\r\nhelloXX6\r\n world\r\n0\r\n\r\n").expect_err("refuse");
        assert!(
            matches!(&error, OriginError::MalformedChunk { reason } if reason.contains("terminator")),
            "{error:?}"
        );
    }

    #[test]
    fn a_chunk_terminator_cut_short_is_refused() {
        // `hello\r` with nothing after it: one byte of terminator present, and it is the wrong one.
        let error = decode_chunked(b"5\r\nhello\r").expect_err("refuse");
        assert!(
            matches!(&error, OriginError::MalformedChunk { reason } if reason.contains("terminator")),
            "{error:?}"
        );
    }

    #[test]
    fn parses_a_status_and_end_to_end_headers() {
        let parsed = head("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nx-app: mine\r\n\r\n");
        assert_eq!(parsed.status, 200);
        assert_eq!(
            parsed.headers,
            vec![
                ("content-type".to_owned(), "text/html".to_owned()),
                ("x-app".to_owned(), "mine".to_owned()),
            ]
        );
    }

    #[test]
    fn strips_content_length_so_it_can_be_recomputed() {
        // A length copied from the origin is wrong the moment the body is dechunked, and a wrong
        // content-length truncates the response in the browser.
        let parsed = head("HTTP/1.1 200 OK\r\ncontent-length: 42\r\n\r\n");
        assert!(
            !parsed
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        );
    }

    #[test]
    fn strips_hop_by_hop_headers() {
        let parsed = head(
            "HTTP/1.1 200 OK\r\nconnection: keep-alive\r\ntransfer-encoding: chunked\r\nx-keep: yes\r\n\r\n",
        );
        assert_eq!(
            parsed.headers,
            vec![("x-keep".to_owned(), "yes".to_owned())]
        );
    }

    #[test]
    fn reports_chunked_before_stripping_the_header_that_said_so() {
        // The framing is still in the body. Dropping the header without surfacing the fact is what
        // sent hex chunk sizes to a browser as page content.
        let parsed = head("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
        assert!(parsed.chunked);
        assert!(parsed.headers.is_empty());
    }

    #[test]
    fn detects_chunked_among_several_codings_and_ignores_case() {
        let parsed = head("HTTP/1.1 200 OK\r\nTRANSFER-ENCODING: gzip, Chunked\r\n\r\n");
        assert!(parsed.chunked);
    }

    #[test]
    fn keeps_bytes_that_arrived_after_the_head() {
        // On a 101 these are already WebSocket frames, and losing them loses the first message.
        // A byte-string literal, not a `&str`: WebSocket frames are not UTF-8, and `\x81` is not a
        // legal escape in a Rust string.
        let parsed = ResponseHead::parse(
            b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n\x81\x04ping",
        )
        .expect("should parse");
        assert_eq!(parsed.status, 101);
        assert_eq!(parsed.leftover, b"\x81\x04ping");
    }

    #[test]
    fn refuses_a_head_with_no_terminator() {
        assert!(matches!(
            ResponseHead::parse(b"HTTP/1.1 200 OK\r\n"),
            Err(OriginError::HeadTruncated)
        ));
    }

    #[test]
    fn refuses_a_head_with_no_status_code() {
        // A non-HTTP server on the port is the common cause, and a clear error beats a panic.
        assert!(matches!(
            ResponseHead::parse(b"nonsense\r\n\r\n"),
            Err(OriginError::NoStatus)
        ));
    }

    #[test]
    fn decodes_a_single_chunk() {
        assert_eq!(
            decode_chunked(b"5\r\nhello\r\n0\r\n\r\n").unwrap(),
            b"hello"
        );
    }

    #[test]
    fn joins_chunks_without_leaving_separators_behind() {
        // The failure this guards: keeping the CRLF between chunks, which shows up as stray blank
        // lines rather than as obvious garbage.
        assert_eq!(
            decode_chunked(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap(),
            b"hello world"
        );
    }

    #[test]
    fn reads_sizes_as_hexadecimal_not_decimal() {
        // `1c8d` appeared verbatim in the corrupted page a user reported. Parsed as decimal it is
        // nonsense, and getting this radix wrong is where the whole bug class starts.
        let payload = vec![b'x'; 0x1c8d];
        let mut body = format!("{:x}\r\n", payload.len()).into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(decode_chunked(&body).unwrap().len(), 0x1c8d);
    }

    #[test]
    fn ignores_chunk_extensions() {
        assert_eq!(
            decode_chunked(b"5;name=value\r\nhello\r\n0\r\n\r\n").unwrap(),
            b"hello"
        );
    }

    #[test]
    fn drops_trailers_after_the_terminating_chunk() {
        assert_eq!(
            decode_chunked(b"5\r\nhello\r\n0\r\nx-trailer: v\r\n\r\n").unwrap(),
            b"hello"
        );
    }

    #[test]
    fn handles_an_empty_body() {
        assert_eq!(decode_chunked(b"0\r\n\r\n").unwrap(), b"");
    }

    #[test]
    fn refuses_a_truncated_chunk() {
        // Returning the partial body would silently serve a truncated page.
        assert!(matches!(
            decode_chunked(b"10\r\nshort\r\n"),
            Err(OriginError::MalformedChunk { .. })
        ));
    }

    #[test]
    fn refuses_a_non_hexadecimal_size() {
        assert!(matches!(
            decode_chunked(b"zz\r\nhello\r\n0\r\n\r\n"),
            Err(OriginError::MalformedChunk { .. })
        ));
    }
}
