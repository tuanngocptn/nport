# Self-hosting

Run your own control plane on your own domain. Clients point at it with `--backend`.

Reasons to: you want your own domain instead of `*.nport.link`; you need tunnels without the public instance's time limit; your organisation cannot send subdomain names to a third party; or you want a private instance with no abuse controls in the way.

**Status: followable.** `apps/api` is feature-complete and deployed (`docs/ROADMAP.md` §2a), so the steps below describe software that exists. What has *not* happened is somebody other than us following them end to end on a fresh account — and every var name and flag on this page was wrong until 2026-08-07 (defect 39), so treat a discrepancy as this page's bug and report it.

## What you get and what you own

Self-hosting replaces **only the control plane** (`apps/api`). The data plane is still Cloudflare's edge, so you still get global anycast, TLS, and DDoS protection. NPort's connector talks to Cloudflare directly either way (`docs/ARCHITECTURE.md` §3b).

You become responsible for: your Cloudflare bill, your own abuse controls and caps, your API token's security, and keeping the deployment current when the protocol changes (`docs/OPERATIONS.md`).

**Your deployment is a private node, and it stays private by default.** Under ADR-0031 a deployment of `apps/api` is a **node**, and nodes may list themselves in a public directory so that any client can discover them. Yours will not: listing requires `REGISTRY_URL`, and leaving it unset — which is what happens if you follow this guide and do nothing extra — means the node never registers, never appears in `GET /v1/nodes`, and is reachable only by someone who knows its URL and passes it with `--backend`. There is no opt-out to remember, because there is no opt-in you did not make.

## Prerequisites

- A domain on Cloudflare with nameservers delegated. A subdomain of an existing zone works — `tunnels.example.com`, with tunnels at `<name>.tunnels.example.com`.
- A Cloudflare account. The free plan is sufficient: Workers, Durable Objects with SQLite, and DNS all have free tiers.
- Node 24, pnpm 10, and `wrangler`.

## Setup

### 1. API token

Create a scoped token with exactly two permissions, both set to **Edit**:

| Permission group | Policy resource |
| --- | --- |
| Cloudflare Tunnel | Entire Account |
| DNS | your zone |

They sit in **different policies**, because a policy's resource selector decides which groups it
offers: an Entire Account policy lists no zone permissions at all. Add the account one, then
**+ Add policy** for the zone. (In the API these are the groups `Cloudflare Tunnel Write` and
`DNS Write` — `Write` is what the `Edit` toggle sets.)

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

Two ways. The flag wins over the file:

```bash
nport 3000 -s myapp --backend https://api.example.com   # one-off
```

```toml
# ~/.nport/config.toml — every key is a default for the matching flag
backend = "https://api.example.com"
```

`NPORT_HOME` moves that file, which is the seam `pnpm smoke` uses.

**There is no `--set-backend` and no `NPORT_BACKEND_URL`.** This page described both for weeks; neither has ever existed (`schema/cli.json` is the generated list of what does). Editing the file is the persistent option, and `crates/cli/src/config.rs` is the authority on its keys — `subdomain`, `backend`, `registry`, `node`, `lang`, `port`, and nothing else. Unknown keys are a hard error rather than a silent ignore, so a typo tells you.

## Tuning

Set these as `vars` in `wrangler.jsonc`. The public instance's values are chosen for a free service shared by strangers; a private instance can be far more relaxed.

| Var | Public default | Notes |
| --- | --- | --- |
| `LEASE_TTL_SECONDS` | `14400` | The lease ceiling — four hours. Raise it freely on a private instance |
| `HEARTBEAT_GRACE_SECONDS` | `120` | How long after a client goes quiet its lease is reaped |
| `MAX_ACTIVE_TUNNELS` | `1000` | Global cap → `503 CAPACITY_EXHAUSTED` |
| `MAX_CONCURRENT_PER_SOURCE` | `3` | Per-source cap. Raise for a team instance |
| `MAX_CREATES_PER_HOUR_PER_SOURCE` | `20` | |
| `POW_DIFFICULTY_BITS` | `20` | Starting difficulty. **The floor is 1, not 0** — see below |
| `POW_MAX_DIFFICULTY_BITS` | `26` | Ceiling the adaptive difficulty climbs to under load |
| `MIN_CLIENT_VERSION` | `"3.0.0"` | Raising it is how you tell users to upgrade |

