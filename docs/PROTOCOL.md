---
applies_to:
  - crates/protocol/**
  - crates/core/src/connector/**
---

# Cloudflare Tunnel connector protocol

Specification for `crates/protocol`. NPort speaks this protocol directly instead of shipping the `cloudflared` binary.

## 1. Status and provenance

| | |
| --- | --- |
| Reference implementation | [`cloudflare/cloudflared`](https://github.com/cloudflare/cloudflared) |
| **Pinned commit** | `3a2b45c2a511fcdd81b68c190938e4ffadbea5dc` (2026-07-22) |
| Corresponding release | `2026.7.3` |
| Upstream licence | Apache-2.0 — permits reimplementation and copying the `.capnp` schema, with attribution and NOTICE |
| Last verified against the live edge | **never — Phase 1 has not run** |
| Implementation status | **not started** |

Every constant below cites the Go file and symbol it was read from. **When you need a value that is not in this document, read it from the pinned commit and add it here with a citation — never guess, and never copy a number from a blog post.** Re-pin deliberately: bump the SHA, re-read the cited symbols, update this file, and record the bump in `docs/DECISIONS.md`.

Read a file from the pinned commit with:

```bash
gh api repos/cloudflare/cloudflared/contents/quic/constants.go \
  --jq '.content' -f ref=3a2b45c2a511fcdd81b68c190938e4ffadbea5dc | base64 -d
```

> `raw.githubusercontent.com` returns 404 for this repo — use `gh api` as above.

### Upstream source map

| Concern | File |
| --- | --- |
| SRV / DoT edge discovery | `edgediscovery/allregions/discovery.go` |
| Region partitioning, conn-index → address | `edgediscovery/allregions/{regions,region,address}.go`, `edgediscovery/edgediscovery.go` |
| Region hostnames | `prechecks/probes.go` |
| Protocol rollout TXT record | `edgediscovery/protocol.go` |
| ALPN, SNI, TLS settings | `connection/protocol.go`, `tlsconfig/certreloader.go`, `crypto/curves.go` |
| QUIC dial and `quic.Config` | `supervisor/tunnel.go`, `connection/quic.go`, `quic/constants.go`, `quic/param_unix.go` |
| Stream signatures and version byte | `tunnelrpc/quic/protocol.go` |
| `ConnectRequest` / `ConnectResponse` | `tunnelrpc/proto/quic_metadata_protocol.capnp`, `tunnelrpc/pogs/quic_metadata_protocol.go` |
| Registration schema | `tunnelrpc/proto/tunnelrpc.capnp` |
| Registration client | `tunnelrpc/registration_client.go`, `tunnelrpc/pogs/registration_server.go`, `tunnelrpc/utils.go` |
| Control-stream lifecycle | `connection/control.go`, `connection/quic_connection.go` |
| Token and credentials | `connection/connection.go`, `cmd/cloudflared/tunnel/subcommands.go` |
| HTTP/2 transport | `connection/http2.go`, `connection/header.go`, `edgediscovery/dial.go` |
| Feature flags | `features/features.go`, `features/selector.go` |
| Defaults | `cmd/cloudflared/tunnel/cmd.go`, `cmd/cloudflared/flags/flags.go` |

## 2. Terminology

- **Tunnel** — a Cloudflare resource identified by a UUID, created via the Cloudflare API by `apps/api`. Traffic reaches it through a DNS CNAME to `<tunnelID>.cfargotunnel.com`.
- **Connector** — the client process that registers connections to a tunnel and proxies traffic. In v2 this was `cloudflared`; in v3 it is `crates/protocol` + `crates/core`.
- **Connection index** — `0..N-1`, identifying one of the N concurrent edge connections belonging to a single connector. Default N = 4.
- **Edge** — a Cloudflare data-centre endpoint the connector dials.
- **Lease** — NPort's own ownership record for a subdomain. Not a Cloudflare concept; see `docs/ARCHITECTURE.md` §4.
- **Exchange** — one request/response pair carried over one QUIC stream. NPort's term, used by the desktop inspector.

## 3. Credentials

`apps/api` returns a **tunnel token**: standard padded base64 (`base64.StdEncoding`, *not* URL-safe, *not* raw) of a JSON object.

> `connection/connection.go` → `TunnelToken`, `cmd/cloudflared/tunnel/subcommands.go` → `ParseToken`

```jsonc
{
  "a": "<accountTag>",        // string, account tag hex
  "s": "<base64 secret>",     // []byte → base64 string, ≥32 bytes when decoded
  "t": "<uuid>",              // canonical dashed UUID string
  "e": "<endpoint>"           // optional; "fed" for FedRAMP. Selects the regional SRV name only
}
```

Three values are extracted and used: `accountTag` (string), `tunnelSecret` (raw decoded bytes), `tunnelID` (UUID). `e` is **never sent in any RPC** — it only picks the regional SRV name.

Credentials-file mode (`{"AccountTag","TunnelSecret","TunnelID","Endpoint"}`, Go field names) converges on the same three values and additionally needs `cert.pem` for API calls. **NPort uses token mode only** — simpler, no `cert.pem`, and it is already what the backend returns.

### Handling rules

The token is credential material for a Cloudflare resource. It must be:

- **never logged**, at any level, including debug — no `Debug` derive that prints it
- **never written to disk** and never placed in a config file
- **never passed as a command-line argument** (v2 did this, exposing it via `ps` to every local user — see R-CLI in `docs/ARCHITECTURE.md` §8)
- held in memory only, in a wrapper whose `Debug`/`Display` redact and which zeroizes on drop

## 4. Edge discovery

### SRV lookup

> `edgediscovery/allregions/discovery.go` → `srvService`, `srvProto`, `srvName`; `regions.go` → `RegionalServiceName`

Query `_v2-origintunneld._tcp.argotunnel.com` (SRV). Regional variants prepend the region: `_us-v2-origintunneld._tcp.argotunnel.com`, `_fed-v2-…`.

**The port comes from the SRV record's `Port` field and is never hardcoded upstream.** In practice it resolves to **7844** — UDP for QUIC, TCP for HTTP/2. Confirmed by user-facing strings in `supervisor/tunnel.go` and `prechecks/probes.go`.

### DoT fallback

> `edgediscovery/allregions/discovery.go` → `dotServerName`, `dotServerAddr`, `dotTimeout`

If the system resolver fails, retry over DNS-over-TLS: TCP `1.1.1.1:853`, TLS SNI `cloudflare-dns.com`, 15 s timeout. This exists because some networks break SRV lookups.

### Direct A/AAAA shortcut

> `prechecks/probes.go` → `region1Global`, `region2Global`, `region1US`, …

SRV targets resolve to these hostnames, which are hardcoded upstream:

```
region1.v2.argotunnel.com        region2.v2.argotunnel.com
us-region1.v2.argotunnel.com     us-region2.v2.argotunnel.com
fed-region1.v2.argotunnel.com    fed-region2.v2.argotunnel.com
```

A client may skip SRV entirely and A/AAAA-resolve `region1.v2.argotunnel.com` + `region2.v2.argotunnel.com` on port 7844. **Recommended for the Phase 1 spike** — one fewer moving part. Implement SRV before shipping, since it is how Cloudflare steers traffic.

**There are no hardcoded fallback edge IPs anywhere in the upstream source.** Do not invent any. If discovery fails, the tunnel fails.

### Other records queried

| Record | Type | Content | Refresh |
| --- | --- | --- | --- |
| `protocol-v2.argotunnel.com` | TXT | `[{"protocol":"quic","percentage":100},…]` | 1 h (`connection/protocol.go` → `ResolveTTL`) |
| `cfd-features.argotunnel.com` | TXT | `{"dv3_2":<pct>,"skip_prechecks":<bool>}` | 1 h, 10 s timeout (`features/selector.go`) |

Both are **live remote kill-switches**: Cloudflare can change client behaviour without shipping a cloudflared release. A third-party client that ignores them will diverge from cloudflared over time. NPort should read `protocol-v2` at minimum, so a QUIC→HTTP/2 rollout change is respected rather than fought.

### Connection pool

> `cmd/cloudflared/tunnel/cmd.go` → `HaConnections` default `4`; `supervisor/supervisor.go` → `registrationInterval`, `tunnelRetryDuration`; `edgediscovery/allregions/regions.go` → `GetUnusedAddr`

- Default **4 connections**, clamped to the number of discovered addresses.
- **Connection 0 must register successfully before 1..N-1 start**, then one per second (`registrationInterval = 1s`).
- Requires **≥2 SRV results** — upstream errors out below that, treating them as two regions.
- Address handout is a **stateful pool balanced across the two regions**, randomising which region goes first when both have equal availability. It is *not* `index % regions`. Within a region, addresses split into primary/secondary sets by IP family, with a 10-minute demotion timeout (`region.go` → `timeoutDuration`).
- Retry backoff base `tunnelRetryDuration = 10s`; `--retries` default 5.
- **The local UDP source port is reused per connection index across reconnects** (`connection/quic.go` → `portForConnIndex`). This materially improves reconnection behaviour behind NAT; `quinn` will not do it for you.

## 5. Transport A — QUIC

> `connection/protocol.go` → `quicProtos`, `edgeQUICServerName`, `TLSSettings`

- **ALPN: `argotunnel`** — a single protocol string.
- **SNI: `quic.cftunnel.com`**
- RFC 9000 QUIC v1. No draft versions.

Upstream pins a Cloudflare fork of quic-go (`chungthuang/quic-go`, based on 0.45) for MTU and ECN behaviour, not wire-format changes. `quinn` is compatible.

### TLS

> `tlsconfig/certreloader.go` → `CreateTunnelConfig`

Verification is **standard and not customized**: the OS system root pool, normal hostname and chain verification, **no certificate pinning**, and **no client certificate**. Upstream also appends three legacy Cloudflare Origin-CA roots, which are irrelevant to edge verification (`quic.cftunnel.com` is publicly trusted) and marked for removal upstream. `rustls` with `rustls-platform-verifier` is sufficient — do not add pinning or disable verification.

### Key exchange — a live risk

> `crypto/curves.go` → `postQuantumPreferCurves`, `P256Kyber768Draft00`

Default mode is `PostQuantumPrefer`, so cloudflared advertises `X25519MLKEM768` (0x11ec), `P256Kyber768Draft00` (0xfe32), and `secp256r1` — and **not plain X25519**.

`0xfe32` is a Cloudflare-specific draft Kyber hybrid with no Rust equivalent, and is deprecated upstream. Offer **`X25519MLKEM768` + `secp256r1`**.

**Whether the edge accepts a classical-only client is unverified** (see §12). The spike should try `secp256r1` alone first — fewer variables — and add `X25519MLKEM768` if the handshake is rejected.

### Transport parameters

> `quic/constants.go`; `supervisor/tunnel.go` → `serveQUIC`; `cmd/cloudflared/tunnel/cmd.go`

| Parameter | Value | Upstream symbol |
| --- | --- | --- |
| Handshake idle timeout | 5 s | `HandshakeIdleTimeout` |
| Max idle timeout | 5 s | `MaxIdleTimeout` |
| **Keep-alive period** | **1 s** | `MaxIdlePingPeriod` |
| Max incoming bidi streams | 2^60 | `MaxIncomingStreams` |
| Max incoming uni streams | 2^60 | `MaxIncomingStreams` |
| Datagrams | enabled | `EnableDatagrams: true` |
| Connection receive window | 30 MiB | `QuicConnLevelFlowControlLimit` |
| Stream receive window | 6 MiB | `QuicStreamLevelFlowControlLimit` |
| Initial packet size | **1232** (IPv4) / **1252** (IPv6) | `serveQUIC` |

Two of these are load-bearing:

- **Keep-alive 1 s is mandatory.** The edge idles you out after 5 s. `quinn` does not enable keep-alive by default — set `TransportConfig::keep_alive_interval` explicitly or every connection dies after five seconds of quiet.
- **Initial packet size 1232/1252, not 1280.** Upstream's comment: quic-go 0.44 raised the default to 1280, which broke anyone tunnelling through WARP, whose MTU *is* 1280. `quinn`'s 1200 default is safe; if you enable MTU discovery, mirror this ceiling.

Upstream also sets `QUIC_GO_DISABLE_ECN=1` (`cmd/cloudflared/main.go`) due to ECN detection bugs. Consider disabling ECN in `quinn` if you see unexplained path failures.

## 6. Stream framing

> `tunnelrpc/quic/protocol.go` — complete file is short; read it

Two 6-byte signatures distinguish stream types, plus a 2-byte ASCII version:

```
dataStreamProtocolSignature = 0A 36 CD 12 A1 3E
rpcStreamProtocolSignature  = 52 BB 82 5C DB 65
protocolV1                  = "01"   (0x30 0x31), protocolVersionLength = 2
```

| Stream | Opened by | Preamble | Payload |
| --- | --- | --- | --- |
| **Control** | client, **first stream on the connection** | **none at all** | Cap'n Proto RPC immediately |
| RPC (UDP session mgmt) | client | 6-byte RPC signature only, **no version** | Cap'n Proto RPC |
| Data request | edge | data signature + `"01"` | capnp `ConnectRequest`, then raw body bytes |
| Data response | client, same stream | data signature + `"01"` **again** | capnp `ConnectResponse`, then raw body bytes |

Incoming streams are dispatched by reading the first 6 bytes and matching a signature (`tunnelrpc/quic/cloudflared_server.go` → `Serve`).

### Two traps

**1. The control stream carries no signature and no version byte.** `connection/quic_connection.go` opens it with `q.conn.OpenStream()` and hands it straight to `tunnelrpc.NewRegistrationClient`, which wraps it in a capnp transport. No signature is ever written. Grep the pinned tree for `rpcStreamProtocolSignature` — it appears only in `protocol.go` and the session/cloudflared client-server files, never in the registration path.

> This is the single most likely first-attempt failure. If registration hangs or the edge closes the stream immediately, check this first.

**2. Write the 8-byte data-stream preamble in a single `write_all`.** Upstream's `readVersion` uses a bare `stream.Read(version)` rather than `io.ReadFull`, so a peer that splits the two version bytes across packets desyncs the reader. Don't be that peer.

### Length framing

There is **no custom length prefix**. Framing is Cap'n Proto's standard **unpacked** stream framing, from `capnp.NewEncoder(w).Encode(msg)`:

```
uint32 LE  segmentCount - 1
uint32 LE  size in words, per segment
uint32     padding, only when segmentCount is even
           segment data
```

No packing, no compression.

## 7. Message schemas — Cap'n Proto

> `tunnelrpc/proto/quic_metadata_protocol.capnp` — reproduced in full

```capnp
struct ConnectRequest @0xc47116a1045e4061 {
	dest @0 :Text;
	type @1 :ConnectionType;
	metadata @2 :List(Metadata);
}

enum ConnectionType @0xc52e1bac26d379c8 {
	http @0;
	websocket @1;
	tcp @2;
}

struct Metadata @0xe1446b97bfd1cd37 {
	key @0 :Text;
	val @1 :Text;
}

struct ConnectResponse @0xb1032ec91cef8727 {
	error @0 :Text;
	metadata @1 :List(Metadata);
}
```

Messages are **single-segment** (`capnp.SingleSegment(nil)`) with the struct as root.

> ⚠️ **Everything structured in this protocol is Cap'n Proto. There is no msgpack anywhere.** Several third-party write-ups of this protocol describe the per-stream body as msgpack — they are wrong. `rmp-serde` is not a dependency of `crates/protocol`.

### Metadata keys

> `connection/quic_connection.go` → `HTTPHeaderKey`, `HTTPMethodKey`, `HTTPHostKey`, `HTTPStatus`, `QUICMetadataFlowID`

| Key | Direction | Meaning |
| --- | --- | --- |
| `HttpMethod` | request | HTTP method |
| `HttpHost` | request | value for the `Host` header |
| `HttpStatus` | response | status code as a decimal string |
| `HttpHeader:<Name>` | both | **one entry per header value**; repeated headers produce repeated entries |
| `FlowID` | request | tracing correlation |

`ConnectRequest.dest` is the **full request URL** for `http`/`websocket`, and an `addr:port` parseable as `netip::AddrPort` for `tcp`.

The edge may also send `FlowConnectRateLimited: "true"` (`tunnelrpc/pogs/quic_metadata_protocol.go` → `ErrorFlowConnectRateLimitedMetadata`) — surface this distinctly, since it means the edge rate-limited the flow rather than the origin failing.

## 8. Registration RPC

Cap'n Proto RPC — two-party vat, Level 1, standard `rpc.capnp`. The **edge** exports the interface; the client calls `bootstrap` on the control stream and invokes methods on the result.

> `tunnelrpc/proto/tunnelrpc.capnp`

```capnp
struct ClientInfo @0x83ced0145b2f114b {
    clientId @0 :Data;        # connector UUID, 16 raw bytes
    features @1 :List(Text);
    version @2 :Text;
    arch @3 :Text;
}

struct ConnectionOptions @0xb4bf9861fe035d04 {
    client @0 :ClientInfo;
    originLocalIp @1 :Data;
    replaceExisting @2 :Bool;
    compressionQuality @3 :UInt8;
    numPreviousAttempts @4 :UInt8;
}

struct ConnectionResponse @0xdbaa9d03d52b62dc {
    result :union {
        error @0 :ConnectionError;
        connectionDetails @1 :ConnectionDetails;
    }
}

struct ConnectionError @0xf5f383d2785edb86 {
    cause @0 :Text;
    retryAfter @1 :Int64;     # NANOSECONDS
    shouldRetry @2 :Bool;
}

struct ConnectionDetails @0xb5f39f082b9ac18a {
    uuid @0 :Data;
    locationName @1 :Text;             # colo airport code
    tunnelIsRemotelyManaged @2 :Bool;
}

struct TunnelAuth @0x9496331ab9cd463f {
    accountTag @0 :Text;
    tunnelSecret @1 :Data;
}

interface RegistrationServer @0xf71695ec7fe85497 {
    registerConnection @0 (auth :TunnelAuth, tunnelId :Data, connIndex :UInt8, options :ConnectionOptions) -> (result :ConnectionResponse);
    unregisterConnection @1 () -> ();
    updateLocalConfiguration @2 (config :Data) -> ();
}
```

Vendor the upstream `.capnp` files into `crates/protocol/schema/` unmodified and generate with `capnpc`. The deprecated legacy section of `tunnelrpc.capnp` (`TunnelServer.registerTunnel`, `Authentication`, `RegistrationOptions`, …) must be kept verbatim if you vendor the file, because type IDs matter — but none of it is called.

### The interfaceId quirk

> `tunnelrpc/pogs/registration_server.go` → `RegisterConnection`

cloudflared does **not** call these methods on `RegistrationServer`. It wraps the capability as `proto.TunnelServer` and calls through that, because `TunnelServer extends (RegistrationServer)`:

```go
func (c RegistrationServer_PogsClient) RegisterConnection(...) {
	client := proto.TunnelServer{Client: c.Client}
	promise := client.RegisterConnection(ctx, ...)
```

So the call on the wire carries **`interfaceId = 0xea58385c65416035` (`TunnelServer`)**, method `0`. A schema-driven Rust client will emit `0xf71695ec7fe85497` (`RegistrationServer`) instead.

**Send `0xea58385c65416035` to match cloudflared byte-for-byte.** Whether the edge also accepts the `RegistrationServer` ID is unverified — resolve it in the spike and record the answer in §12. Method IDs: `registerConnection` 0, `unregisterConnection` 1, `updateLocalConfiguration` 2.

### Argument wire forms

> `tunnelrpc/pogs/registration_server.go`; `connection/connection.go` → `Credentials.Auth`

| Field | Type | Form |
| --- | --- | --- |
| `auth.accountTag` | Text | the token's `a` value, unchanged |
| `auth.tunnelSecret` | Data | **raw decoded bytes** of the token's `s` (base64-decoded first), ≥32 |
| `tunnelId` | Data | **the 16 raw UUID bytes** (`tunnelID[:]`), *not* the dashed string |
| `connIndex` | UInt8 | `0..N-1` |
| `options` | struct | see §10 |

RPC timeout is 5 s (`--rpc-timeout`, `cmd/cloudflared/tunnel/cmd.go` → `RpcTimeout`).

### Response handling

> `tunnelrpc/registration_client.go`; `connection/errors.go` → `DuplicateConnectionError`

On the `error` branch: `retryAfter` is a **nanosecond** count (a Go `time.Duration`), and `shouldRetry` gates whether to retry at all. `cause == "EDUPCONN"` means this edge address already has this connection index registered — **rotate to a different edge address**, do not simply retry. Upstream also treats a cause containing `"Unauthorized"` as transient, because a freshly created tunnel takes time to propagate across the edge (`supervisor/supervisor.go`) — retry rather than failing the user.

On the `connectionDetails` branch, `locationName` is the colo airport code; surface it, since it is genuinely useful to users debugging latency.

### Transport wrapper

> `tunnelrpc/utils.go` → `SafeTransport`

Upstream wraps the stream so temporary read/write errors are retried up to 3 times with 500 ms between attempts before surfacing. Mirror this leniency or you will drop connections on transient stream errors.

## 9. Local configuration push

> `connection/control.go`

Only connection index 0, and only when `ConnectionDetails.tunnelIsRemotelyManaged` is false, sends `updateLocalConfiguration(configJson)`.

**NPort's tunnels are created with `config_src: "cloudflare"`** (remotely managed) by `apps/api`, so `tunnelIsRemotelyManaged` will be true and this call is skipped entirely. Routing is DNS CNAME plus the connector's own local ingress decision. Implement the method for completeness, expect never to call it.

## 10. Features and client identity

> `features/features.go` → `defaultFeatures`; `client/config.go`

The default feature list — sufficient for NPort:

```
allow_remote_config
serialized_headers
support_datagram_v2
support_quic_eof
management_logs
```

Order is nondeterministic upstream (it comes from Go map iteration), so the edge cannot be order-sensitive. `postquantum` is added only with `--post-quantum`. `support_datagram_v3_2` is opted into by percentage from the `cfd-features` TXT record. `support_datagram_v3` and `support_datagram_v3_1` are **retired** — upstream silently strips them.

`ClientInfo`:

| Field | Value |
| --- | --- |
| `clientId` | 16 raw bytes of a **random v4 UUID generated once per process** — the connector ID, *not* the tunnel ID |
| `version` | free-form text; upstream releases use `YYYY.M.P`, in-tree default `"DEV"`. NPort sends `nport/<semver>` |
| `arch` | `<os>_<arch>`, e.g. `darwin_arm64`, `linux_amd64` |
| `features` | the list above |

`ConnectionOptions`: `originLocalIp` is the local address bytes (4 or 16, best-effort), `replaceExisting` is hardcoded `false`, `compressionQuality` hardcoded `0`, `numPreviousAttempts` is the retry count for that connection index.

### Datagrams — out of scope

UDP and ICMP tunnelling (datagram v2 and v3) are **not implemented in NPort 3.0**. Advertise `support_datagram_v2` and never send or expect a datagram. This removes the `SessionManager` RPC surface, session registration, and both datagram framings — a large fraction of the protocol.

Recorded as a non-goal in `docs/ARCHITECTURE.md` §9. If it is ever added, the relevant upstream files are `quic/datagram.go`, `quic/datagramv2.go`, and `quic/v3/{datagram,request,muxer}.go`; note that v2 **suffixes** its metadata (`payload || sessionID(16) || type(1)`) while v3 **prefixes** a type byte.

## 11. Proxying an exchange

Once registered, the edge opens a bidirectional stream per request:

```
edge   → client:  0A 36 CD 12 A1 3E | "01" | capnp ConnectRequest
edge   → client:  raw request body bytes, on the same stream
client → edge:    0A 36 CD 12 A1 3E | "01" | capnp ConnectResponse
client → edge:    raw response body bytes, on the same stream
```

**There is no HTTP/1.1 request line or header block on the stream.** Headers travel entirely inside `ConnectRequest.metadata`. Reconstruct the request from `dest` (URL), `HttpMethod`, `HttpHost`, and the `HttpHeader:*` entries.

### Bodies

Bodies are **raw byte streams with no tunnel-layer framing**. `Content-Length` and `Transfer-Encoding` are just metadata entries. **End of body is QUIC stream FIN** — half-close the send side when the body ends.

Upstream strips the body entirely when the request is not a WebSocket, is not chunked, and has `ContentLength == 0`, to stop Go's client emitting a spurious chunked body (`connection/quic_connection.go` → `buildHTTPRequest`).

### WebSockets

`ConnectRequest.type == websocket (1)`. Upstream strips the internal upgrade header and re-adds real ones toward the origin — `Connection: Upgrade`, `Upgrade: websocket`, `Sec-Websocket-Version: 13`, `ContentLength = 0` (`proxy/proxy.go`). The response is an ordinary `ConnectResponse` carrying `HttpStatus: 101` plus `HttpHeader:Sec-Websocket-Accept`, after which **the stream is a raw bidirectional byte pipe** and WebSocket frames pass through untouched.

### Streaming and SSE

On QUIC, flushing is a **no-op** — upstream comments that QUIC streams need no flush at this layer. The rule for Rust: **never buffer writes toward the edge; write through.** A buffered writer will stall SSE and gRPC streaming in ways that are miserable to debug.

Content types upstream treats as flush-always: `text/event-stream`, `application/grpc`, `application/x-ndjson`, plus any response with no `Content-Length` (`connection/connection.go` → `shouldFlush`).

### Errors and cancellation

A failure before the response is written becomes a `ConnectResponse` with `error` set and `HttpStatus: 502`. A failure *after* the response started becomes `CancelWrite(0)` → `RST_STREAM` with application error code 0.

### TCP

`ConnectRequest.type == tcp (2)`: `dest` parses as `addr:port`, and the client acknowledges with an empty-metadata `ConnectResponse` before piping bytes. **Not used by NPort 3.0** (HTTP and WebSocket only) but trivial once the rest works.

## 12. Liveness and shutdown

There is **no application-level heartbeat**. Liveness is purely QUIC keep-alive: 1 s ping, 5 s idle timeout.

> Do not confuse this with NPort's own lease heartbeat to `api.nport.link`, which is a separate 30 s application concern — see `docs/ARCHITECTURE.md` §3c.

Reconnection classification (`supervisor/tunnel.go`):

| Condition | Action |
| --- | --- |
| QUIC idle timeout | rotate to a different edge address |
| `EDUPCONN` | rotate to a different edge address |
| dial error | rotate; after `--max-edge-addr-retries` (default 8) fall back to HTTP/2 |
| cause contains `Unauthorized` | retry — the tunnel may still be propagating |

Graceful shutdown (`connection/control.go`, `connection/quic_connection.go`):

1. call `unregisterConnection()`, bounded by the grace period
2. **keep the QUIC connection open for the whole grace period** to drain in-flight requests
3. `CloseWithError(0, "")`

Grace period default **30 s**, hard maximum **3 min** (`MaxGracePeriod`). NPort's CLI should use a shorter default — a developer pressing Ctrl+C expects a prompt exit — and document it. `crates/core` must make this a config value, not a constant.

## 13. Transport B — HTTP/2 fallback

`--protocol http2` is fully supported in the pinned commit and is cloudflared's **own automatic fallback** from QUIC. `h2mux` is removed; requesting it silently upgrades to http2.

This is NPort's **Fallback 1** (see `docs/ROADMAP.md`): it shares the entire registration, capnp, and metadata layer with QUIC and needs no QUIC stack, sidestepping post-quantum TLS, datagrams, and `quinn`↔`quic-go` interop in one move. Implement `crates/protocol/src/h2.rs` behind the same `Transport` trait.

### Inverted roles

> `edgediscovery/dial.go` → `DialEdge`; `connection/http2.go`

The client dials TCP+TLS to the edge (SNI **`h2.cftunnel.com`**, 15 s timeout, no forced ALPN) and then **runs an HTTP/2 server on that socket**. The edge sends requests to the client. No h2c upgrade, no client preface from the connector's side. `MaxConcurrentStreams` is `math.MaxUint32`.

In Rust: `h2::server::handshake` on a client-side `TlsStream`. `hyper`'s high-level API resists this; use `h2` directly.

### Stream dispatch

> `connection/http2.go` → `determineHTTP2Type`, `InternalUpgradeHeader`, `InternalTCPProxySrcHeader`

| Header | Value | Stream type |
| --- | --- | --- |
| `Cf-Cloudflared-Proxy-Connection-Upgrade` | `control-stream` | control — **capnp RPC, no preamble** |
| `Cf-Cloudflared-Proxy-Connection-Upgrade` | `websocket` | WebSocket |
| `Cf-Cloudflared-Proxy-Connection-Upgrade` | `update-configuration` | config push |
| `Cf-Cloudflared-Proxy-Src` | non-empty | TCP proxy |
| *(none of the above)* | | plain HTTP |

The control stream is the h2 stream whose request carries `control-stream`; its body is the same Cap'n Proto RPC, again **with no signature or version preamble**.

### Header conventions

> `connection/header.go`

Request metadata rides as ordinary h2 headers. Responses serialize origin headers into a single header value:

```
Cf-Cloudflared-Response-Headers: b64(name):b64(value);b64(name):b64(value)
```

using `base64.RawStdEncoding` — standard alphabet, **no padding**. Excluded from serialization: anything starting with `:`, `cf-int-`, `cf-cloudflared-`, or `cf-proxy-`. WebSocket handshake headers (`sec-websocket-accept`, `connection`, `upgrade`) are preserved. `content-length` is also emitted as a real h2 header.

`Cf-Cloudflared-Response-Meta` carries `{"src":"origin"}`, `{"src":"cloudflared"}`, or `{"src":"cloudflared","flow_rate_limited":true}` — distinguishing an origin response from one the connector synthesized.

**HTTP 101 is rewritten to 200**, because HTTP/2 removed 101 (RFC 7540 §8.1.1). Errors become **502**.

Note `cf-cloudflared-request-headers` is declared upstream but no longer read — the request direction uses plain h2 headers.

## 14. Rust implementation map

| Protocol element | Module | Tests |
| --- | --- | --- |
| Token parse, redaction, zeroize | `src/token.rs` | unit + a test asserting `Debug` never leaks |
| SRV/DoT/A discovery, address pool | `src/edge.rs` | unit with a stub resolver |
| QUIC dial, TLS, transport params | `src/quic.rs` | integration, live edge |
| HTTP/2 dial and h2 server | `src/h2.rs` | integration, live edge |
| Signatures, version, capnp framing | `src/connect.rs` | `insta` snapshots + golden fixtures + `proptest` roundtrip |
| capnp RPC registration | `src/rpc/` | integration, live edge |
| `Transport` trait, shared by quic/h2 | `src/lib.rs` | — |

Crates: `quinn`, `rustls` + `rustls-platform-verifier`, `capnp` + `capnpc`, `capnp-rpc`, `h2`, `hickory-resolver`, `base64`, `serde`/`serde_json`, `uuid`, `zeroize`. **No msgpack.**

`#![forbid(unsafe_code)]` — a network-facing protocol client has no need for `unsafe`.

## 15. Conformance and fixtures

Golden byte fixtures live in `crates/protocol/tests/fixtures/` and are the regression net for every framing change. See `docs/TESTING.md` for how to capture and review them.

"Conformant" means: every frame type has a golden fixture asserted byte-identical; `insta` snapshots cover every encoder; `proptest` roundtrips every codec; and the live-edge integration suite passes the five G1 criteria in `docs/ROADMAP.md`.

## 16. Known risks

| # | Risk | Mitigation |
| --- | --- | --- |
| P1 | `capnp-rpc` ↔ `zombiezen/go-capnproto2` interop is unexercised by anyone | Both implement standard `rpc.capnp` Level 1. Escape hatch: the surface is one bootstrap + 3 methods, so hand-encoding `bootstrap`/`call`/`return`/`finish` is tractable |
| P2 | `interfaceId` ambiguity (§8) | Send `0xea58385c65416035`; resolve empirically in the spike |
| P3 | Post-quantum key exchange may be required | Try classical first, add `X25519MLKEM768` if rejected |
| P4 | Version byte `"01"` is a deliberate silent-change hook — upstream comments it as a no-op branch point | `protocol-canary.yml` detects a bump within 6 h |
| P5 | Two TXT kill-switches let the edge change client expectations with no cloudflared release | Read `protocol-v2.argotunnel.com`; canary catches the rest |
| P6 | The SRV name is already at `v2`; a `v3` rename is plausible | Canary; keep discovery in one module |
| P7 | Upstream runs a quic-go **fork**, so edge behaviour may depend on non-upstream QUIC details | Unknowable from source; canary is the only detector |
| P8 | **Legal:** Apache-2.0 covers the client source, but the *edge service* is governed by [cloudflare.com/terms](https://www.cloudflare.com/terms/). The client licence does not by itself authorize connecting a non-Cloudflare client. No technical anti-third-party-client measure exists in the source | Accepted risk, ADR-0002. Maintainer's decision, not a code question |

## 17. Open questions

Unresolvable from source. The Phase 1 spike must answer these; record answers here with the date.

1. Does the edge dispatch `registerConnection` on `0xea58385c65416035` (`TunnelServer`), `0xf71695ec7fe85497` (`RegistrationServer`), or both? — **unanswered**
2. Is a minimum `ClientInfo.version` enforced? Are unknown feature strings rejected? — **unanswered**
3. Does the edge accept a classical-only key exchange (no PQ group)? — **unanswered**
4. What is the full set of `ConnectionError.cause` values? Only `EDUPCONN` and substring `Unauthorized` are handled upstream. — **unanswered**
5. Are there per-account connection-count or registration rate limits? — **unanswered**
6. Does the edge *require* the data-stream preamble on `ConnectResponse`, or merely tolerate it? cloudflared always writes it. — **unanswered**
