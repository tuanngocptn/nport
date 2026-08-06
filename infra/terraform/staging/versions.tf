# Terraform and provider pins for the staging account.
#
# Pinned exactly, for the same reason `rust-toolchain.toml` pins a stable version rather than
# `stable` (`docs/conventions/rust.md`): a provider that moves under a deploy is noise nobody needs
# mid-incident. The Cloudflare provider went through a generated rewrite at v5 with different
# resource shapes, so a floating major would not merely churn — it would fail to plan.

terraform {
  required_version = ">= 1.11"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
  }

  # State in R2, through the S3-compatible API.
  #
  # The bucket itself is **not** managed here — it holds this state, and a resource cannot create the
  # store its own state lives in. `infra/terraform/README.md` § Bootstrap creates it once by hand.
  #
  # Everything below is filled in by `-backend-config=backend.hcl`, because a backend block cannot
  # take variables and the account id does not belong in the repository. The `skip_*` flags and
  # `use_path_style` are what make the AWS backend talk to R2 rather than to S3; without them the
  # SDK tries to resolve a region and validate credentials against endpoints that do not exist here.
  #
  # `use_lockfile` is S3-native locking (conditional writes), which R2 supports — so there is no
  # DynamoDB table to run and no way for two CI runs to apply at once.
  backend "s3" {
    key = "staging/terraform.tfstate"

    region                      = "auto"
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

# The token comes from `CLOUDFLARE_API_TOKEN` in the environment, never from a variable.
#
# A `.tfvars` file holding a token would be one `git add -A` away from the repository, and the
# provider reads this variable natively — so there is nothing to pass and nothing to leak.
provider "cloudflare" {}
