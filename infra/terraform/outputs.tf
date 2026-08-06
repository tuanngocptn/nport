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

# `REQUIRED_SECRETS` in `apps/api/src/env.ts` minus `CF_API_TOKEN`, as the JSON map that
# `wrangler secret bulk` reads.
#
# Named to match that list on purpose: the Worker refuses to start when one is missing, so a key
# renamed on one side and not the other fails at the first request rather than silently.
# `pnpm deploy:check` compares the two lists and knows which single name the workflow adds.
#
# **`CF_API_TOKEN` is deliberately absent.** It is the only value here that carries Cloudflare
# authority, and it is created by hand and delivered as a GitHub secret precisely so that this
# configuration cannot mint one — which is what let the CI token drop `User -> API Tokens -> Edit`
# (ADR-0043). The deploy workflow merges it in before calling wrangler.
output "worker_secrets" {
  description = "The Worker's five generated runtime secrets, as JSON. Sensitive."
  sensitive   = true
  value = jsonencode({
    POW_SECRET     = random_password.pow.result
    IP_HASH_SECRET = random_password.ip_hash.result
    CF_ACCOUNT_ID  = var.account_id
    CF_ZONE_ID     = data.cloudflare_zone.this.zone_id
    CF_DOMAIN      = var.zone_name
  })
}
