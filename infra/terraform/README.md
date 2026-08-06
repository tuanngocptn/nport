# Infrastructure

Terraform for the Cloudflare resources that `wrangler` cannot express.

**One configuration, every environment.** Staging and production get identical infrastructure in
separate Cloudflare accounts (ADR-0038). Two directories would let them drift the first time
somebody changed one and not the other, and the drift would be invisible until a production apply.
What differs is three inputs, none of which live in the repository:

| Input | Where it comes from |
| --- | --- |
| `account_id` | `CLOUDFLARE_ACCOUNT_ID`, per GitHub Environment |
| `zone_name` | the workflow caller — `nport.online` for staging, `nport.link` for production |
| backend `key` | `<environment>/terraform.tfstate`, so the two never share a state file |

## The boundary

Three tools touch Cloudflare and each owns a different thing. Crossing the lines is how a deploy
starts fighting an apply.

| Owner | Resources | Why not one of the others |
| --- | --- | --- |
| **Terraform** (`infra/terraform/`) | zone settings, the edge rate-limit ruleset | Wrangler cannot express them at all |
| **Wrangler** (`apps/*/wrangler.jsonc`) | Worker scripts, routes, custom domains, DO migrations, `vars` | `custom_domain: true` creates the DNS record; a Terraform record for the same name would fight every deploy. The repo is the source of truth for both hostnames (`docs/OPERATIONS.md` § Inventory) |
| **The control plane, at runtime** | one CNAME per live tunnel | There are as many as there are tunnels and none are known at plan time |
| **Terraform** (`secrets.tf`) | the Worker's six runtime secrets | Generated, not typed — and the deploy syncs them with `wrangler secret bulk` (ADR-0040) |
| **The deploy workflow**, by raw API call | the account's workers.dev subdomain | A Workers account prerequisite with no provider v5 resource; `cloudflare_workers_script_subdomain` is per-script and needs the script to exist, which is the thing being blocked |

Terraform only ever destroys what its own state created, so the runtime tunnel records are safe by
construction. That is not a reason to relax: **never add a broad `cloudflare_dns_record` import or a
`for_each` over existing records to this stack.** The zone is deliberately a `data` source rather
than a resource, so `terraform destroy` cannot take the zone with it.

## State

In HCP Terraform (`app.terraform.io`), not an object store (ADR-0042). Nothing has to exist before
`terraform init` — a token is the whole configuration — and locking and run history come with it.

`versions.tf` names neither the organization nor the workspace: `TF_CLOUD_ORGANIZATION` and
`TF_WORKSPACE` supply both, so one configuration serves every environment. Workspaces must be in
**local execution mode**, or HCP runs the plan on its own infrastructure and the Cloudflare
credentials would have to be duplicated there.

## Setting one up

`docs/DEPLOYMENT.md` is the step-by-step. **One credential is human-made** — the Cloudflare API
token. The account and zone need a person because delegation happens at your registrar; everything
else, including the state bucket and all six Worker runtime secrets, the pipeline handles.

## What CI does with this

`.github/workflows/deploy.yml` holds the whole pipeline — gate → terraform → API and site in
parallel → verify — and takes two inputs, `environment` and `zone`. `deploy-staging.yml` is a
nine-line caller; the production caller will be another. A fix to a deploy step therefore reaches
both by construction, which is the same argument as the single Terraform root.

The apply step consumes the plan file the previous step wrote, so what lands is what was planned.
The verify job runs `scripts/verify-deployment.mjs`, which compares the live `/v1/meta` against the
committed `wrangler.jsonc` for that environment rather than against numbers written in the workflow
— so it needs no per-environment expectations, and a deploy that silently lost its `vars` fails
instead of returning 200 all day.
