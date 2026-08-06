---
applies_to:
  - infra/terraform/**
  - .github/workflows/deploy*.yml
  - apps/*/wrangler.jsonc
---

# Deployment

Standing up an environment from nothing, in order, with the reason each step cannot be skipped or
automated. Read `infra/terraform/README.md` first if you want the shape before the steps — this file
is the walkthrough, that one is the map.

The example throughout is **staging on `nport.online`**. Production is the same sequence with a
different account and zone (ADR-0038); nothing here is staging-specific except the two values.

## What is automated and what is not

**You create one Cloudflare API token. Terraform makes everything else**, including the state
bucket, the credentials that open it, and all six Worker runtime secrets (ADR-0040, ADR-0041).

Two things still need a person, and both are things a deploy pipeline structurally cannot do:

| Manual | Why it cannot be automated |
| --- | --- |
| Cloudflare account, zone, nameserver delegation | Terraform *reads* the zone; delegation happens at your registrar |
| One API token, and pasting four values into GitHub | It is the credential Terraform authenticates with — it cannot mint its own, and the workflow reads its secrets before any of this runs |

The state bucket used to be on that list. It no longer is: `infra/terraform/bootstrap` creates it,
along with a narrow R2 token scoped to it, and prints the values to paste.

---

## 1. Cloudflare account and zone

Create the account for this environment, add the zone, and delegate its nameservers at your
registrar. Wait for the zone to go **Active** — Terraform's zone lookup fails while it is pending,
with an error about no zone matching the filter.

Staging and production are **separate accounts**, not two zones on one account (ADR-0038). They share
no token, no tunnel quota, and no blast radius; that separation is what makes it acceptable to give
Actions a deploy credential at all.

## 2. The CI API token

Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.

| Scope | Needed for |
| --- | --- |
| Account → Workers Scripts → **Edit** | `wrangler deploy` |
| Account → Workers R2 Storage → **Edit** | reading and writing Terraform state |
| Account → API Tokens → **Edit** | Terraform mints the Worker's own token |
| Account → Cloudflare Tunnel → **Edit** | see below |
| Zone → Zone Settings → **Edit** | the TLS floor and always-HTTPS |
| Zone → DNS → **Edit** | `custom_domain: true` writes a record; and see below |
| Zone → Zone WAF → **Edit** | the edge rate-limit ruleset |

**The last two rows are the trap.** Cloudflare refuses to create a token carrying permissions the
creating token does not itself hold, so a CI token scoped only to what the *deploy* needs fails at
`cloudflare_api_token.worker` — during apply, after other resources have been created, not at plan
time. Granting them costs nothing: this token already reaches the whole account.

Set the zone resources to the zone from step 1. Copy the token now; Cloudflare shows it once.

## 3. Bootstrap the state bucket

Terraform's state cannot live in a bucket Terraform has not created yet, so this is a separate root
with **local state**, run once per Cloudflare account. It creates the bucket and an R2 token scoped
to it, and prints what the main root needs.

```bash
cd infra/terraform/bootstrap
export CLOUDFLARE_API_TOKEN=<step 2>

terraform init
terraform apply -var account_id=<this account's id>

terraform output backend_hcl              # paste into ../backend.hcl, set `key`
terraform output -raw r2_access_key_id
terraform output -raw r2_secret_access_key
```

R2's S3 API does not take a Cloudflare token directly — it takes a key pair *derived* from one, the
token's id and the SHA-256 of its value. That derivation is why these can be produced here instead
of copied out of a dashboard. **If the main root later fails to authenticate to the backend, doubt
this first** and fall back to R2 → Manage API tokens, which shows a pair directly.

Losing this root's `terraform.tfstate` is not an incident. The bucket and token still exist and
nothing depends on this state; Terraform just stops tracking them. That is why it is local, and why
it is one directory for every environment rather than one per environment.

## 4. The GitHub Environment

Repository → Settings → Environments → **New environment**, named `staging`.

The name is load-bearing: it selects the wrangler `--env`, the Terraform state key, and this secret
set. One name, three uses, so they cannot disagree.

| Kind | Name | Value |
| --- | --- | --- |
| secret | `CLOUDFLARE_API_TOKEN` | step 2 |
| secret | `CLOUDFLARE_ACCOUNT_ID` | this account's id |
| secret | `R2_ACCESS_KEY_ID` | step 3's output |
| secret | `R2_SECRET_ACCESS_KEY` | step 3's output |
| variable | `TF_STATE_BUCKET` | only if your bucket is not `nport-tfstate` |

