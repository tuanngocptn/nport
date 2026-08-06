# Staging infrastructure for the separate Cloudflare account (ADR-0038).
#
# ## What is deliberately absent
#
# **No DNS records for the Workers.** `apps/api/wrangler.jsonc` and `apps/web/wrangler.jsonc` declare
# their hostnames with `custom_domain: true`, and that is what creates the record — the repo is the
# source of truth for both (`docs/OPERATIONS.md` § Inventory). Declaring the same name here would put
# two tools on one record, and each apply would fight the last deploy.
#
# **No tunnel records, ever.** The control plane creates and deletes `<name>.<zone>` CNAMEs at
# runtime; there are as many as there are live tunnels and none of them are known here. Terraform
# only destroys what its own state created, so this is safe by construction rather than by care — but
# it is the reason this stack must never grow a broad `cloudflare_dns_records` import.
#
# **No API tokens and no Worker secrets** (ADR-0039). Everything in this file is applied by CI, and
# `docs/OPERATIONS.md` § Secrets says the Worker's runtime credentials never pass through Actions. A
# stack that could mint a Tunnel-Edit token would hand CI the authority that rule exists to withhold.

# Scoped to the account on purpose. A token with access to more than one account would otherwise
# match a zone of the same name elsewhere, and the first thing this stack does after finding a zone
# is change its TLS floor — a lookup that can silently resolve to the wrong account is not one to
# leave loose.
data "cloudflare_zone" "staging" {
  filter = {
    name = var.zone_name
    account = {
      id = var.account_id
    }
  }
}

locals {
  api_hostname = "${var.api_subdomain}.${var.zone_name}"
}

# ── Zone settings ──────────────────────────────────────────────────────────────────────
#
# The connector dials the edge over QUIC and the CLI talks to the control plane over HTTPS; neither
# has any reason to negotiate an obsolete TLS version. Set here rather than in the dashboard so the
# staging account starts where production should end up, and so a drift shows in a plan.

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = data.cloudflare_zone.staging.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = data.cloudflare_zone.staging.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

resource "cloudflare_zone_setting" "tls_1_3" {
  zone_id    = data.cloudflare_zone.staging.zone_id
  setting_id = "tls_1_3"
  value      = "on"
}

# ── Edge rate limiting on the control plane ────────────────────────────────────────────
#
# `docs/OPERATIONS.md` § Cloudflare setup step 7 has carried "_TBD_ threshold" since the runbook was
# written. This is that threshold, in a file rather than in a dashboard.
#
# `cf.colo.id` sits alongside `ip.src` in the characteristics because Cloudflare requires the colo
# dimension outside Enterprise: the counter is per-IP *per data centre*, so the effective global
# allowance is higher than the number here. That is a property of the platform worth knowing before
# reading the number as an absolute.

resource "cloudflare_ruleset" "api_rate_limit" {
  zone_id     = data.cloudflare_zone.staging.zone_id
  name        = "control-plane rate limit"
  description = "Outermost abuse control for ${local.api_hostname} (docs/ARCHITECTURE.md §7)."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      ref         = "api_flood"
      description = "Block a single source flooding the control plane."
      expression  = "(http.host eq \"${local.api_hostname}\")"
      action      = "block"
      enabled     = true

      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = var.api_rate_limit_period
        requests_per_period = var.api_rate_limit_requests
        mitigation_timeout  = var.api_rate_limit_timeout
      }
    }
  ]
}
