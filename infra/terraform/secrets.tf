# The Worker's runtime secrets, owned here (ADR-0040).
#
# ## What this means, stated plainly
#
# **Everything below is readable by anyone who can read the Terraform state.** `random_password`
# keeps its result in state, and `cloudflare_api_token` keeps the minted token in state, because
# that is how Terraform works — it must know a value to tell whether it has drifted. The trust
# boundary is therefore the HCP Terraform workspace and the token that opens it (ADR-0042), and it is
# no longer six separate values in six places.
#
# That is the trade this makes: one credential to protect and rotate instead of a manual
# `wrangler secret put` per secret per environment, at the cost of the state becoming the most
# sensitive object in the deployment. Guard it accordingly — `terraform output` is the only thing
# that should ever print these.

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
#
# **The user-scoped catalogue, not the account-scoped one.** Permission group ids are global, so both
# return the same answer, but they sit behind different permissions: the account variant needs
# `Account -> API Tokens`, which the CI token otherwise has no reason to hold. Since minting the token
# below already requires `User -> API Tokens` (`POST /user/tokens`), reading the catalogue through the
# same scope costs nothing and removes a permission from the CI token entirely — see docs/DEPLOYMENT.md
# section 2, whose table is exactly the set that survives this choice.
data "cloudflare_api_token_permission_groups_list" "tunnel" {
  name  = var.tunnel_permission_group
  scope = "com.cloudflare.api.account"
}

data "cloudflare_api_token_permission_groups_list" "dns" {
  name  = var.dns_permission_group
  scope = "com.cloudflare.api.account.zone"
}

resource "cloudflare_api_token" "worker" {
  name = "nport control plane (${var.zone_name})"

  policies = [
    {
      effect            = "allow"
      permission_groups = [{ id = data.cloudflare_api_token_permission_groups_list.tunnel.result[0].id }]
      # A JSON *string*, not an object — the provider types this attribute as a string whose contents
      # are json ("A json object representing the resources"). `terraform validate` accepts the object
      # form and only `plan` rejects it, so this is not a mistake the gate can catch.
      resources = jsonencode({
        "com.cloudflare.api.account.${var.account_id}" = "*"
      })
    },
    {
      effect            = "allow"
      permission_groups = [{ id = data.cloudflare_api_token_permission_groups_list.dns.result[0].id }]
      resources = jsonencode({
        "com.cloudflare.api.account.zone.${data.cloudflare_zone.this.zone_id}" = "*"
      })
    },
  ]

  lifecycle {
    precondition {
      condition     = length(data.cloudflare_api_token_permission_groups_list.tunnel.result) > 0
      error_message = "No permission group named ${var.tunnel_permission_group} with scope com.cloudflare.api.account. List the real names with: curl -s -H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" https://api.cloudflare.com/client/v4/user/tokens/permission_groups | jq -r '.result[] | \"\\(.name)\\t\\(.scopes[0])\"'"
    }
    precondition {
      condition     = length(data.cloudflare_api_token_permission_groups_list.dns.result) > 0
      error_message = "No permission group named ${var.dns_permission_group} with scope com.cloudflare.api.account.zone. List the real names with the same call as above."
    }
  }
}
