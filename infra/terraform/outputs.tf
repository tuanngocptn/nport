# Consumed by the deploy workflow and by `wrangler secret put` during bootstrap, so nobody has to
# copy an identifier out of a dashboard and get one character wrong.

output "zone_id" {
  description = "Set as the Worker's CF_ZONE_ID secret during bootstrap."
  value       = data.cloudflare_zone.staging.zone_id
}

output "zone_name" {
  description = "Set as the Worker's CF_DOMAIN secret. Tunnels are provisioned under this apex."
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