**Proof of work cannot be turned off.** `packages/worker-kit/src/pow.ts` sets `MIN_BITS = 1`, and `issueChallenge` throws a `RangeError` outside `1..32` — so a `0` here does not relax the instance, it makes every provision attempt fail. This page recommended `0` until 2026-08-07. One bit is nearly free to solve, so if what you want is "no meaningful gate", `1` is that; it is not the same as no gate, and the note under **Limits** about protecting a private instance still applies.

**Reserve your own infrastructure hostnames before going live**, and note that this is a code change rather than a var. There is no `RESERVED_EXTRA` — this page named one until 2026-08-07 and nothing ever read it. The list is `RESERVED_SUBDOMAINS` and `RESERVED_PREFIXES` in `packages/contract/src/subdomain.ts`, a build-time constant shared by the Worker and the Rust client (ADR-0045), so adding a name means editing it, running `pnpm codegen && cargo xtask codegen`, and redeploying.

The risk is real and unchanged by the mechanism: the built-in list protects `api`, `www`, `mail` and similar, but it does not know about your zone. If `app.example.com` is your production site and your zone is `example.com`, a tunnel can claim it — the reserved list is the only thing between a user and your DNS.

## Operating it

`docs/OPERATIONS.md` applies to your deployment too — particularly the token rotation procedure, the stuck-lease triage, and the edge-protocol-change playbook.

Two things worth doing early:

- **Enable Workers observability** and alert on `DNS_CONFLICT`, which should be near-zero. It firing means a teardown failed permanently or something outside NPort touched your DNS.
- **Set up the protocol canary** if you depend on this. A Cloudflare edge change breaks your clients exactly as it would break the public instance, and you will not hear about it from us.

## Becoming a public node

Optional, and only if you want strangers' tunnels on your Cloudflare account and your bill. Four vars in `apps/api/wrangler.jsonc` § vars, and one DNS record:

| Var | What it is |
| --- | --- |
| `NODE_ID` | your node's id in the directory: `[a-z0-9-]`, 3–32 characters, stable across deploys |
| `PUBLIC_URL` | where clients reach you. **Must be under your `CF_DOMAIN`** |
| `REGISTRY_URL` | the directory. `https://registry.nport.link` for the public one |
| `NODE_VERSION` | display-only, and never verified |

Then publish a TXT record proving you control the domain, which is what stands in for an account:

```text
_nport-node.<your domain>   TXT   "nport-node=<your NODE_ID>"
```

The registry resolves that record, probes your `GET /v1/meta`, and lists you. `PUBLIC_URL` has to be under your domain because that record proves control of the domain and nothing else — a URL outside it would be a listing the proof does not cover. It re-registers on every cron tick, so a node that was delisted after an outage relists itself.

**What you are taking on**: strangers create tunnels in your zone, against your caps, on your bill — and `docs/ARCHITECTURE.md` §1 is explicit that a node operator *can* read and modify the traffic passing through the tunnels they issue. Being trusted not to is the whole arrangement. Do not do this on an account that matters to you.

## Limits

- **One zone per deployment.** Multi-tenant hosting across zones is not supported.
- No web UI. The site (`apps/web`) is marketing and docs, not a dashboard (ADR-0007).
- No accounts, so a private instance is protected by obscurity of the backend URL, not by authentication. **Anyone who learns the URL can create tunnels in your zone.** Proof of work does not change that — it prices bulk abuse, and at any difficulty a single determined caller gets through. Put Cloudflare Access in front of it if that matters.
- The DO migration path is forward-only (`docs/RELEASE.md`). Deploy upgrades in order; do not skip major versions.

## Upgrading

```bash
git pull && pnpm install
cd apps/api && pnpm wrangler deploy
```

Read the changelog for `api` and `protocol` scopes first. A `protocol` change may require your users to upgrade their CLI, and raising `MIN_CLIENT_VERSION` is how you tell them.
