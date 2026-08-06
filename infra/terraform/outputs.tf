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

# Exactly `REQUIRED_SECRETS` in `apps/api/src/env.ts`, as the JSON map `wrangler secret bulk` reads.
#
# Named to match that list on purpose: the Worker refuses to start when one is missing, so a key
# renamed on one side and not the other fails at the first request rather than silently. Piping this
# straight into wrangler is what removes the manual `wrangler secret put` per secret per environment
# (ADR-0040).
#
#   terraform output -raw worker_secrets | pnpm wrangler secret bulk --env <name>
output "worker_secrets" {
  description = "The Worker's six runtime secrets, as JSON. Sensitive: this is the whole credential set."
  sensitive   = true
  value = jsonencode({
    POW_SECRET     = random_password.pow.result
    IP_HASH_SECRET = random_password.ip_hash.result
    CF_API_TOKEN   = cloudflare_api_token.worker.value
    CF_ACCOUNT_ID  = var.account_id
    CF_ZONE_ID     = data.cloudflare_zone.this.zone_id
    CF_DOMAIN      = var.zone_name
  })
}
