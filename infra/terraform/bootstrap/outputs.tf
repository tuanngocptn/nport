# R2's S3-compatible API does not take a Cloudflare token directly. It takes an access key pair
# **derived** from one: the key id is the token's id, and the secret is the SHA-256 of the token's
# value. That derivation is Cloudflare's, documented for the R2 S3 API, and it is why these can be
# produced here rather than copied out of the dashboard.
#
# If `terraform init` in the main root fails to authenticate, this derivation is the first thing to
# doubt — fall back to creating an R2 API token in the dashboard, which shows the pair directly.

output "backend_hcl" {
  description = "Paste into infra/terraform/backend.hcl. Contains no credentials."
  value       = <<-EOT
    bucket    = "${cloudflare_r2_bucket.state.name}"
    endpoints = { s3 = "https://${var.account_id}.r2.cloudflarestorage.com" }
    key       = "<environment>/terraform.tfstate"
  EOT
}

output "r2_access_key_id" {
  description = "AWS_ACCESS_KEY_ID for the state backend, and the R2_ACCESS_KEY_ID repository secret."
  value       = cloudflare_api_token.state.id
  sensitive   = true
}

output "r2_secret_access_key" {
  description = "AWS_SECRET_ACCESS_KEY for the state backend, and the R2_SECRET_ACCESS_KEY repository secret."
  value       = sha256(cloudflare_api_token.state.value)
  sensitive   = true
}
