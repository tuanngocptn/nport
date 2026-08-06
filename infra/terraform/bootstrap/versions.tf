# Breaks the chicken-and-egg: Terraform's state cannot live in a bucket Terraform has not created.
#
# **This root has no backend and keeps its state locally, on purpose.** It runs once per Cloudflare
# account, creates the bucket the *main* root's state lives in, and then has nothing left to do.
#
# Losing `terraform.tfstate` here is not an incident. The bucket and the token it created still
# exist; Terraform simply stops tracking them, and nothing else depends on this state. That is why it
# is acceptable for it to be local and untracked, and why this is not the environment split that
# `infra/terraform/README.md` argues against — it is one directory shared by every environment,
# not one per environment.

terraform {
  required_version = ">= 1.11"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
  }
}

provider "cloudflare" {}
