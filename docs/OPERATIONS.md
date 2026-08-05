# Operations

Runbook for the production service. v2 ran for years with no runbook; this is the correction.

**Status: written ahead of deployment.** Values marked _TBD_ get filled in when Phase 2 deploys.

## Inventory

| Resource | Identifier | Managed by |
| --- | --- | --- |
| Cloudflare zone | `nport.link` | dashboard |
| Worker (API) | `nport-api` → `api.nport.link` | `apps/api/wrangler.jsonc` |
| Worker (site) | `nport-web` → `nport.link`, `www.nport.link` | `apps/web/wrangler.jsonc` |
| Durable Objects | `SubdomainLease`, `Registry` | `apps/api` migrations |
| npm | `nport` + 8 `@nport/cli-*` | `release-cli.yml` |
| crates.io | `nport`, `nport-core`, `nport-protocol` | `release-cli.yml` |
| Homebrew tap | `tuanngocptn/homebrew-tap` | `release-cli.yml` |
| Scoop bucket | _TBD_ | `release-cli.yml` |
| Desktop updater manifest | R2 bucket, `latest.json` | `release-desktop.yml` |
| Retired | Pages project `nport-site`, GA4 `G-8MYXZL6PGD` | delete after cutover |

Unlike v2, both custom domains are declared in `wrangler.jsonc` `routes` with `custom_domain: true` — not configured by hand in the dashboard. The repo is the source of truth.

## Secrets

### Worker runtime (`wrangler secret put`, per environment)

| Secret | Scope | Rotatable without downtime |
| --- | --- | --- |
| `CF_API_TOKEN` | Account → Cloudflare Tunnel → Edit; Zone → DNS → Edit | yes, see below |
| `CF_ACCOUNT_ID` | identifier, not a secret, but kept out of the repo | n/a |
| `CF_ZONE_ID` | identifier | n/a |
| `CF_DOMAIN` | e.g. `nport.link` | n/a |
| `POW_SECRET` | HMAC key for challenges | yes, with overlap |
| `IP_HASH_SECRET` | HMAC key for source hashing | yes, rotating by design |

`CF_API_TOKEN` must be a **scoped** token. v2 supported the legacy Global API Key as a fallback, which grants full account control — v3 does not.

### CI (GitHub Actions secrets)

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NPM_TOKEN`, `CARGO_REGISTRY_TOKEN`, `HOMEBREW_TAP_TOKEN`, `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_PASSWORD` + `APPLE_CERTIFICATE` (+ password), `WINDOWS_CERTIFICATE` (+ password), `TAURI_SIGNING_PRIVATE_KEY` (+ password).

Never in CI: the Worker runtime secrets above. They are set with `wrangler secret put` and never pass through Actions.

### Two names that must never be set on a deployed Worker

`FAKE_CLOUDFLARE` and a lowered `MIN_CLIENT_VERSION` exist only in `apps/api/.dev.vars`, which `wrangler dev` reads and `wrangler deploy` does not upload (`docs/CONTRIBUTING.md`). Neither can reach production by accident. **`wrangler secret put FAKE_CLOUDFLARE` would be the accident** — a control plane answering `201 Created` while provisioning nothing, handing out URLs for tunnels that do not exist. The code refuses to activate the fake when `CF_API_TOKEN` looks real, so the blast radius of a mistake is bounded, but that guard is a backstop and not a licence to test it.

If `POST /v1/tunnels` starts succeeding with no matching tunnel in the Cloudflare dashboard, check for these two before anything else.

### Rotating `CF_API_TOKEN` with no downtime

1. Create a new token with identical scopes.
2. `wrangler secret put CF_API_TOKEN` — takes effect on the next isolate start, within seconds.
3. Verify: create and delete a test tunnel, confirm 200s and no `UPSTREAM_CLOUDFLARE_ERROR` in logs.
4. Revoke the old token.

Both tokens are valid during steps 2–4, so there is no gap. Rotate `POW_SECRET` the same way, but accept challenges signed with either key for one challenge-validity window before revoking — otherwise every in-flight challenge fails.

## Cloudflare setup

For a fresh deployment (also the basis of `docs/SELF_HOSTING.md`):

1. Zone for the apex domain, nameservers delegated.
2. API token with Account → Cloudflare Tunnel → Edit and Zone → DNS → Edit.
3. `wrangler deploy` in `apps/api`; DO migrations apply automatically on first deploy.
4. `wrangler secret put` each runtime secret.
5. Confirm `api.<domain>` resolves to the Worker and `GET /v1/health` returns 200.
6. `wrangler deploy` in `apps/web`.
7. Zone rate-limiting rule on `api.<domain>` — _TBD_ threshold.
8. Verify `api` and the rest of the reserved list cannot be claimed.

## Verifying the Cloudflare API surface

Every path, query parameter and response field `apps/api/src/cloudflare/client.ts` uses was checked against Cloudflare's published schema on **2026-08-05**, before any deploy. Two of them were wrong, and one of those would have broken every provision — so this is worth repeating whenever that file changes, and it needs no credentials:

```bash
curl -sL -o /tmp/cf-openapi.json \
  https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json