Four values, and none of them is a Worker secret. Add **required reviewers** here if a deploy should
pause for a human — that is the mechanism for production, rather than a separate workflow.

## 5. First apply

You can let CI do this, but running it once locally is worth the five minutes: the plan is where a
wrong token scope or a pending zone shows up, and reading it beats reading a failed job.

```bash
cd infra/terraform

cp backend.hcl.example backend.hcl          # account id in the endpoint; key = staging/terraform.tfstate
cp terraform.tfvars.example terraform.tfvars # account_id and zone_name

export CLOUDFLARE_API_TOKEN=<step 2>
export AWS_ACCESS_KEY_ID=<step 3>
export AWS_SECRET_ACCESS_KEY=<step 3>

terraform init -backend-config=backend.hcl
terraform plan
```

Expect a handful of resources: three zone settings, one rate-limit ruleset, two generated passwords,
one API token. If the plan is empty, `backend.hcl` is pointing at state that already exists.

`terraform apply` when the plan reads correctly. Nothing is deployed yet — this creates the
infrastructure and the secrets, not the Workers.

**Switching environments locally later needs `terraform init -reconfigure`.** Without it Terraform
sees a different backend and offers to *migrate* the state it already knows, which would copy one
environment's state over the other's.

## 6. Deploy

```bash
git push
```

`deploy-staging.yml` fires and calls `deploy.yml`, which runs:

1. **gate** — lint, typecheck, tests, `pnpm deploy:check`, and a wrangler dry run. Nothing here
   touches an account, so a failure has changed nothing.
2. **terraform** — fmt, init, validate, plan, apply. The apply consumes the plan file the previous
   step wrote, so what lands is what was planned.
3. **api** and **web** in parallel — `wrangler deploy`, then the six secrets are pushed with
   `wrangler secret bulk` in one call.
4. **verify** — `scripts/verify-deployment.mjs` compares the live `/v1/meta` against the committed
   `wrangler.jsonc` for this environment.

Step 4 is the one that matters. A 200 proves *a* Worker is running; that check proves the
*configured* Worker is running, which is the failure wrangler's `notInheritable` `vars` actually
produce.

The secrets are synced **after** the deploy because `wrangler secret bulk` targets a Worker that
already exists. In the gap the Worker is live without them and fails closed — `missingBindings` in
`apps/api/src/env.ts` refuses the request rather than provisioning with a missing key.

## 7. Confirm

```bash
curl -s https://api.nport.online/v1/health
curl -s https://api.nport.online/v1/meta
node scripts/verify-deployment.mjs --host api.nport.online --env staging
```

A custom domain can take a minute to route after its first deploy; the verify script retries for
that reason.

---

## Adding production

No new Terraform and no new pipeline. A caller beside `deploy-staging.yml`:

```yaml
jobs:
  production:
    uses: ./.github/workflows/deploy.yml
    with:
      environment: production
      zone: nport.link
    secrets: inherit
```

Plus steps 1–4 against the production account, and an `env.production` block in both
`wrangler.jsonc` files. `pnpm deploy:check` refuses a block whose `vars` do not match the top level
in shape, which is the mistake worth catching there.

## Rotating a secret

```bash
terraform apply -replace=random_password.pow          # or .ip_hash
terraform apply -replace=cloudflare_api_token.worker
```

Then a deploy, which syncs the new value. There is no runbook to follow and no value to copy.

## When it fails

| Symptom | Cause |
| --- | --- |
| Plan: no zone matches the filter | Zone still pending, or the account id belongs to a different account |
| Apply fails at `cloudflare_api_token.worker` | The CI token lacks Tunnel Edit or DNS Edit — step 2's trap |
| Apply fails at a permission-group lookup | Cloudflare renamed the group; the error carries the API call that lists the real names, then set `tunnel_permission_group` or `dns_permission_group` |
| Backend init asks to migrate state | Missing `-reconfigure` when switching environments |
| Backend init fails to authenticate | The derived R2 key pair — create one in R2 → Manage API tokens instead (step 3) |
| Bootstrap apply wants to create an existing bucket | Its local state was lost; the bucket is fine, either `terraform import` it or skip this root |
| Deploy green, every request 500s | The secret sync did not run or did not carry all six; `wrangler secret list --env staging` |
| `verify-deployment` reports a mismatch | The `env` block's `vars` are incomplete — wrangler does not inherit them |
