# The Worker's *generated* runtime secrets (ADR-0043).
#
# ## What this means, stated plainly
#
# **Everything below is readable by anyone who can read the Terraform state.** `random_password`
# keeps its result in state because that is how Terraform works — it must know a value to tell
# whether it has drifted. The trust boundary is therefore the HCP Terraform workspace and the token
# that opens it (ADR-0042).
#
# **Nothing here is a Cloudflare credential.** These two are HMAC keys: they authenticate this
# deployment's own artifacts to itself and grant no authority anywhere. The Worker's Cloudflare token
# is created by hand and delivered as a GitHub secret, so that nothing in this configuration — and
# therefore nothing CI can run — is able to mint Cloudflare authority. ADR-0043 records why that is
# worth one manual step per account.

resource "random_password" "pow" {
  length  = 64
  special = false
}

resource "random_password" "ip_hash" {
  length  = 64
  special = false
}