jq -r '.paths | keys[]' /tmp/cf-openapi.json | grep cfd_tunnel
```

Cross-check anything surprising against `cloudflare/cloudflare-go`, which is generated from the same source: `shared.CloudflareTunnel` is the struct a create and a list both return, and a field absent there is a field the schema does not promise.

**Two divergences are known and deliberate**, both recorded where the code makes the choice:

- **The create response's `token`.** Not in the schema, not in the SDK, and read by v2 in production for years. Both shapes are accepted — ADR-0032.
- **`DELETE /zones/{id}/dns_records/{id}` documents a 200 body with no `success` field.** Every call here requires `success === true`, so taken literally this would fail every DNS delete and strand every lease in `RELEASING`. It is a documentation gap: v2 ran the identical call, with the identical check, in production. **Do not "fix" this against the schema** — the schema is the weaker evidence of the two, and the first live teardown is what confirms it.

The reverse lesson is also worth keeping. The tunnels list sends **no `total_pages`** — the DNS list does, and reading it off the wrong endpoint left the reconciliation sweep pinned to page 1 forever. Where the schema and a fake disagree, the fake is what needs changing.

## Pages → Workers cutover

The site moves from the `nport-site` Pages project to the `nport-web` Worker (ADR-0006). The apex is live, so order matters.

1. Deploy `nport-web` and verify on its `workers.dev` URL.
2. Compare against production: every section renders, all four JSON-LD blocks present, `sitemap.xml` and `robots.txt` served, favicons resolve, dark mode toggles, `/errors/<code>` pages work.
3. Lower the apex DNS TTL to 60 s. Wait for the old TTL to expire.
4. Add `nport.link` and `www.nport.link` as custom domains on `nport-web`.
5. Watch for 5xx and for a drop in GA4 sessions. **Rollback: remove the custom domains and re-point at Pages** — keep the Pages project until step 7.
6. Restore the TTL.
7. After a week clean, delete the `nport-site` Pages project and the vestigial `website/CNAME`.

Verify redirects too: `www` → apex, and `http` → `https`.

## Playbooks

### Edge protocol change — the one that matters

Symptom: `protocol-canary.yml` fails, or `EDGE_PROTOCOL_ERROR` / `EDGE_REGISTRATION_REFUSED` spikes in issue reports. Blast radius: **every installed client**, and users cannot fix it themselves.

1. Confirm it is the edge, not us — nothing shipped, and the canary was green before.
2. Reproduce with `cargo test -- --ignored`, capture the failing frame.
3. Diff current cloudflared against the pinned commit in `docs/PROTOCOL.md` §1. A version-byte bump or a feature-list change is the likely cause (risks P4, P5).
4. **Mitigate first, fix second.** Try `--transport http2`; if that works, the QUIC path alone broke and you have a workaround to publish immediately.
5. Post a pinned issue and a note on the site with the workaround.
6. Fix, add a golden fixture for the new shape, update the pinned commit and §17, release as a patch.
7. If the protocol has changed in a way we cannot follow, ship the `CloudflaredConnector` fallback (ADR-0017).

Have the ladder ready before you need it — that is the whole point of ADR-0017.

### Cloudflare API outage

`UPSTREAM_CLOUDFLARE_ERROR` rate climbs; creates fail, existing tunnels keep working (they do not touch the API). Confirm on Cloudflare's status page, post a notice, let retries with backoff handle it. Do not disable validation or the saga to "get creates through" — that is how orphans are made.

### Quota exhaustion

`CAPACITY_EXHAUSTED` (global cap) or Worker/DO limits. Check whether it is genuine growth or abuse via the source-hash distribution. Genuine: raise `MAX_ACTIVE_TUNNELS`, consider a paid plan. Abuse: see below.

### Mass abuse

Signals: create rate far above baseline, concentrated ASNs, subdomains matching phishing patterns, short-lived tunnels churning names.

Levers in escalation order: raise PoW difficulty (fastest, no deploy if it is a var); lower per-source concurrent and hourly caps; tighten the zone rate-limiting rule; add patterns to the reserved deny list; block ASNs at the zone. Lowering `MAX_ACTIVE_TUNNELS` is a last resort — it hurts legitimate users equally.

### Stuck lease / force-release

A user reports a subdomain they cannot claim and nobody appears to be using.

1. `GET /v1/tunnels/<subdomain>` — if `ACTIVE` with a recent heartbeat, someone genuinely holds it. Nothing to do.
2. If no lease exists but creates return `DNS_CONFLICT`, there is an orphan DNS record.
3. Inspect the record. **Verify it is a CNAME to `<tunnel-id>.cfargotunnel.com` before touching it** (invariant 8). If it points anywhere else, escalate — do not delete.
4. Confirm the tunnel is not `healthy` in the dashboard.
5. Delete the DNS record, then the tunnel.
6. Record why in the issue. A recurring `DNS_CONFLICT` means a compensation path is broken — fix that, not the symptom.

Reconciliation deliberately will not do step 5 automatically. Automating a delete you cannot prove ownership of is exactly how v2's takeover bug worked.

### Rolling back a release

See `docs/RELEASE.md` — differs per artifact.

## Dashboards and alerts

Workers observability is enabled on both Workers.

Alerts to configure: canary failure (**page**), API 5xx rate above baseline, `UPSTREAM_CLOUDFLARE_ERROR` rate, `CAPACITY_EXHAUSTED` occurring at all, `DNS_CONFLICT` occurring at all (it should be near-zero), DO alarm failures, smoke-test failure.

Watch weekly: active tunnels, creates/hour, create→active success rate, lease-expiry vs explicit-delete ratio, PoW rejection rate, client version distribution (informs `MIN_CLIENT_VERSION`).

## Log hygiene

Never logged: tunnel tokens, `ownerToken` values, raw client IPs (only `HMAC(ip, secret)`), request or response bodies.

Always logged on error: `requestId`, error code, subdomain, saga step, upstream status. Users quote `requestId` from the error envelope, so it must be greppable.
