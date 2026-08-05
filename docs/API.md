---
applies_to:
  - apps/api/src/**
  - packages/contract/src/**
---

# Control-plane API

`https://api.nport.link` — the Worker in `apps/api`. It provisions and reaps tunnels. **It is not on the tunnel data path** (`docs/ARCHITECTURE.md` §3b).

**Status: design. Not implemented.**

## Authority

**This document does not define field types.** `packages/contract` is the authority; it generates `schema/nport-api.openapi.json`, which generates `crates/contract`. Field-level truth is the OpenAPI document, rendered on the website.

That is deliberate: v2's `docs/API.md` restated every field in prose tables and drifted immediately — it documented `subdomain` and `tunnelId` as required for DELETE when both were optional in the type. This file covers what OpenAPI cannot express: lifecycle, semantics, idempotency, and intent.

## Versioning

All endpoints live under `/v1`. A breaking change means `/v2` alongside it, not a mutation of `/v1`.

Legacy v2 clients are served by a compatibility shim (see below).

## No authentication

There are no accounts, no API keys, no bearer tokens (ADR-0007). Anyone can create a tunnel.

Ownership of an existing tunnel is a different question, and it *is* verified: create returns a 256-bit `ownerToken`, once, and every subsequent operation on that lease requires it. The server stores only its SHA-256. This closes v2's hole, where `DELETE` accepted any `{subdomain, tunnelId}` pair from anyone with no relationship check — including for the `api` subdomain itself.

**No CORS headers are sent, by design.** No browser page can drive this API. Do not add CORS "for convenience"; it is an abuse control.

## Client requirements

| Requirement | Detail |
| --- | --- |
| `User-Agent` | `nport/<version> (<os>; <arch>)` |
| `X-NPort-Client` | client kind: `cli`, `desktop` |
| Minimum version | Below `MIN_CLIENT_VERSION` → `426 CLIENT_TOO_OLD` |
| Content type | `application/json` on requests with bodies |

The minimum-version gate exists because we now own the connector protocol: if Cloudflare's edge changes, old clients break in ways only a new binary can fix, and the API is the only place to tell them so.

## Lifecycle

```
                    ┌──────────────────────────────────┐
                    ▼                                  │
  ┌──────┐   POST /v1/tunnels    ┌────────┐            │
  │ FREE │ ────────────────────► │ ACTIVE │ ── heartbeat every 30s
  └──────┘   (+ challenge, PoW)  └────────┘
     ▲                             │    │
     │  DELETE /v1/tunnels/:sub    │    │  no heartbeat for 120s
     └─────────────────────────────┘    │  or expires_at reached
     │                                  ▼
     └──────────── DO alarm: teardown ──┘
```

1. `GET /v1/challenge` — obtain a proof-of-work challenge.
2. `POST /v1/tunnels` — solve it, claim a subdomain, receive the tunnel token and `ownerToken`.
3. Connect to the edge using the tunnel token (`docs/PROTOCOL.md`).
4. `POST /v1/tunnels/:subdomain/heartbeat` every 30 s.
5. `DELETE /v1/tunnels/:subdomain` on shutdown.

Skipping step 5 is safe — the lease expires on its own. Skipping step 4 kills the tunnel within 120 s.

## Endpoints

| Method | Path | Purpose | Needs `ownerToken` |
| --- | --- | --- | --- |
| `GET` | `/v1/challenge` | Issue a proof-of-work challenge | no |
| `POST` | `/v1/tunnels` | Claim a subdomain and provision a tunnel | no |
| `POST` | `/v1/tunnels/:subdomain/heartbeat` | Renew the lease | **yes** |
| `DELETE` | `/v1/tunnels/:subdomain` | Release the lease and tear down | **yes** |
| `GET` | `/v1/tunnels/:subdomain` | Public status: exists, expires-at. No secrets. | no |
| `GET` | `/v1/meta` | Limits, `MIN_CLIENT_VERSION`, reserved-name policy | no |
| `GET` | `/v1/health` | Liveness for monitoring | no |
| `GET` | `/` | 301 → `https://nport.link` | no |

### `GET /v1/challenge`

Returns an HMAC'd, stateless, time-bounded challenge plus a difficulty. Nothing is stored server-side — the challenge carries its own integrity, so this endpoint costs one HMAC and cannot be exhausted.

Difficulty is raised dynamically under load, which is the lever to pull during an abuse event (`docs/OPERATIONS.md`).

### `POST /v1/tunnels`

The only expensive endpoint: it validates, claims a lease, and makes ~4 Cloudflare API calls.

Request carries the requested `subdomain` (optional — omitted means generate one), the solved challenge and nonce, and client identification. Response carries the public `url`, the `tunnelToken`, the `ownerToken`, and `expiresAt`.

Behaviour worth knowing:

- The subdomain is **normalized before validation and before use as a DO key** (`docs/ARCHITECTURE.md` §7). `MyApp`, `myapp`, and `myapp.nport.link` are the same claim.
- Generated names are `nport-<base32(8 random bytes)>`, not a timestamp or a 4-digit number.
- Concurrent claims for the same name **serialize** through one Durable Object; the loser gets `409 SUBDOMAIN_IN_USE`. There is no race.
- Provisioning is a journaled saga. A partial failure compensates rather than leaving an orphan.
- **`tunnelToken` and `ownerToken` are returned exactly once and never retrievable again.** Losing them means waiting for expiry.

### `POST /v1/tunnels/:subdomain/heartbeat`

Cheap and frequent — one DO call, no Cloudflare API traffic. Records `last_heartbeat_at`, re-arms the alarm, returns the current `expiresAt` so the client can correct its countdown.

The server is authoritative for expiry. A client that stops heartbeating loses its tunnel; a client that keeps heartbeating past `expiresAt` still loses it. v2's four-hour limit was a client-side `setTimeout` and trivially bypassed.

### `DELETE /v1/tunnels/:subdomain`

Idempotent. Deleting an already-released lease is `204`, not an error — a client retrying after a network blip must not see a failure.

Deletion verifies the DNS record is a `CNAME` pointing at exactly `<tunnel_id>.cfargotunnel.com` before removing it. A mismatch is `409 DNS_CONFLICT` and a log line, never a delete.

### `GET /v1/meta`

Lets clients discover limits instead of hardcoding them, so caps can be tuned without a client release. Returns current caps, PoW difficulty, `MIN_CLIENT_VERSION`, and the tunnel duration.

## Idempotency and retries

| Endpoint | Safe to retry | Notes |
| --- | --- | --- |
| `GET /v1/challenge` | yes | stateless |
| `POST /v1/tunnels` | **no** | may create a second tunnel. Retry only on 429/503 after `Retry-After`, or on a network error where no response was seen — and then only with a fresh challenge |
| heartbeat | yes | idempotent |
| `DELETE` | yes | idempotent |
| `GET` reads | yes | |

Every `429` and `503` carries `Retry-After`. Honour it; do not implement a tighter retry loop than the server asks for.

## Errors

Every error response is:

```jsonc
{
  "error": {
    "code": "SUBDOMAIN_IN_USE",       // stable enum — match on this
    "message": "…",                    // human-readable, may change freely
    "details": { },                    // optional, code-specific
    "requestId": "…",                  // quote this in bug reports
    "docsUrl": "https://nport.link/errors/subdomain-in-use"
  }
}
```

**Match on `code`. Never on `message`.** Codes and statuses are in `docs/ERRORS.md`, generated from the registry in `packages/contract`. ADR-0018 explains why this matters: v2 returned HTTP 500 for everything and the CLI matched substrings like `'currently in use'` and `'[1013]'`.

Raw Cloudflare API errors are never surfaced. They map to `502 UPSTREAM_CLOUDFLARE_ERROR` with a `requestId`, and detail goes only to Workers logs — v2 echoed CF error text, leaking account and zone internals to anonymous callers.

## Rate limits

Concrete numbers live in `GET /v1/meta` and `docs/OPERATIONS.md`, not here, because they are tuned in production. Shape:

- Zone-level Cloudflare rate limiting on the hostname
- Per-source limits keyed on `HMAC(ip, rotating_secret)` + ASN — **raw IPs are never stored**
- Proof-of-work on create
- Per-source concurrent-lease and hourly-create caps
- A global active-tunnel cap → `503 CAPACITY_EXHAUSTED`

## Legacy v2 compatibility

v2 clients dispatch on method against `/` with no path routing: `POST /` creates, `DELETE /` deletes, `GET /` redirects. A shim preserves exactly that, translating to the v1 handlers.

Two v2 behaviours are **deliberately not preserved**, because they were the bugs:

- v2's create would take over a subdomain whose tunnel looked inactive, deleting the incumbent's records. The shim returns `409` instead.
- v2's delete accepted any `{subdomain, tunnelId}` pair. The shim cannot verify ownership for clients that never received an `ownerToken`, so it deletes only leases created through the shim itself and matching the caller's source hash. That hash is keyed on an IPv6 **prefix** rather than a full address (ADR-0033), so for an IPv6 client the delete is authorized to its /64 rather than to one machine. It is the weakest authorization in the API, it is still strictly stronger than v2's, and it is one of the reasons `docs/RELEASE.md` sunsets the shim.

Sunset schedule in `docs/RELEASE.md`.

## Self-hosting

The API is deployable to any Cloudflare account; clients point at it with `--backend`. See `docs/SELF_HOSTING.md`.
