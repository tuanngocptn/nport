# Terraform and provider pins.
#
# **One configuration, both environments.** Staging and production run the same infrastructure in
# separate Cloudflare accounts (ADR-0038); the only things that differ are the inputs — the account,
# the zone, and which state file the backend writes. Two directories would drift the first time
# somebody changed one and not the other, and the drift would be invisible until a production apply.
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
    # Generates the HMAC keys. Kept in state like every other secret here (ADR-0040) rather than
    # typed in by a person, so nobody has to invent entropy and nobody has to remember to rotate.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State in HCP Terraform (app.terraform.io).
  #
  # Chosen over an R2 bucket because the bucket had to exist before Terraform could initialise, and
  # every way of resolving that put a bootstrap step somewhere — a second root with its own state, or
  # a script deriving S3 credentials before the run. HCP has nothing to create first: a token is the
  # whole configuration, and state locking and run history come with it (ADR-0042).
  #
  # **Nothing is named here.** The organization comes from `TF_CLOUD_ORGANIZATION` and the workspace
  # from `TF_WORKSPACE`, both set per environment by the deploy. That keeps this file identical for
  # staging and production, which is the same reason `key` was never defaulted when state lived in a
  # bucket: a default is the wrong value for whichever environment forgot to override it.
  #
  # Workspaces must run in **local execution mode** — HCP stores the state, CI runs the plan. In
  # remote mode HCP would execute the run on its own infrastructure and the Cloudflare credentials
  # would have to be duplicated there as workspace variables.
  cloud {
    workspaces {
      tags = ["nport"]
    }
  }
}

# The token comes from `CLOUDFLARE_API_TOKEN` in the environment, never from a variable.
#
# A `.tfvars` file holding a token would be one `git add -A` away from the repository, and the
# provider reads this variable natively — so there is nothing to pass and nothing to leak.
provider "cloudflare" {}
