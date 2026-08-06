variable "account_id" {
  description = "The Cloudflare account this state bucket belongs to. One bootstrap per account."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "A Cloudflare account id is 32 lowercase hex characters."
  }
}

variable "bucket_name" {
  description = "Must match `bucket` in the main root's backend.hcl."
  type        = string
  default     = "nport-tfstate"
}

variable "r2_permission_group" {
  description = "Cloudflare's name for the group granting R2 read/write. An upstream string this project does not control."
  type        = string
  default     = "Workers R2 Storage Write"
}
