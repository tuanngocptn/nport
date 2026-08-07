# Consumed by the deploy workflow, so nobody has to copy an identifier out of a dashboard and get
# one character wrong. The Worker's own copies of these arrive through `worker_secrets` below.

output "zone_id" {
  description = "The zone every tunnel is provisioned under. Also reaches the Worker as CF_ZONE_ID."
  value       = data.cloudflare_zone.this.zone_id
}

output "zone_name" {
  description = "The apex domain. Also reaches the Worker as CF_DOMAIN."
  value       = var.zone_name
}

output "api_hostname" {
  description = "The control plane's hostname. The deploy workflow's health check uses it."
  value       = local.api_hostname
}

output "api_rate_limit" {
  description = "The edge rate limit as applied, for the runbook to quote rather than restate."
  value       = "${var.api_rate_limit_requests} requests / ${var.api_rate_limit_period}s per IP per colo, blocked for ${var.api_rate_limit_timeout}s"
}

# Every Worker's generated runtime secrets, **keyed by Worker name**, as the JSON `wrangler secret
# bulk` reads once the deploy has picked one out.
#
# Per Worker rather than one flat map, and the reason is not tidiness: `apps/node` and `apps/registry`
# both require a secret called `POW_SECRET` and the two values **must differ** (ADR-0049, `secrets.tf`).
# One flat map cannot hold both under that name, and giving one of them a distinguishing name in
# Terraform would mean the Worker reading a key called something other than what it requires.
#
# The keys inside each object match that app's `REQUIRED_SECRETS` in `src/env.ts` on purpose: a Worker
# refuses to start when one is missing, so a key renamed on one side and not the other fails at the
# first request rather than silently. `pnpm deploy:check` compares the two lists per app and knows
# which single name the workflow adds.
#
# **`CF_API_TOKEN` is deliberately absent.** It is the only value here that would carry Cloudflare
# authority, and it is created by hand and delivered as a GitHub secret precisely so that this
# configuration cannot mint one — which is what let the CI token drop `User -> API Tokens -> Edit`
# (ADR-0043). The deploy workflow merges it into the node's set before calling wrangler.
#
# The gateway gets `IP_HASH_SECRET` and nothing else, and holds no Cloudflare credential at all: it
# terminates every public request, so it is the largest attack surface in a deployment and the one
# component that must not be able to provision anything.
output "worker_secrets" {
  description = "Generated runtime secrets per Worker, as JSON. Sensitive."
  sensitive   = true
  value = jsonencode({
    "nport-node" = {
      POW_SECRET    = random_password.pow.result
      CF_ACCOUNT_ID = var.account_id
      CF_ZONE_ID    = data.cloudflare_zone.this.zone_id
      CF_DOMAIN     = var.zone_name
    }
    "nport-registry" = {
      POW_SECRET = random_password.registry_pow.result
    }
    "nport-gateway" = {
      IP_HASH_SECRET = random_password.ip_hash.result
    }
  })
}
