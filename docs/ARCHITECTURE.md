---
applies_to:
  - apps/api/src/**
  - crates/core/src/**
  - packages/contract/src/**
---

# Architecture

How NPort v3 works. For *why* it is built this way, see `docs/DECISIONS.md`. For the connector wire protocol, see `docs/PROTOCOL.md`.

**Status: design. Nothing in this document is implemented yet.**

## 1. System context

```
┌─ developer's machine ────────────┐         ┌─ Cloudflare ──────────────┐
│                                  │         │                           │
│  localhost:3000 ◄── nport CLI ───┼── QUIC ─┼─► edge (7844)             │
│                    or desktop    │         │     │                     │
│                        │         │         │     ├─ Tunnel <uuid>      │
└────────────────────────┼─────────┘         │     └─ DNS CNAME          │
                         │                   │        myapp.nport.link   │
                         │ HTTPS             │                           │
                         └───────────────────┼─► api.nport.link          │
                                             │     (nport-api Worker)    │
   end user ─── https://myapp.nport.link ────┼─► edge ──► the tunnel     │
                                             └───────────────────────────┘
```

| Actor | Trust | Notes |
| --- | --- | --- |
| Developer running the CLI | untrusted | Anonymous. No account exists to authenticate. |
| End user of a tunnel URL | untrusted | Never touches NPort infrastructure; the edge routes them straight to the tunnel. |
| `api.nport.link` | trusted | Holds the Cloudflare API token. The only component with credentials. |
| Cloudflare edge + API | external dependency | Provides TLS, DNS, DDoS protection, and the data plane. |

**The trust boundary that matters:** because there are no accounts, `apps/api` cannot authenticate *who* is asking. It can only make claims verifiable and make abuse expensive. Every design decision in §7 follows from that.

**The control plane never sees tunnel traffic.** Request bodies flow edge → connector → localhost; provisioning and reaping are the whole of its involvement, and no byte of a request transits a Worker (§3b).

**That is not the same as nobody seeing it.** The hostname lives in a Cloudflare zone, Cloudflare terminates TLS there, and the account that owns the zone can attach a Worker route to it — which sees full request and response bodies, and which the tunnel's owner cannot detect. Today that account is ours. From 3.x it may be a third party's (ADR-0031), and the honest statement of the property is therefore: **traffic reaches your machine from the edge of whichever account provisioned the tunnel, and is exposed to whoever runs it.** NPort targets development and demos, which is what makes that acceptable; hardening it is unscheduled in `docs/ROADMAP.md` § Deferred.

### Topology from 3.x — a registry and many nodes

The diagram above is one node. **A Cloudflare zone lives in exactly one account, and a
`<tunnel-id>.cfargotunnel.com` CNAME only routes when the record and the tunnel are in the same
account**, so `*.nport.link` cannot be spread across accounts. Every shard needs its own domain as
well as its own account, which is what forces the shape below (ADR-0031).

```text
                        ┌─ registry.nport.link ──────────────┐
   nport CLI ──────────►│  GET /v1/nodes   the directory     │◄──── nodes register
   or desktop           │  no credentials, provisions nothing│      and are probed
        │               └────────────────────────────────────┘
        │ probes a few, picks the fastest with capacity
        │
        ├──► api.nport.link   node #1, our account   ──► *.nport.link
        ├──► api.nport.dev    node #2, someone else  ──► *.nport.dev
        └──► …                anyone may run one
```

The registry is **advisory, not load-bearing**: the client caches the list, so a registry that is
down costs nothing. Selection is the client's — the registry never assigns a node.

Enrolment is open and anonymous, gated only by proof of work, a DNS TXT proof of domain control,
and a liveness probe. There is no shared secret, and therefore **no assurance about who runs a
node** — see the trust note in §1 and § Deferred in `docs/ROADMAP.md`.

## 2. Components

| Component | Responsibility | May talk to |
| --- | --- | --- |
| `crates/protocol` | Connector wire protocol: edge discovery, QUIC/HTTP2 transport, capnp registration, per-stream framing | Cloudflare edge |
| `crates/core` | `TunnelManager`: provision → connect → proxy → teardown. Connection pool, reconnect, local proxy, event stream, optional inspector. **Headless.** | `crates/protocol`, `crates/contract`, `api.nport.link`, localhost |
| `crates/cli` | Argument parsing, terminal rendering, config file, i18n, signal handling | `crates/core` |
| `apps/desktop` | GUI, tray, traffic inspector UI, auto-update | `crates/core` via Tauri IPC |
| `apps/api` | **A node.** Control plane: validate, claim, provision, heartbeat, reap. One Cloudflare account, one zone | Cloudflare API, its own Durable Objects, the registry |
| `apps/registry` | **The directory.** Accepts node registrations, probes them, answers `GET /v1/nodes`. Holds no credentials and provisions nothing (ADR-0031) | the nodes it has listed |
| `apps/web` | Marketing site, user docs, error-code pages | nothing at runtime |
| `packages/contract` | The API contract: zod schemas, OpenAPI, error registry | — (build-time authority) |

`crates/core` being headless is an invariant, not a preference: the CLI and the desktop app render the same `TunnelEvent` stream in completely different ways, and any `println!` in `core` corrupts the desktop app's IPC channel.

## 3. Request paths

### 3a. Provisioning

```
CLI                          apps/api                    Cloudflare API
 │                               │                             │
 ├─ probe localhost:3000 ────────┤                             │
 │  (fail fast if nothing there) │                             │
 ├─ GET /v1/challenge ──────────►│                             │
 │◄─ challenge + difficulty ─────┤                             │
 ├─ solve proof-of-work          │                             │
 ├─ POST /v1/tunnels ───────────►│                             │
 │   {subdomain, pow, client}    ├─ normalize + validate       │
 │                               ├─ SubdomainLease DO:         │
 │                               │   idFromName(subdomain)     │
 │                               │   ├─ state must be free     │
 │                               │   ├─ journal CLAIMING       │
 │                               │   ├─ create tunnel ────────►│
 │                               │   ├─ fetch its token ──────►│
 │                               │   ├─ journal TUNNEL_CREATED │
 │                               │   ├─ create CNAME ─────────►│
 │                               │   ├─ journal DNS_CREATED    │
 │                               │   ├─ journal ACTIVE         │
 │                               │   └─ set alarm              │
 │◄─ {url, token, ownerToken, ───┤                             │
 │    expiresAt}                 │                             │
 ├─ connect (docs/PROTOCOL.md) ──┼─────────────────────────────┼─► edge
```

Each saga step is **journaled to Durable Object storage before the side effect it describes**. That ordering is what makes recovery possible: on replay, a journal entry means "this may have happened", so compensation is idempotent and safe to re-run.

### 3b. Inbound request

```
end user → https://myapp.nport.link
  → Cloudflare edge (TLS terminated, DDoS filtered, CNAME → <uuid>.cfargotunnel.com)
  → edge opens a QUIC stream to the connector, sends ConnectRequest
  → crates/core reconstructs the HTTP request, forwards to localhost:3000
  → response streamed back as ConnectResponse + raw bytes
  → (desktop only) a copy of the exchange lands in core::inspector
```

`apps/api` is **not on this path**. Tunnel throughput does not consume Worker CPU, Worker requests, or DO time — only provisioning does. This is what makes a free tier viable.

### 3c. Heartbeat

The connector sends `POST /v1/tunnels/:subdomain/heartbeat` with the `ownerToken` every **30 s**. The DO records `last_heartbeat_at` and re-arms its alarm.

Distinct from the QUIC 1 s keep-alive in `docs/PROTOCOL.md` §12 — that keeps the *edge connection* alive; this keeps the *lease* alive. Both are needed: the edge connection can be healthy while NPort has lost track of the lease, and vice versa.

### 3d. Teardown

On Ctrl+C: stop accepting new exchanges → `unregisterConnection()` on each edge connection → drain in-flight requests within the grace period → `DELETE /v1/tunnels/:subdomain` with the `ownerToken` → DO runs compensations and clears the lease.

Must be idempotent and re-entrant. v2's second Ctrl+C fired a second DELETE; ours must not.

### 3e. Expiry

Each lease's own DO alarm fires at `min(expires_at, last_heartbeat_at + 120s)`. The alarm deletes the DNS record (after the ownership check in §7), deletes the tunnel, and clears the lease.

**Expiry is per-object and self-driven.** This is the fix for v2's cleanup ceiling: teardown throughput scales with the number of tunnels instead of being capped by one cron invocation's subrequest budget.

### 3f. Reconciliation

A `*/5` cron sweeps for **orphans only** — Cloudflare tunnels or DNS records with no corresponding lease, which can exist if a DO was destroyed or a saga compensation failed permanently. It walks a paginated cursor persisted in the `Registry` DO, so each run resumes where the last stopped: bounded per invocation, unbounded over time.

It is a safety net, not the primary mechanism. If reconciliation is deleting things regularly, something in §3e is broken.

## 4. State model

| State | Lives in | Lifetime | Authority for |
| --- | --- | --- | --- |
| Lease (ownership, timing) | `SubdomainLease` DO, SQLite | until expiry or delete | who owns a subdomain, when it expires |
| Global index, sweep cursor, counters | `Registry` DO (singleton), SQLite | permanent | reconciliation progress, global caps |
| Tunnel + DNS record | Cloudflare | mirrors the lease | actual routing |
| Tunnel token | connector memory only | process lifetime | — |
| `ownerToken` | connector memory; **hash only** server-side | lease lifetime | proof of ownership |
| User config | `~/.nport/config.toml` | user-managed | language, backend URL |

```sql
-- SubdomainLease DO
CREATE TABLE lease (
  subdomain         TEXT PRIMARY KEY,
  tunnel_id         TEXT,
  owner_token_hash  BLOB,      -- SHA-256; the token itself is returned once and never stored
  state             TEXT,      -- FREE | CLAIMING | TUNNEL_CREATED | DNS_CREATED | ACTIVE | RELEASING
  saga_step         TEXT,
  created_at        INTEGER,
  expires_at        INTEGER,
  last_heartbeat_at INTEGER,
  client_version    TEXT,
  ip_hash           BLOB,      -- HMAC(ip, rotating secret); raw IPs are never stored
  legacy            INTEGER    -- created through the v2 shim, and therefore deletable by source hash
);
```

**One DO instance per normalized subdomain**, addressed by `idFromName(subdomain)`. This is the load-bearing choice: a DO is single-threaded, so concurrent claims for the same name serialize by construction and the second one gets a clean 409. No locking protocol, no CAS loop, no race.

`docs/DECISIONS.md` ADR-0011 records why not KV (eventually consistent, no compare-and-set, so it cannot prevent a double-claim) and why not D1 alone (a `UNIQUE` constraint gives atomicity but D1 has no timers, putting expiry back on the cron and reintroducing the throughput ceiling).

## 5. Failure modes

| Failure | Detection | User impact | Recovery |
| --- | --- | --- | --- |
| Saga fails mid-provision | journal + alarm | create returns an error | alarm re-drives compensation; no orphan persists |
| Isolate dies mid-saga | alarm on restart | create appears to hang, then errors | DO storage survives; compensation replays |
| Cloudflare API down | 5xx / timeout | cannot create tunnels | retry with backoff; `503 CAPACITY_EXHAUSTED` after budget |
| Connector loses an edge connection | QUIC idle timeout | brief partial capacity | rotate edge address, re-register that index |
| Connector process killed (SIGKILL) | heartbeat stops | tunnel URL dead within 120 s | alarm reaps the lease |
| DO destroyed | reconciliation | subdomain stuck until sweep | cron finds the orphan and cleans it |
| **Cloudflare changes the connector protocol** | `protocol-canary.yml` within 6 h | **every installed client breaks** | see below |
| Local port not listening | pre-flight probe | immediate clear error | fail before provisioning anything |
| Abuse spike | rate limits + global cap | legitimate users see 429/503 | raise PoW difficulty; caps in `docs/OPERATIONS.md` |

**The protocol-change failure mode is unique to v3 and has the largest blast radius in the entire system.** v2 delegated it to `cloudflared`, which auto-updated. We own it now: an edge change breaks every installed binary at once, and users cannot fix it themselves. Three mitigations, in order — the 6-hourly canary so we learn before users do; the HTTP/2 transport as an independent fallback path; and a fast release pipeline so a fix reaches npm/Homebrew/Scoop in hours. `docs/OPERATIONS.md` carries the incident playbook.

## 6. Capacity and cost

The design goal is that **tunnel traffic costs nothing on the Workers side**, because it never transits a Worker (§3b). Only provisioning, heartbeats, and reaping consume platform resources.

| Resource | Constraint | Consequence |
| --- | --- | --- |
| Worker subrequests | 50 (free) / 1000 (paid) per invocation | Provisioning uses ~5; reconciliation pages deliberately |
| DO alarms | one pending per object | Sufficient — expiry and heartbeat timeout share `min()` |
| DO SQLite | free-plan eligible since Apr 2025 | Storage cost is not a blocker |
| Heartbeats | 1 per tunnel per 30 s | The dominant request cost; tune the interval, not the architecture |
| Cloudflare API rate limits | per-account | The real ceiling on provisioning throughput |

v2's ~480 teardowns/day ceiling is gone: per-object alarms scale with tunnel count.

## 7. Security

**No accounts means no identity.** The API cannot know *who* is calling, so it makes claims verifiable and abuse expensive rather than trying to authenticate.

### Ownership without accounts

Create returns a 256-bit `ownerToken`, once. The server stores only `SHA-256(ownerToken)`. Delete, refresh, and heartbeat require it. This closes v2's hole where `DELETE {subdomain, tunnelId}` was accepted from anyone — including for the `api` subdomain itself.

### Never delete a record you cannot prove you own

Before deleting a DNS record, verify it is a `CNAME` whose content is exactly `<expected_tunnel_id>.cfargotunnel.com`. Any mismatch is `409 DNS_CONFLICT` plus a log line for manual review — **never a delete**.

This is an invariant because v2's takeover path was a *deliberate feature*: any anonymous caller could claim a name whose tunnel looked `down`/`degraded`/`inactive`, deleting the incumbent's tunnel and DNS record. A user whose connection merely flapped could lose their subdomain to a stranger. In v3 a lease cannot be taken while `ACTIVE`, and reclaim happens only after alarm-driven teardown completes.

### Abuse controls

| Layer | Mechanism |
| --- | --- |
| Edge | Cloudflare zone rate limiting on `api.nport.link` |
| Per-source | Workers rate-limit binding keyed on `HMAC(ip, rotating_secret)` + ASN. **Raw IPs are never stored.** |
| Cost | Stateless proof-of-work on create: `GET /v1/challenge` returns an HMAC'd challenge; create requires a nonce with N leading zero bits. ~100 ms for one user, prohibitive at scale, invisible in the CLI, difficulty raised dynamically under load |
| Concurrency | Per-source cap on simultaneous leases and hourly creates |
| Global | `MAX_ACTIVE_TUNNELS` → `503 CAPACITY_EXHAUSTED` |
| Browser | **No CORS headers at all**, so no web page can drive the API |
| Client | Required client identification with a minimum-version gate → `426 CLIENT_TOO_OLD` |

Proof-of-work is the load-bearing control: it is the only one that raises attacker cost without an account or a stored identifier.

### Reserved subdomains

A real deny list, not v2's single `['api']` entry — infrastructure (`api`, `www`, `mail`, `smtp`, `ns1`, `mx`, `_acme-challenge`, `_dmarc`), product (`app`, `docs`, `blog`, `status`, `cdn`, `admin`, `dashboard`, `staging`), and phishing-prone names (`login`, `signin`, `secure`, `verify`, `account`, `billing`, `paypal`, `wallet`), plus the `smoke-*` and `nport-*` prefixes. **Shared with the reconciliation sweeper**, so cleanup can never delete a reserved record.

### Subdomain validation

Normalize, then validate. Normalize: trim, NFKC, lowercase, strip a pasted `.nport.link` suffix. Validate: `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$`, 3–63 characters, reject `xn--` and `--` at positions 3–4, reject reserved names and confusable/brand-impersonation patterns.

v2 had **no validation at all** and interpolated the raw value into hostnames and into Cloudflare API query strings unencoded, so `a.b.c`, `*`, and values containing `&` or `#` all passed. Mirror the validator in Rust for instant local feedback, and test both against one shared fixture set so they cannot diverge.

