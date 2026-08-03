---
applies_to:
  - packages/contract/src/errors.ts
  - apps/api/src/errors.ts
  - crates/cli/src/i18n/**
---

# Error registry

Every error NPort can return or raise, with a stable code.

> **This file will be generated** from `packages/contract/src/errors.ts` by `pnpm codegen` once Phase 1.5 lands. Until then it is hand-written and is the draft the registry will be built from. Once generation is wired up, edit `errors.ts` and regenerate — never edit this file directly.

Four consumers reference these codes by anchor, which is why they live in one registry rather than inline in `docs/API.md`: the Rust CLI (to pick a translated message and a hint), the Hono error handler (to pick a status), the website's `/errors/[code]` pages, and the GitHub issue templates.

**Clients match on `code`. Messages are free to change and are translated per ADR-0018.**

## Response shape

```jsonc
{
  "error": {
    "code": "SUBDOMAIN_IN_USE",
    "message": "…",
    "details": { },
    "requestId": "…",
    "docsUrl": "https://nport.link/errors/subdomain-in-use"
  }
}
```

## Server errors

`docsUrl` is `https://nport.link/errors/<code lowercased, underscores → hyphens>`.

| Code | Status | Retry | Cause | What the user should do |
| --- | --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | no | Body is not valid JSON, or fails schema validation | Upgrade the client; this is a bug if it happens from an official build |
| `INVALID_SUBDOMAIN` | 400 | no | Fails normalization or validation (`docs/ARCHITECTURE.md` §7). `details.reason` distinguishes length, charset, leading/trailing hyphen, and punycode-like patterns | Choose a name of 3–63 characters using `a-z`, `0-9`, and `-` |
| `POW_INVALID` | 400 | no | Nonce does not satisfy the challenge, or the challenge HMAC does not verify | Re-fetch a challenge and re-solve; a client bug if repeated |
| `POW_REQUIRED` | 428 | no | Create attempted with no challenge | Client bug — fetch `/v1/challenge` first |
| `CHALLENGE_EXPIRED` | 400 | yes | Challenge is past its validity window | Fetch a new challenge |
| `SUBDOMAIN_RESERVED` | 403 | no | Name is on the reserved list | Choose another name |
| `INVALID_OWNER_TOKEN` | 403 | no | Missing or non-matching `ownerToken` | Only the creator can modify a lease. Wait for expiry |
| `TUNNEL_NOT_FOUND` | 404 | no | No lease for that subdomain | Nothing to do; it may already have expired |
| `SUBDOMAIN_IN_USE` | 409 | no | Lease is `ACTIVE` and held by someone else | Choose another name, or wait for `details.expiresAt` |
| `DNS_CONFLICT` | 409 | no | A DNS record exists that NPort cannot prove it owns — wrong type, or content not `<tunnel_id>.cfargotunnel.com` | Choose another name. **Operator action required**; see `docs/OPERATIONS.md` |
| `LEASE_EXPIRED` | 410 | no | The lease existed but has expired | Create a new tunnel |
| `CLIENT_TOO_OLD` | 426 | no | Below `MIN_CLIENT_VERSION` | Upgrade. `details.minimumVersion` says the floor |
| `RATE_LIMITED` | 429 | yes | Per-source request limit exceeded | Honour `Retry-After` |
| `CONCURRENCY_LIMIT` | 429 | yes | Too many simultaneous leases from this source | Close an existing tunnel |
| `CREATE_QUOTA_EXCEEDED` | 429 | yes | Hourly create cap for this source | Wait; `details.resetAt` |
| `UPSTREAM_CLOUDFLARE_ERROR` | 502 | yes | The Cloudflare API failed or timed out. **Raw upstream text is never included** | Retry with backoff. Quote `requestId` if persistent |
| `CAPACITY_EXHAUSTED` | 503 | yes | Global active-tunnel cap reached | Retry later |
| `PROVISION_FAILED` | 500 | yes | The saga could not complete and was compensated. No orphan remains | Retry. Quote `requestId` |
| `INTERNAL` | 500 | yes | Unhandled. Never leaks detail | Report with `requestId` |

### Notes

`DNS_CONFLICT` is the only code that signals a possible operational problem rather than user error. It fires when a DNS record exists for a name whose lease is free, meaning a previous teardown failed permanently or something outside NPort created the record. **Reconciliation deliberately does not force-delete these** — see invariant 8. Triage is in `docs/OPERATIONS.md`.

`PROVISION_FAILED` guarantees compensation ran or is queued via the DO alarm. It never means "you may have a half-created tunnel".

## Client errors

Raised locally by `crates/cli` and `crates/core`. They never cross the network, but they share the registry so every failure the user can see has a stable code, a translation key, and a docs anchor.

| Code | Cause | What the user should do |
| --- | --- | --- |
| `LOCAL_PORT_CLOSED` | Nothing is listening on the requested port | Start the local server first. Checked **before** provisioning, so no tunnel is wasted |
| `LOCAL_PORT_INVALID` | Port is not in `1..=65535` | Fix the argument |
| `CONFIG_UNREADABLE` | `~/.nport/config.toml` exists but cannot be parsed | Fix or delete it; the path is in `details` |
| `CONFIG_UNWRITABLE` | Cannot write the config directory | Check permissions on `~/.nport` |
| `EDGE_DISCOVERY_FAILED` | No edge address resolved | Check DNS and outbound UDP/TCP on 7844 |
| `EDGE_CONNECT_FAILED` | All edge addresses refused or timed out | Often a firewall blocking UDP 7844. Suggest `--transport http2` |
| `EDGE_REGISTRATION_REFUSED` | The edge rejected `registerConnection`. `details.cause` carries the upstream cause | If `EDUPCONN`, retried automatically. Otherwise likely an expired token |
| `EDGE_PROTOCOL_ERROR` | A frame could not be parsed, or the version byte is not `01` | **Likely a Cloudflare protocol change.** Tell the user to upgrade and link the issue tracker |
| `TUNNEL_LOST` | All edge connections dropped and reconnection was exhausted | Check the network; the CLI exits non-zero |
| `LOCAL_REQUEST_FAILED` | The local server refused or reset a proxied request | The tunnel is fine; the local app is not |
| `SHUTDOWN_TIMEOUT` | Graceful shutdown exceeded its deadline | Informational; the lease still expires server-side |

`EDGE_PROTOCOL_ERROR` is the one to watch. It is the user-visible symptom of the highest-blast-radius failure in the system (`docs/ARCHITECTURE.md` §5) and should be worded to send people to the issue tracker rather than to their own network config.

## Adding an error

1. Add it to `packages/contract/src/errors.ts` with its code, HTTP status, retryability, and a default English message.
2. `pnpm codegen` — regenerates this file, `crates/contract`, and the website's error page.
3. Add translations for `vi` and `es` in `crates/cli`.
4. Add a test asserting the code round-trips.

Do not add an error whose only difference from an existing one is wording. A code is a contract clients branch on; a message is not.

## Retired v2 error strings

v2 had no codes. For anyone reading old issues or v2 source, the mapping is:

| v2 string the CLI matched | v3 code |
| --- | --- |
| `SUBDOMAIN_PROTECTED:` | `SUBDOMAIN_RESERVED` |
| `SUBDOMAIN_IN_USE:`, `currently in use`, `already exists and is currently active` | `SUBDOMAIN_IN_USE` |
| `already have a tunnel`, `[1013]` | `CONCURRENCY_LIMIT` |
| `CF API Error: […]` echoed verbatim | `UPSTREAM_CLOUDFLARE_ERROR` |
| a bare `SyntaxError` from `request.json()` | `INVALID_REQUEST` |

Every one of those arrived as **HTTP 500**.
