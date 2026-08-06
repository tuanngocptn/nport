# The Worker's runtime secrets, owned here (ADR-0040).
#
# ## What this means, stated plainly
#
# **Everything below is readable by anyone who can read the Terraform state.** `random_password`
# keeps its result in state, and `cloudflare_api_token` keeps the minted token in state, because
# that is how Terraform works — it must know a value to tell whether it has drifted. The trust
# boundary is therefore the R2 bucket and the two keys that open it, and it is no longer six
# separate values in six places.
#
# That is the trade this makes: one credential to protect and rotate instead of a manual
# `wrangler secret put` per secret per environment, at the cost of the state file becoming the most
# sensitive object in the deployment. Guard it accordingly — the bucket is not public, its keys are
# scoped to it alone, and `terraform output` is the only thing that should ever print these.

resource "random_password" "pow" {
  length  = 64
  special = false
}

resource "random_password" "ip_hash" {
  length  = 64
  special = false
}

# The two permission groups the control plane actually needs, looked up by name rather than pasted
# as opaque ids. Cloudflare's group ids are account-independent but nobody can read one and tell what
# it grants; a name in the config is reviewable, an id is not.
#
# If either lookup comes back empty, the name has changed upstream — the precondition below says so
# rather than letting a token be created with no permissions, which fails much later and much less
# clearly, on the first tunnel someone tries to provision.
data "cloudflare_account_api_token_permission_groups_list" "tunnel" {
  account_id = var.account_id
  name       = var.tunnel_permission_group
  scope      = "com.cloudflare.api.account"
}

data "cloudflare_account_api_token_permission_groups_list" "dns" {
  account_id = var.account_id
  name       = var.dns_permission_group
  scope      = "com.cloudflare.api.account.zone"
}

resource "cloudflare_api_token" "worker" {
  name = "nport control plane (${var.zone_name})"

  policies = [
    {
      effect            = "allow"
      permission_groups = [{ id = data.cloudflare_account_api_token_permission_groups_list.tunnel.result[0].id }]
      resources = {
        "com.cloudflare.api.account.${var.account_id}" = "*"
      }
    },
    {
      effect            = "allow"
      permission_groups = [{ id = data.cloudflare_account_api_token_permission_groups_list.dns.result[0].id }]
      resources = {
        "com.cloudflare.api.account.zone.${data.cloudflare_zone.this.zone_id}" = "*"
      }
    },
  ]

  lifecycle {
    precondition {
      condition     = length(data.cloudflare_account_api_token_permission_groups_list.tunnel.result) > 0
      error_message = "No account permission group named ${var.tunnel_permission_group}. List the real names with: curl -s -H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" https://api.cloudflare.com/client/v4/accounts/${var.account_id}/tokens/permission_groups | jq -r '.result[].name'"
    }
    precondition {
      condition     = length(data.cloudflare_account_api_token_permission_groups_list.dns.result) > 0
      error_message = "No zone permission group named ${var.dns_permission_group}. List the real names with the same call and filter on scope com.cloudflare.api.account.zone."
    }
  }
}
