# crates/protocol

> **The highest-risk directory in this repository.** Read `docs/PROTOCOL.md` in full before changing anything here. Not skimmed — in full.

## Scope

A native Rust implementation of Cloudflare's tunnel connector protocol: edge discovery, QUIC and HTTP/2 transports, Cap'n Proto registration RPC, and per-stream request framing. This replaces the `cloudflared` binary entirely (ADR-0002).

**Not responsible for:** tunnel lifecycle, provisioning, the NPort API, retries above the connection level, or anything user-facing. It speaks the wire and nothing else; `crates/core` owns policy.

**Status: implemented and proven live.** Phase 1 closed on 2026-08-03: token, edge discovery, QUIC handshake, registration, framing, WebSockets, and a four-connection pool, all verified against the real edge. The DoT discovery fallback landed 2026-08-05 (ADR-0035), so `src/edge.rs` now does all three of §4's paths rather than the two its layout claimed. `src/h2.rs` is still unwritten (ADR-0017 Fallback 1).

## Why this directory is dangerous

The protocol is **undocumented, unversioned in practice, and owned by someone else.** Cloudflare can change it without notice, with no deprecation window and no obligation to us. When that happens, **every installed NPort client breaks at once** and users cannot fix it themselves — the largest blast radius in the system (`docs/ARCHITECTURE.md` §5).

That is why the rules below are strict about citations and fixtures. A magic number nobody can trace is a number nobody can safely fix at 2am during an incident.

## Layout

```
src/lib.rs        Transport trait; both transports implement it
src/token.rs      tunnel token: parse, redact, zeroize
src/edge.rs       SRV / DoT / A-AAAA discovery, address pool, per-index rotation
src/quic.rs       QUIC transport (primary)
                  (src/h2.rs — ADR-0017 Fallback 1, NOT YET WRITTEN, Phase 2b)
src/connect.rs    stream signatures, version byte, ConnectRequest/Response codecs,
                  and the metadata-to-request-head mapping
                  (src/datagram.rs — out of scope for 3.0, ADR-0020, not written)
src/rpc.rs        Cap'n Proto registration RPC, and the session that holds
                  the control stream open for graceful shutdown
schema/*.capnp    VENDORED from cloudflared at the pinned commit — do not edit
tests/            codec, handshake, fixtures/, snapshots/, live/
build.rs          capnpc codegen
```

## Commands

```bash
cargo test -p nport-protocol              # hermetic: codecs, snapshots, fixtures
cargo test -p nport-protocol -- --ignored # live edge; needs network + a real token
cargo insta review                        # review snapshot changes one by one
cargo xtask fixtures                      # capture golden byte fixtures
```

## Rules

1. **Never guess a constant.** Read it from the pinned cloudflared commit in `docs/PROTOCOL.md` §1 and cite `file:symbol` in a comment beside it. A value without a citation will be deleted in review. The shape is in `docs/conventions/rust.md` § Comments, which is where it lives — this file carried a second, byte-identical copy of the same example.

2. **Never take a protocol fact from a blog post, a wiki, or an LLM's memory.** Several third-party write-ups describe the per-stream body as msgpack. It is Cap'n Proto. Read the source.
3. **Vendored `.capnp` files are read-only.** Copied verbatim from the pinned commit, including the deprecated legacy section — type IDs matter.
4. **Any wire-format change needs an updated golden fixture and a reviewed `insta` snapshot** in the same PR.
5. **Any protocol change updates `docs/PROTOCOL.md` in the same commit.** Never a follow-up.
6. **`src/h2.rs` must keep compiling even while unused.** It is the ADR-0017 fallback and it is worthless if it has silently rotted by the time you need it.
7. **Re-pinning the cloudflared commit is a deliberate act**, not a drive-by: bump the SHA, re-read every cited symbol, update §1's date, re-run the live tests, record it in `docs/DECISIONS.md`.
8. **Answers to the open questions in §17 get written down** with a date, the moment the spike answers one. They are a deliverable. **Try the source first**: four of the six were answered by reading the pinned tree rather than by touching the edge, and one of those turned out to be the wrong question — it asked for the full set of `ConnectionError.cause` strings, which does not exist, because `shouldRetry :Bool` carries the decision.
9. `#![forbid(unsafe_code)]`. No exceptions.
10. **The token never reaches argv, a log, a file, or a `Debug` impl.**

## Common tasks

**Implement a new frame type** — read the Go source at the pinned commit → add the codec in `src/connect.rs` with citations → `insta` snapshot → capture a golden fixture from **cloudflared**, not from our own encoder → `proptest` roundtrip → document it in `docs/PROTOCOL.md` §7 with an annotated hexdump.

**Debug a failing handshake** — work the list in order, because it is roughly the order of likelihood:

1. Is the control stream being sent a signature preamble? **It must not be** (§6, trap 1). This is the most common first-attempt failure by a wide margin.
2. Is `interfaceId` `0xf71695ec7fe85497` (`RegistrationServer`)? `0xea58385c65416035`/`@0` is the deprecated `registerTunnel`, not `registerConnection` (§8).
3. Is keep-alive set to 1 s? Without it the connection dies after 5 s of quiet and looks like a server-side reject.
4. Is `tunnelId` the 16 raw UUID bytes, not the dashed string?
5. Is `tunnelSecret` the raw decoded bytes, not the base64 text?
6. Is the key-exchange group acceptable? Try `secp256r1` alone, then add `X25519MLKEM768` (§5, risk P3).
7. Is the 8-byte data-stream preamble written in a single `write_all`? (§6, trap 2)

**Add a transport** — implement the `Transport` trait; registration and framing are shared, so a transport only owns dialling and stream opening.

## Gotchas

- **The control stream carries no signature and no version byte**, unlike every other stream type. Say it out loud before debugging anything else.
- **`Session::open` panics outside a `LocalSet`.** It `spawn_local`s the driver, because `capnp-rpc` holds `Rc` (ADR-0024). The panic is deliberate — a session with nothing polling its `RpcSystem` would silently never make progress, which is far harder to diagnose. `crates/core`'s `LocalRuntime::host` is where it belongs.
- **Upstream's `readVersion` uses a bare `Read`, not `ReadFull`**, so splitting the two version bytes across packets desyncs the peer. Write the preamble in one call.
- **`quinn` does not enable keep-alive by default.** Set `keep_alive_interval` explicitly.
- **Initial packet size is 1232/1252, not 1280.** Upstream chose this because 1280 broke tunnelling through WARP, whose MTU is exactly 1280.
- **Never buffer writes toward the edge.** Flushing is a no-op upstream because QUIC streams are unbuffered at this layer; a `BufWriter` will stall SSE and gRPC in ways that are miserable to diagnose.
- **`retryAfter` in `ConnectionError` is nanoseconds**, a Go `time.Duration`. Treating it as milliseconds gives a 1000× wrong backoff.
- **Classify registration errors on `shouldRetry`, not on the cause text** — `ConnectionError` carries both, and the boolean is the edge's actual signal. Exactly two strings are worth matching, and only because they change the *action*: `EDUPCONN` means rotate the address (retrying the same one loops forever), and a cause containing `Unauthorized` is transient enough to retry even when `shouldRetry` is false, because a freshly created tunnel takes time to propagate. Matching any other cause text is building on prose (§17 Q4).
- **Golden fixtures must come from cloudflared.** A fixture generated by the code under test only proves the code agrees with itself.
- **Two live DNS TXT records can change client expectations with no cloudflared release** (`protocol-v2` and `cfd-features`). `protocol-canary.yml` is the detector.
