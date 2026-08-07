# The Worker's *generated* runtime secrets (ADR-0043).
#
# ## What this means, stated plainly
#
# **Everything below is readable by anyone who can read the Terraform state.** `random_password`
# keeps its result in state because that is how Terraform works — it must know a value to tell
# whether it has drifted. The trust boundary is therefore the HCP Terraform workspace and the token
# that opens it (ADR-0042).
#
# **Nothing here is a Cloudflare credential.** All three are HMAC keys: they authenticate this
# deployment's own artifacts to itself and grant no authority anywhere. The Worker's Cloudflare token
# is created by hand and delivered as a GitHub secret, so that nothing in this configuration — and
# therefore nothing CI can run — is able to mint Cloudflare authority. ADR-0043 records why that is
# worth one manual step per account.

# Signs the node's proof-of-work challenges, for `POST /v1/tunnels`.
resource "random_password" "pow" {
  length  = 64
  special = false
}

# Signs the *registry's* proof-of-work challenges, for `POST /v1/nodes`.
#
# **A second key, and it must never be the same value as the one above.** Both services issue a
# challenge and verify a solution with the same algorithm; if they shared a key, a challenge issued by
# a node would be redeemable at the registry and the reverse. The registry's write path — enrolling a
# node into the public directory — would then be gated by whatever the cheapest node in the world
# charges for a tunnel create.
#
# Two `random_password` resources rather than one used twice: two independent values are the property
# we want, and a single resource referenced in two places is one edit away from not having it
# (ADR-0049).
resource "random_password" "registry_pow" {
  length  = 64
  special = false
}

# Keys the source-identity HMAC. **The gateway's, and only the gateway's** — it is the one Worker that
# ever sees an address, and the two behind it receive the hash (ADR-0049).
resource "random_password" "ip_hash" {
  length  = 64
  special = false
}
