# Infrastructure

Terraform for the Cloudflare resources that `wrangler` cannot express. One directory per
environment; `staging/` is the only one that exists, and production follows it when G2 closes
(`docs/ROADMAP.md`).

## The boundary

Three tools touch Cloudflare and each owns a different thing. Crossing the lines is how a deploy
starts fighting an apply.

| Owner | Resources | Why not one of the others |
| --- | --- | --- |
| **Terraform** (`infra/terraform/`) | zone settings, the edge rate-limit ruleset | Wrangler cannot express them at all |
| **Wrangler** (`apps/*/wrangler.jsonc`) | Worker scripts, routes, custom domains, DO migrations, `vars` | `custom_domain: true` creates the DNS record; a Terraform record for the same name would fight every deploy. The repo is the source of truth for both hostnames (`docs/OPERATIONS.md` § Inventory) |
| **The control plane, at runtime** | one CNAME per live tunnel | There are as many as there are tunnels and none are known at plan time |
| **A human, once** | Worker runtime secrets | `docs/OPERATIONS.md` § Secrets: they never pass through Actions (ADR-0039) |

Terraform only ever destroys what its own state created, so the runtime tunnel records are safe by
construction. That is not a reason to relax: **never add a broad `cloudflare_dns_record` import or a
`for_each` over existing records to this stack.** The zone is deliberately a `data` source rather
than a resource, so `terraform destroy` cannot take the zone with it.

## Bootstrap — once per environment, by hand

Terraform cannot create the bucket its own state lives in, and must not create the credentials CI is
forbidden to hold. Everything below is the irreducible manual part.

1. **Cloudflare account and zone.** Staging is a *separate account* from production (ADR-0038), with
   its own domain. Add the zone and delegate its nameservers.

2. **R2 bucket for Terraform state**, in that same account:

   ```bash
   pnpm wrangler r2 bucket create nport-tfstate
   ```

   Then an R2 **S3 API token** (R2 → Manage API tokens → Object Read & Write, scoped to that
   bucket). This is not a Cloudflare API token and is not interchangeable with one.

3. **A Cloudflare API token for CI**, scoped to what the deploy actually does and nothing more:
   Account → Workers Scripts → Edit, Account → Workers R2 Storage → Edit, Zone → Zone Settings →
   Edit, Zone → DNS → Edit (wrangler's `custom_domain` writes a record), Zone → Zone WAF → Edit
   (the rate-limit ruleset).

4. **A second, narrower token for the Worker itself** — Account → Cloudflare Tunnel → Edit and
   Zone → DNS → Edit, per `docs/OPERATIONS.md`. **Not the CI token, and not created by Terraform.**
   A stack CI can apply must not be able to mint a token that provisions tunnels; that is the whole
   of ADR-0039.

5. **Worker runtime secrets**, from a laptop, never from CI:

   ```bash
   cd apps/api
   for name in CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID CF_DOMAIN POW_SECRET IP_HASH_SECRET; do
     pnpm wrangler secret put "$name" --env staging
   done
   ```

   `CF_ZONE_ID` and `CF_DOMAIN` are `terraform output` values, so nothing has to be copied out of a
   dashboard. They survive every subsequent deploy — this step is not repeated.

6. **GitHub Environment `staging`**, holding:

   | Kind | Name |
   | --- | --- |
   | secret | `CLOUDFLARE_API_TOKEN` (step 3), `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (step 2) |
   | variable | `STAGING_ZONE`, `STAGING_API_HOST`, `STAGING_SITE_HOST`, `TF_STATE_BUCKET` (all have defaults) |

   Add required reviewers to the Environment if a deploy should pause for a human.

## Running it locally

```bash
cd infra/terraform/staging
cp backend.hcl.example backend.hcl              # fill in the account id
cp terraform.tfvars.example terraform.tfvars    # fill in the account id

export CLOUDFLARE_API_TOKEN=...                 # step 3's token
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # step 2's R2 keys

terraform init -backend-config=backend.hcl
terraform plan
```

`terraform validate` runs without credentials and without the backend
(`terraform init -backend=false`), which is what the gate uses to check the configuration compiles
against the provider schema before any account is involved.

## What CI does with this

`.github/workflows/deploy-staging.yml`: gate → terraform → API and site in parallel → verify. The
apply step consumes the plan file the previous step wrote, so what lands is what was planned. The
verify job asserts `GET /v1/meta` reports the *staging* limits rather than a 200 — a deploy that
silently lost its `vars` returns 200 all day.
