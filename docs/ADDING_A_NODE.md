---
applies_to:
  - .github/workflows/deploy-node.yml
  - scripts/node-config.mjs
  - apps/gateway/wrangler.jsonc
  - apps/node/wrangler.jsonc
  - apps/node/src/register.ts
---

# Running a node

Fork this repository, set five values in your fork's settings, and run one workflow. That is the whole
of it — no clone, no local `wrangler`, no Terraform, and nothing to install.

You end up with a **node**: a gateway and a provisioner in your own Cloudflare account, serving tunnels
on your own domain, listed in the public directory so anyone's client can be offered it.

**Status: written, never run.** Gate G5 is the first time anything will be node #2, so this page
describes a path that has been built and not yet walked. Treat a discrepancy as this page's bug and
report it.

## Before you start: a node needs its own domain

**A second Cloudflare account is not enough.** A zone lives in exactly one account, and a
`<tunnel-id>.cfargotunnel.com` CNAME only routes when the record and the tunnel are in that same
account (`docs/ARCHITECTURE.md` §1). So `*.nport.link` cannot be spread across accounts, and a node
needs a domain of its own with nameservers delegated to the account it will provision into.

That single constraint is why federation exists at all rather than one large account. Check it first;
everything else here assumes it.

## What you set

Two **repository variables** — not secret, and visible in your fork's settings:

| Variable | What it is |
| --- | --- |
| `NPORT_DOMAIN` | your domain, e.g. `tunnels.example.com`. Tunnels appear at `<name>.tunnels.example.com` and the API at `api.tunnels.example.com` |
| `NPORT_NODE_ID` | your node's id in the directory: `[a-z0-9-]`, 3–32 characters, stable across deploys |

Three **repository secrets**:

| Secret | What it is |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account to deploy into |
| `CLOUDFLARE_API_TOKEN` | deploys the Workers and publishes one DNS record. Needs **Workers Scripts: Edit** on the account and **DNS: Edit** on the zone |
| `WORKER_CF_API_TOKEN` | the token your *node* uses to provision tunnels. Needs **Cloudflare Tunnel: Edit** and **DNS: Edit**, and nothing else |

**Two tokens, deliberately.** The one that deploys Workers and the one the Worker holds are different
jobs, and the Worker's should not be able to deploy Workers — that separation is ADR-0043's, and it is
worth the extra two minutes. `docs/DEPLOYMENT.md` §2 has the exact permission groups and the reason the
Global API Key is refused outright.

Two more secrets are **optional**, and worth setting for anything but a private node:

| Secret | Why you might set it |
| --- | --- |
| `POW_SECRET` | signs proof-of-work challenges. Generated per run if unset, which costs a two-minute window of outstanding challenges on each deploy |
| `IP_HASH_SECRET` | keys source identity. Generated per run if unset, which resets the per-source abuse counters on each deploy |

Either is `openssl rand -hex 32`. Neither grants authority anywhere — they are HMAC keys the deployment
uses to authenticate its own artifacts to itself.

## What you run

**Actions → Deploy a node → Run workflow.** Two optional inputs:

- **`registry_url`** — leave blank for the public directory. Point it elsewhere to join a different
  federation, or set nothing at all in `NPORT_*` and you have a private node instead
  (`docs/SELF_HOSTING.md`).
- **`dry_run`** — checks your inputs, resolves your zone, renders the configs, and deploys nothing.
  Worth one run.

The workflow deploys the node, then the gateway — that order, because Cloudflare rejects a deploy whose
service binding names a script that does not exist — pushes each one's secrets, publishes your domain
proof, and confirms the result.

## What it does that you would otherwise forget

**It publishes `_nport-node.<your domain>`.** The directory resolves that TXT record on **every**
registration, not just the first, and refuses a node that cannot prove the domain. Left as a manual
step it is the one that gets forgotten, and the failure is silent: your node registers every five
minutes, is refused `proof-missing`, and swallows it by design — an empty listing and a log line nobody
reads. That is exactly how our own first federated deploy went (`docs/ROADMAP.md`, defect 41), which is
why the workflow creates the record rather than telling you to.

**It renders node-shaped configs.** The committed `wrangler.jsonc` files are ours: they name our domain
and bind a registry your deployment will not have. `scripts/node-config.mjs` strips the `REGISTRY`
binding and sets your route, into a temporary file — your domain never lands in the tree, and a fork
that pulls from upstream gets no merge conflict.

## A node has no registry, and that is the design

| | Master deployment | Yours |
| --- | --- | --- |
| gateway, node | yes | yes |
| registry | yes | **no** |
| `/v1/nodes` | the directory | **does not exist** |

The directory is one deployment in the world. Your gateway declares no `REGISTRY` binding, so
`/v1/nodes` is *unrouted* rather than answering 404 from a service that happens to be missing. Role is
a deployment, not a configuration flag (ADR-0049).

## Confirming it

The workflow's last step does the first three; the fourth is yours.

1. **`GET /v1/health`** on `api.<your domain>` — the front door, and nothing behind it.
2. **`GET /v1/meta`** — the first request that crosses a service binding. A healthy health check beside
   an `INTERNAL` here means a binding is wrong, not that the node is down.
3. **`GET /v1/nodes` is a 400** — you have no registry, as intended.
4. **You appear in the directory.** `GET https://api.nport.link/v1/nodes` should list your node id
   within five minutes. If it does not, the answer is in your Worker's logs:
   `wrangler tail` shows `node registered`, or a refusal naming which check failed.

Then point a client at yourself directly:

```
nport 3000 --backend https://api.<your domain>
```

## What you are taking on

Strangers create tunnels in your zone, against your caps, on your bill. And
`docs/ARCHITECTURE.md` §1 is explicit that a node operator **can read and modify the traffic passing
through the tunnels they issue** — being trusted not to is the whole arrangement. Do not run a public
node on an account that matters to you.

Tuning the caps, reserving your own hostnames, and the private-deployment case are all
`docs/SELF_HOSTING.md`.

## Leaving

Stop the workflow running and delete the TXT record. Your node ages out of the directory on its own:
silence past the registry's threshold marks it `down`, and more silence delists it. There is nothing to
deregister with, because stopping *is* how you leave (ADR-0049).
