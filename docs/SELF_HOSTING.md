# Self-hosting

Run your own control plane on your own domain. Clients point at it with `--backend`.

Reasons to: you want your own domain instead of `*.nport.link`; you need tunnels without the public instance's time limit; your organisation cannot send subdomain names to a third party; or you want a private instance with no abuse controls in the way.

**Status: not yet implemented.** This is the intended setup; `apps/api` lands in Phase 2.

## What you get and what you own

Self-hosting replaces **only the control plane** (`apps/api`). The data plane is still Cloudflare's edge, so you still get global anycast, TLS, and DDoS protection. NPort's connector talks to Cloudflare directly either way (`docs/ARCHITECTURE.md` §3b).

You become responsible for: your Cloudflare bill, your own abuse controls and caps, your API token's security, and keeping the deployment current when the protocol changes (`docs/OPERATIONS.md`).

## Prerequisites

- A domain on Cloudflare with nameservers delegated. A subdomain of an existing zone works — `tunnels.example.com`, with tunnels at `<name>.tunnels.example.com`.
- A Cloudflare account. The free plan is sufficient: Workers, Durable Objects with SQLite, and DNS all have free tiers.
- Node 24, pnpm 10, and `wrangler`.

## Setup

### 1. API token

Create a scoped token with exactly:

| Permission | Scope |
| --- | --- |
| Cloudflare Tunnel → Edit | your account |
| DNS → Edit | your zone |

Make it under **Manage Account → Account API Tokens**, not My Profile. An account-owned token
outlives the person who created it and cannot hold a user-scoped permission, and the control plane
never calls a `/user/…` endpoint. The one thing it costs: an account token cannot discover which
account it belongs to, so `CF_ACCOUNT_ID` below is not optional.

**Do not use the Global API Key.** It grants full account control, and unlike v2, v3 does not accept it.

These are the same two permissions this project's own deployment gives the Worker
(`docs/DEPLOYMENT.md` § 2b) — they are the entire Cloudflare surface `apps/api` touches. If one list
changes, the other is wrong.

### 2. Configure and deploy

```bash
git clone https://github.com/tuanngocptn/nport.git
cd nport && corepack enable && pnpm install
cd apps/api
```

Set `name` and `routes` in `wrangler.jsonc` to your own worker name and hostname. Leave `durable_objects` and `migrations` untouched.

```bash
pnpm wrangler deploy          # DO migrations apply on first deploy
pnpm wrangler secret put CF_API_TOKEN
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_ZONE_ID
pnpm wrangler secret put CF_DOMAIN        # e.g. tunnels.example.com
pnpm wrangler secret put POW_SECRET       # openssl rand -hex 32
pnpm wrangler secret put IP_HASH_SECRET   # openssl rand -hex 32
```

Verify:

```bash
curl https://api.example.com/v1/health
```

### 3. Point clients at it

Three ways, in precedence order:

```bash
nport 3000 -s myapp --backend https://api.example.com   # one-off
nport --set-backend https://api.example.com             # persist to ~/.nport/config.toml
export NPORT_BACKEND_URL=https://api.example.com        # environment
```

`--backend` beats the config file, which beats the environment variable, which beats the default. Same precedence as v2, so existing muscle memory works.

## Tuning

Set these as `vars` in `wrangler.jsonc`. The public instance's values are chosen for a free service shared by strangers; a private instance can be far more relaxed.

| Var | Public default | Notes |
| --- | --- | --- |
| `TUNNEL_MAX_AGE_HOURS` | 4 | Set high or effectively unlimited for a private instance |
| `HEARTBEAT_TIMEOUT_SECONDS` | 120 | How fast a dead client's lease is reaped |
| `MAX_ACTIVE_TUNNELS` | tuned | Global cap → `503 CAPACITY_EXHAUSTED` |
| `MAX_LEASES_PER_SOURCE` | 2 | Raise for a team instance |
| `MAX_CREATES_PER_HOUR` | 10 | |
| `POW_DIFFICULTY_BITS` | tuned | **0 disables proof-of-work** — reasonable on a private instance |
| `MIN_CLIENT_VERSION` | current | |
| `RESERVED_EXTRA` | — | Additional reserved names for your zone |

**Add your own infrastructure hostnames to `RESERVED_EXTRA`** before going live. The built-in list protects `api`, `www`, `mail`, and similar, but it does not know about your zone. If `app.example.com` is your production site and your zone is `example.com`, a tunnel could otherwise claim it — the reserved list is the only thing standing between a user and your DNS.

## Operating it

`docs/OPERATIONS.md` applies to your deployment too — particularly the token rotation procedure, the stuck-lease triage, and the edge-protocol-change playbook.

Two things worth doing early:

- **Enable Workers observability** and alert on `DNS_CONFLICT`, which should be near-zero. It firing means a teardown failed permanently or something outside NPort touched your DNS.
- **Set up the protocol canary** if you depend on this. A Cloudflare edge change breaks your clients exactly as it would break the public instance, and you will not hear about it from us.

## Limits

- **One zone per deployment.** Multi-tenant hosting across zones is not supported.
- No web UI. The site (`apps/web`) is marketing and docs, not a dashboard (ADR-0007).
- No accounts, so a private instance is protected by obscurity of the backend URL, not by authentication. **If your instance is reachable and PoW is disabled, anyone who learns the URL can create tunnels in your zone.** Use Cloudflare Access in front of it, or keep PoW enabled with a high difficulty.
- The DO migration path is forward-only (`docs/RELEASE.md`). Deploy upgrades in order; do not skip major versions.

## Upgrading

```bash
git pull && pnpm install
cd apps/api && pnpm wrangler deploy
```

Read the changelog for `api` and `protocol` scopes first. A `protocol` change may require your users to upgrade their CLI, and raising `MIN_CLIENT_VERSION` is how you tell them.
