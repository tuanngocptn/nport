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

**You create two API tokens and paste them into GitHub. The pipeline does everything else**,
including all six Worker runtime secrets (ADR-0040).

| Manual | Why it cannot be automated |
| --- | --- |
| Cloudflare account, zone, nameserver delegation | Terraform *reads* the zone; delegation happens at your registrar |
| A Cloudflare API token | The credential Terraform acts with — nothing can mint its own |
| An HCP Terraform token and organization | Where the state lives; the workflow authenticates with it before anything runs |

State is in **HCP Terraform** (`app.terraform.io`), not an object store (ADR-0042). There is no
bucket to create before Terraform can initialise and no second key pair to derive — a token is the
whole configuration, and state locking and run history come with it.

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

Six rows. The columns are the form's first two dropdowns; **the third is `Edit` on every row.**

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts | `wrangler deploy` uploads both Workers |
| Account | Cloudflare Tunnel | granted onward to the Worker's own token — see below |
| Zone | Zone Settings | the TLS floor and always-HTTPS |
| Zone | DNS | `custom_domain: true` writes the hostname record — and granted onward |
| Zone | Zone WAF | the edge rate-limit ruleset |
| **User** | API Tokens | Terraform mints the Worker's own credential — **not `Account`; see below** |

Set the **Zone Resources** to the zone from step 1, and **Account Resources** to that account. Copy
the token when it is shown; Cloudflare will not show it again.

Every row is here because something failed without it, or because Cloudflare requires it to grant
something else. Nothing in this project uses KV, R2 or Workers AI. If a deploy fails with a 403
naming a permission not in this table, add it here rather than widening the token on a guess.

---

**Three things this table cannot show you.**

**The first dropdown on the API Tokens row must say `User`.** It defaults to `Account`, and both
scopes offer a permission called "API Tokens", so the wrong one is what you get by not noticing.
`Account → API Tokens` manages tokens the account owns; the provider calls `POST /user/tokens`,
which only the User-scoped permission reaches. The failure is `403 … code 9109 Unauthorized to
access requested resource`, naming neither the scope nor the fix. **A token showing an `API Tokens`
row can still fail this way** — check the scope column, not the permission name.

There is deliberately no `Account → API Tokens` row to go with it. Looking a permission group up by
name can be done through either scope — the ids are global — and `secrets.tf` uses the user-scoped
catalogue precisely so this table needs one API-Tokens row instead of two. Switching that data source
back to the `account_` variant silently adds a permission to every token built from this page.

**Tunnel and DNS are held in order to be given away.** Nothing in the deploy calls either. Cloudflare
refuses to create a token carrying permissions the creating token does not itself hold, so the CI
token needs both to mint the Worker's. Without them the apply fails at `cloudflare_api_token.worker`,
after other resources already exist.

**Know what the `User` row costs.** A token that can write user API tokens can mint *any* token this
Cloudflare user could, including a full-access one — so compromising the runner compromises the
account, not merely the deployment. That is acceptable here only because staging is a separate
account with nothing in it (ADR-0038), and it is a decision to re-make before production rather than
copy across. The alternative is creating the Worker's token by hand and passing it as a fourth
GitHub secret: one manual step, and this row disappears.

## 3. HCP Terraform

