# Golden byte fixtures

Byte captures of real connector frames, asserted unchanged by `tests/golden_fixtures.rs`.

**These are not test data you may regenerate to make a test pass.** Their whole value is that
they came from somewhere other than this crate. See `docs/TESTING.md` § Golden byte fixtures for
the review rule; the short version is that a failure is either our regression, a cloudflared
re-pin, or **an edge change that breaks every installed client**, and you have to decide which
before touching anything.

## What is here

| File | Direction | Provenance | Captured |
| --- | --- | --- | --- |
| `connect_request_http.bin` | edge → client | live Cloudflare edge, colo `hkg09` | 2026-08-03 |
| `connect_request_websocket.bin` | edge → client | live Cloudflare edge, colo `hkg09` | 2026-08-03 |

Each is the complete data-stream frame: the 8-byte preamble (`0a 36 cd 12 a1 3e` + `"01"`)
followed by the unpacked Cap'n Proto `ConnectRequest`. Nothing follows, because the capture tee
stops exactly where the decoder stops — that extent is itself part of what the fixture asserts
(`docs/PROTOCOL.md` §11).

## Provenance, and why these count as edge bytes

A `ConnectRequest` **originates at Cloudflare**. Recording one as our own client receives it
therefore yields authentic edge output — arguably better provenance than capturing cloudflared,
which would only be relaying the same bytes.

That reasoning does not extend to the other direction. `ConnectResponse`,
`register_connection`'s call message, and the control-stream bootstrap are all frames the
*client* emits, so capturing them from our own client would prove only self-consistency. They
are **not here yet** and must come from cloudflared. `docs/TESTING.md` records the harness
needed.

## Redaction — read before comparing bytes by hand

The edge stamps the connecting client's public IP into `Cf-Connecting-Ip` and `X-Forwarded-For`.
During a capture that client is the person running the spike, and these files live in a public
repository, so those values are **overwritten in place before anything reaches disk**:

```
Cf-Connecting-Ip: REDACTED....
X-Forwarded-For:  REDACTED....
```

The replacement is **exactly as long** as what it replaced. Every segment offset, field pointer,
and metadata count in the Cap'n Proto message is therefore still precisely what the edge
produced, and only those bytes differ. A shorter placeholder would have meant re-encoding, and a
re-encoded fixture is our encoder's output — the one thing a golden fixture must not be.

`tests/golden_fixtures.rs::no_fixture_contains_a_client_ip` is the guard against a future
capture that forgets. It checks the named headers *and* scans for anything IPv4-shaped anywhere
in the file.

Left as sent, deliberately: `Cf-Ray` (a request identifier, not personal), `Cf-Ipcountry`
(country granularity), and the WebSocket `Sec-Websocket-Key` (a random per-connection nonce that
the fixture would be pointless without).

## Recapturing

Deliberate by design — `record()` refuses to overwrite, so you must delete a file first, which
means you cannot destroy the record of what the edge used to send by accident.

```bash
rm crates/protocol/tests/fixtures/connect_request_http.bin
export NPORT_FIXTURE_DIR="$PWD/crates/protocol/tests/fixtures"
./crates/protocol/tests/live/tunnel.sh builtin fix-spike 90
# then, against the printed URL:
curl "https://fix-spike.nport.link/fixture?q=1"
cargo run -p nport-protocol --example ws_client -- wss://fix-spike.nport.link/ 3
```

Update the table above with the new date and colo in the same commit.
