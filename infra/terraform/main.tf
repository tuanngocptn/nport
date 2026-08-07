# The Cloudflare resources wrangler cannot express, for whichever account the inputs name.
#
# Identical for staging and production by construction: same resources, same settings, same rule.
# Only `account_id` and `zone_name` differ, and both arrive as variables (ADR-0038).
#
# ## What is deliberately absent
#
# **No DNS records for the Workers.** `apps/node/wrangler.jsonc` and `apps/web/wrangler.jsonc` declare
# their hostnames with `custom_domain: true`, and that is what creates the record — the repo is the
# source of truth for both (`docs/OPERATIONS.md` § Inventory). Declaring the same name here would put
# two tools on one record, and each apply would fight the last deploy.
#
# **No tunnel records, ever.** The control plane creates and deletes `<name>.<zone>` CNAMEs at
# runtime; there are as many as there are live tunnels and none of them are known here. Terraform
# only destroys what its own state created, so this is safe by construction rather than by care — but
# it is the reason this stack must never grow a broad `cloudflare_dns_records` import.
#
# **No Cloudflare credential, here or anywhere in this configuration** (ADR-0043). The generated
# secrets live in `secrets.tf` and grant no authority; the Worker's Cloudflare token is made by hand
# and reaches it as a GitHub secret. A stack that could mint a token would need a CI credential that
# could mint *any* token, which is a far larger thing to hold than the one it would automate.

# Scoped to the account on purpose, and it matters more now that one configuration serves both
# environments. A token with access to more than one account would otherwise match a zone of the same
# name elsewhere, and the first thing this stack does after finding a zone is change its TLS floor.
# Pairing the zone with its account is what makes "wrong credentials" fail to plan rather than apply
# staging's settings to production.
data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
    account = {
      id = var.account_id
    }
  }
}

locals {
  api_hostname = "${var.api_subdomain}.${var.zone_name}"

  # `nodeProofRecordName` and `nodeProofRecordValue` from `packages/contract/src/node.ts`, which is the
  # authority for both strings (`apps/registry/CLAUDE.md`). Restated here because Terraform cannot
  # import TypeScript, and held equal to the contract by `pnpm deploy:check` — which reads the two
  # functions and this file and fails the deploy if they disagree.
  node_proof_name  = "_nport-node.${var.zone_name}"
  node_proof_value = "nport-node=${var.node_id}"
}

# ── The node's own domain proof ─────────────────────────────────────────────────────────
#
# **The registry refuses a registration whose domain is not proved, and this is the proof** (ADR-0031,
# ADR-0049). It resolves `_nport-node.<domain>` over DNS-over-HTTPS and requires a TXT record naming
# the node id; without one, the node registers every five minutes, is refused `proof-missing`, and
# swallows the failure by design — a directory that stays empty and a log line nobody is reading.
#
# That is exactly what happened on staging's first deploy of this design: gateway, node and registry
# all green, `/v1/nodes` returning `[]`, and nothing anywhere saying why. `docs/SELF_HOSTING.md` calls
# publishing this record "the operator's job", which is right for a third party and wrong for us — we
# *are* the operator of node #1, we own the zone in Terraform already, and a manual DNS entry is a
# step that gets forgotten once and then looks like a bug in the registry.
#
# **It is not self-certifying.** Only someone holding a zone-scoped Cloudflare credential can create
# this record, which is precisely the control the proof tests for. What it removes is the *manual*
# step, not the authority requirement.
#
# `_`-prefixed, so no tunnel claim can ever collide with it: underscores never pass
# `SUBDOMAIN_PATTERN`, the same reasoning `_acme-challenge` rests on.
resource "cloudflare_dns_record" "node_proof" {
  zone_id = data.cloudflare_zone.this.zone_id
  name    = local.node_proof_name
  type    = "TXT"
  # The provider takes the unquoted string and adds the wire quoting itself. `nodeProofSatisfied`
  # strips quotes on the way back in anyway, because resolvers disagree about returning them.
  content = local.node_proof_value
  # Short, because a node id change should take effect within a cron period rather than a day. The
  # record is not on any request path — only the registry reads it, once per registration.
  ttl     = 300
  comment = "Proves this zone to the NPort node directory. Managed by infra/terraform."
}

# ── Zone settings ──────────────────────────────────────────────────────────────────────
#
# The connector dials the edge over QUIC and the CLI talks to the control plane over HTTPS; neither
# has any reason to negotiate an obsolete TLS version. Set here rather than in the dashboard so both
# accounts are configured the same way, and so a drift shows up in a plan.

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

resource "cloudflare_zone_setting" "tls_1_3" {
  zone_id    = data.cloudflare_zone.this.zone_id
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
  zone_id     = data.cloudflare_zone.this.zone_id
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

  lifecycle {
    # Checked as a *rate*, because the count alone is meaningless without the window — and the window
    # is not ours to choose. The rulesets API accepts 10, 60, 600 and 3600, but a zone is only
    # *entitled* to some of them: on the free plan the API refuses anything but 10, which is a
    # sentence you only read after an apply has already created half the stack.
    #
    # The Worker's own limiter allows 60 requests a minute per source. At or below 1/s this rule fires
    # first and hides the control it is supposed to sit outside.
    precondition {
      condition     = var.api_rate_limit_requests / var.api_rate_limit_period > 1
      error_message = "The edge limit is ${var.api_rate_limit_requests}/${var.api_rate_limit_period}s, at or below the Worker's own 60/min per source. Raise the count or shorten the window, or the inner control becomes unreachable."
    }
  }
}