Generated names are `nport-<base32(8 random bytes)>`. v2 used `user-<random 0..9999>` — a 10,000-name space with `Math.random()` and no collision retry, so guessing someone's tunnel URL was trivial.

### Secrets

`apps/api` holds the only credentials: `CF_API_TOKEN` (scoped to Account → Cloudflare Tunnel → Edit and Zone → DNS → Edit), `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_DOMAIN`, plus the PoW and IP-hash secrets. Inventory and rotation in `docs/OPERATIONS.md`.

**No secret ships in any client artifact.** v2 shipped its GA4 measurement ID *and API secret* in the published npm bundle.

Upstream errors are never surfaced: raw Cloudflare messages map to `502 UPSTREAM_CLOUDFLARE_ERROR` with a `requestId`, and detail goes only to Workers logs. v2 echoed raw CF error text to unauthenticated callers.

## 8. What changed from v2

The v2 implementation on `main` had twenty defects worth designing against. Grouped by root cause:

- **No storage.** The Cloudflare API *was* the datastore — tunnel name meant ownership, `created_at` was the only timestamp, `status` the only liveness signal. This single choice caused the takeover hole, the create races, the client-side time limit, and the cleanup ceiling. → §4.
- **Errors as strings.** Every failure returned HTTP 500 with the taxonomy encoded as message prefixes (`SUBDOMAIN_IN_USE:`) that the CLI matched with `String.includes`. → `docs/ERRORS.md`, ADR-0018.
- **Non-atomic provisioning.** No rollback when DNS creation failed after tunnel creation; conflict checks swallowed their errors and continued anyway. → §3a.
- **A supervised Go binary.** Health inferred by substring-matching `cloudflared` stderr; the token passed in argv where `ps` could read it; five accreted layers of binary-permission workarounds; no checksum verification on a download pinned to `releases/latest`. → `docs/PROTOCOL.md`.
- **A CLI that fought its user.** No `--help`, no `-p/--port` (positional only, so `nport -s app 3000` silently used port 8080), unknown flags ignored, and a first-run language prompt with no TTY check that ran *before* `--version` and hung CI. → ADR-0019, `crates/CLAUDE.md`.

Full defect-by-defect mapping is in the approved plan; each fix is an explicit requirement in the relevant section above.

## 9. Non-goals

Out of scope for 3.0. Each would need an ADR to reconsider.

- **TCP, UDP, and ICMP tunnelling.** HTTP and WebSocket only. Removes the entire datagram protocol surface (`docs/PROTOCOL.md` §10).
- **Custom domains.** `*.nport.link` only.
- **Accounts, teams, dashboards, reserved-subdomain ownership.** Invariant 1.
- **Tunnel password protection or access policies.**
- **Multiple ports per tunnel.**
- **Traffic inspection in the CLI.** Desktop only, so the CLI stays lean.