Sign in at [app.terraform.io](https://app.terraform.io) and create an organization if you have none.
Then **Account settings → Tokens → Create an API token**.

Workspaces are named `nport-staging` and `nport-production` — `nport-<environment>`, generated by the
workflow — and are created on first `init` if they do not exist. They are selected by name alone, so
there is no tag to add to one you made in the UI.

One thing does need checking, once per workspace:

**Settings → General → Execution Mode → Local.**

HCP defaults to *remote* execution, where it runs the plan on its own infrastructure — which would
mean duplicating the Cloudflare credentials there as workspace variables. Local mode keeps HCP as
state storage only: CI runs the plan, HCP holds the result and the lock.

## 4. The GitHub Environment

Repository → Settings → Environments → **New environment**, named `staging`.

The name is load-bearing: it selects the wrangler `--env`, the Terraform state key, and this secret
set. One name, three uses, so they cannot disagree.

| Kind | Name | Value |
| --- | --- | --- |
| secret | `CLOUDFLARE_API_TOKEN` | step 2 |
| secret | `CLOUDFLARE_ACCOUNT_ID` | this account's id |
| secret | `TF_API_TOKEN` | step 3 |

**Three secrets and nothing else.** None is a Worker secret, and the HCP organization is not here — it is passed by the workflow caller, since it is in the workspace URL and not a secret at all. Add **required reviewers** here if a deploy should
pause for a human — that is the mechanism for production, rather than a separate workflow.

## 5. Deploy

```bash
git push
```

That is the whole step. The pipeline applies the infrastructure, deploys both Workers, syncs the
secrets and verifies the result.

### Running the plan locally first, if you want to read it

Optional, and worth it the first time — the plan is where a wrong token scope or a pending zone
shows up, and reading it beats reading a failed job.

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars    # account_id and zone_name

export CLOUDFLARE_API_TOKEN=<step 2>
export TF_CLOUD_ORGANIZATION=<your organization>
export TF_WORKSPACE=nport-staging

terraform login          # once per machine; stores the HCP token
terraform init
terraform plan
```

Expect seven resources: three zone settings, one rate-limit ruleset, two generated passwords, one
API token. If the plan is empty, `TF_WORKSPACE` points at state that already exists.

**Switching environments locally is `export TF_WORKSPACE=nport-production`**, then `terraform init`
again. Nothing is copied and nothing migrates — the workspace name is the only thing that selects
which state you are holding.

## 6. What the pipeline does

```bash
git push
```

`deploy-staging.yml` fires and calls `deploy.yml`, which runs:

1. **gate** — lint, typecheck, tests, `pnpm deploy:check`, and a wrangler dry run. Nothing here
   touches an account, so a failure has changed nothing.
2. **terraform** — claims the account's workers.dev subdomain if it has none, then fmt, init,
   validate, plan, apply. The apply consumes the plan file the previous step wrote, so what lands
   is what was planned.

   The subdomain is a Workers *account* prerequisite, not infrastructure: Cloudflare refuses to
   upload any script to an account that has never had one, and the dashboard normally creates it as
   a side effect of being visited. Provider v5 has no resource for it, so the job calls the API
   directly — read first, PUT only if absent. Both Workers set `workers_dev: false`, so nothing is
   ever served there; this only satisfies the upload check.
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
| `terraform init` cannot reach the backend | `TF_API_TOKEN` missing or expired, or `TF_CLOUD_ORGANIZATION` naming an organization the token cannot see |
| "organization must be set … TF_CLOUD_ORGANIZATION" | The caller passed no `tf_organization`. The job prints what it resolved before Terraform runs |
| Any `403 … 9109` on a `/user/tokens…` URL | The API Tokens row is scoped **Account**, not **User** — check the left dropdown, not the permission name |
| "not entitled to use the period N" / "…mitigation timeout different from N" | The zone's plan pins both. Free allows 10 for each; set `api_rate_limit_period` and `api_rate_limit_timeout` |
| Plan runs on HCP instead of in CI, and cannot find credentials | The workspace is in remote execution mode; set it to Local (step 3) |
| `wrangler deploy` fails with `code: 10063` | The account has no workers.dev subdomain and the step that claims one did not run or could not — see its output |
| "workers.dev subdomain already taken" | The namespace is global. Set any free name once in the dashboard; nothing is served there, so the name does not matter |
| Deploy green, every request 500s | The secret sync did not run or did not carry all six; `wrangler secret list --env staging` |
| `verify-deployment` reports a mismatch | The `env` block's `vars` are incomplete — wrangler does not inherit them |
