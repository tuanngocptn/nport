---
applies_to:
  - infra/terraform/**
  - .github/workflows/deploy*.yml
  - apps/gateway/wrangler.jsonc
  - apps/node/wrangler.jsonc
  - apps/node/src/register.ts
---

# Adding a node

How a **second node** joins the federation on our own pipeline: a new Cloudflare account, a new domain,
gateway and node deployed there, registering with the existing registry.

This is not `docs/SELF_HOSTING.md`. That page is for a stranger running their own deployment by hand with
`wrangler deploy`; this one is for a node we operate, through Terraform, HCP and GitHub Environments. The
*product* is identical — a node is a node — and only the plumbing differs.

**Status: not yet done.** Gate G5 is exactly this, plus a real failover. Node #1 exists on
`api.nport.online`; nothing has ever been node #2, so nothing here has been executed end to end.

## The constraint that shapes all of it

**A second account is not enough. A node needs its own domain.**

A Cloudflare zone lives in exactly one account, and a `<tunnel-id>.cfargotunnel.com` CNAME only routes
when the record and the tunnel are in the same account (`docs/ARCHITECTURE.md` §1). So `*.nport.online`
cannot be spread across two accounts, and every node needs a domain of its own with nameservers
delegated to the account that will provision into it. That single fact is why federation exists at all
rather than one large account, and it is the first thing to check before anything else here.

## What is different from adding an environment

`docs/DEPLOYMENT.md` § Adding production covers a second *environment* — the same three Workers, a
different account. A node is a different **shape**, not just a different account:

| | Master deployment | Node deployment |
| --- | --- | --- |
| `apps/gateway` | yes, binds `NODE` and `REGISTRY` | yes, binds **`NODE` only** |
| `apps/node` | yes | yes |
| `apps/registry` | yes | **no** |
| `apps/web` | yes | no |
| Registers with | its own registry, through its own gateway | the master's gateway |

**`/v1/nodes` does not exist on a node deployment**, and that is the point rather than an omission: the
gateway declares no `REGISTRY` binding there, so the path is unrouted rather than 404ing from a service
that happens to be absent. Role is a deployment, not a configuration flag (ADR-0049) — and G5 is the
first thing that actually tests that claim, because until a node-only deployment exists it is only an
assertion.

## What you provide

Steps 1–4 of `docs/DEPLOYMENT.md`, run against the new account. Nothing on this page replaces them:

1. **§1** — the account, and a domain on it with nameservers delegated.
2. **§2** — two scoped API tokens, `nport-ci` and `nport-worker`. The Global API Key is refused.
3. **§3** — an HCP Terraform workspace, local execution mode. A new workspace, because state is per
   deployment; the organization can be the existing one.
4. **§4** — a GitHub Environment holding the four secrets.

**No credential reaches the repository.** They live in Actions and HCP, and the pipeline reads them from
there (ADR-0040, ADR-0043). That is also why adding a node needs no new Terraform *configuration*: one
root serves every deployment, selected by the workspace and the variables passed at plan time.

## What the repository gains

Four edits, and `pnpm deploy:check` refuses three of the four ways to get them wrong.

**An `env` block in `apps/node/wrangler.jsonc`.** Its own `NODE_ID`, and `PUBLIC_URL` pointing at the new
gateway's hostname. `REGISTRY_URL` is the **master's** hostname — that is the whole of what makes it a
node in *this* federation rather than a private deployment.

**An `env` block in `apps/gateway/wrangler.jsonc`**, with `routes` on the new domain and **no `REGISTRY`
entry in `services`**. A binding to a Worker that does not exist fails the deploy, which is the loud
version of this mistake; the quiet version is copying the master's block and shipping a gateway that
routes `/v1/nodes` into nothing.

**A caller workflow** beside `.github/workflows/deploy-staging.yml`, passing the new environment and
zone. It also needs to skip the registry job — `deploy.yml` currently deploys all three Workers
unconditionally, which is correct for a master and wrong here.

**Nothing in `infra/terraform`.** The domain proof, the zone settings and the rate-limit ruleset are all
derived from the variables the pipeline passes, including `node_id`, which
`scripts/wrangler-var.mjs` reads out of `apps/node/wrangler.jsonc` so the record and the Worker cannot
name different nodes.

## The proof record

The registry resolves `_nport-node.<domain>` and requires a TXT record naming the node id, on **every**
registration rather than only the first — a domain that changes hands must not keep its listing. Both
strings come from `nodeProofRecordName` and `nodeProofRecordValue` in `packages/contract`, and Terraform
publishes the record from `node_id`; `pnpm deploy:check` compares its rendered output against those two
functions.

Without that record a node registers every five minutes, is refused `proof-missing`, and swallows the
failure by design — an empty directory and a log line nobody is reading. That is exactly how node #1's
first federated deploy went (`docs/ROADMAP.md`, defect 41), which is why Terraform creates it rather than
leaving it to an operator to remember.

## Confirming it worked

In order, because each step tells you something the next one assumes:

1. **The gateway answers.** `GET /v1/health` on the new hostname — that is the front door and nothing
   behind it.
2. **The binding resolves.** `GET /v1/meta` is the first request that crosses a service binding. A
   healthy health check beside an `INTERNAL` here means a binding is wrong, not that the node is down.
3. **`/v1/nodes` is absent.** On a node deployment this should *not* answer. If it does, the gateway
   kept the master's `REGISTRY` binding.
4. **The directory lists it.** `GET /v1/nodes` on the **master** shows both nodes. Allow one cron period,
   and remember a node with no traffic depends on that cron (ADR-0049).
5. **Failover, which is the gate.** A client discovers, picks one, and moves to the other when the first
   is stopped mid-run — with the caveat `crates/core::discovery` enforces: a refusal about the *caller*
   is never shopped to another node, because per-source caps are per node and retrying elsewhere would
   multiply every cap by the size of the directory.

Steps 1–4 are `scripts/verify-deployment.mjs`'s job and run on every deploy. Step 5 is G5 and has never
been exercised against real infrastructure.

## What this does not cover

**A third party's node.** They will not have our Terraform, our HCP workspace or our GitHub
Environments, and should follow `docs/SELF_HOSTING.md` — which ends at the same place: a TXT record, four
vars, and a node that registers itself.

**Choosing which node a client uses.** That is the client's, always. The registry returns the list in
registration order and does not rank, filter or recommend (ADR-0031).
