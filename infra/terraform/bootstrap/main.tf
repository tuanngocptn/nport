# The two things the main root cannot create for itself.

# `prevent_destroy` because this bucket holds the state of everything else. A `terraform destroy`
# that took it would leave the real infrastructure standing with nothing tracking it — the worst of
# both outcomes, and unrecoverable without importing every resource by hand.
resource "cloudflare_r2_bucket" "state" {
  account_id = var.account_id
  name       = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

data "cloudflare_account_api_token_permission_groups_list" "r2" {
  account_id = var.account_id
  name       = var.r2_permission_group
  scope      = "com.cloudflare.api.account"
}

# Scoped to R2 alone. The main root's token can reach Workers, DNS and the WAF; this one can only
# read and write objects, which is all the state backend does. Two credentials with different reach
# is the point — the one CI uses most often is the one that can do least.
resource "cloudflare_api_token" "state" {
  name = "nport terraform state (${var.bucket_name})"

  policies = [
    {
      effect            = "allow"
      permission_groups = [{ id = data.cloudflare_account_api_token_permission_groups_list.r2.result[0].id }]
      resources = {
        "com.cloudflare.api.account.${var.account_id}" = "*"
      }
    },
  ]

  lifecycle {
    precondition {
      condition     = length(data.cloudflare_account_api_token_permission_groups_list.r2.result) > 0
      error_message = "No account permission group named ${var.r2_permission_group}. List the real names with: curl -s -H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" https://api.cloudflare.com/client/v4/accounts/${var.account_id}/tokens/permission_groups | jq -r '.result[].name'"
    }
  }
}
