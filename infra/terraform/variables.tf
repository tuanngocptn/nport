variable "account_id" {
  description = "The Cloudflare account to apply to. Staging and production are separate accounts, not separate zones (ADR-0038)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "A Cloudflare account id is 32 lowercase hex characters."
  }
}

variable "zone_name" {
  description = "The apex domain for this environment: nport.online for staging, nport.link for production."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+\\.[a-z.]+$", var.zone_name))
    error_message = "Expected a bare apex domain such as nport.online, with no scheme and no trailing dot."
  }
}

variable "api_subdomain" {
  description = "Hostname prefix for the control plane. The Worker's own route in wrangler.jsonc must agree with this."
  type        = string
  default     = "api"
}

# The outermost of the four abuse controls (`docs/ARCHITECTURE.md` §7), and the one the runbook had
# left as _TBD_. It is deliberately far above the Worker's own per-source limiter at 60 requests a
# minute: this rule exists to stop a flood at the edge before it becomes Worker invocations, not to
# do the per-source accounting the Worker already does better. Set it below the Worker's limit and
# the inner control becomes unreachable and untested.
variable "api_rate_limit_requests" {
  description = "Requests per period, per client IP per colo, allowed to the control-plane hostname before the edge blocks."
  type        = number
  default     = 100
}

variable "api_rate_limit_period" {
  description = "The window in seconds. The rulesets API accepts 10, 60, 600 or 3600, but a plan is only *entitled* to some of them — free is 10 alone, which is what the API says when it refuses."
  type        = number
  default     = 10

  validation {
    condition     = contains([10, 60, 600, 3600], var.api_rate_limit_period)
    error_message = "The rulesets API accepts only 10, 60, 600 or 3600 seconds."
  }
}

variable "api_rate_limit_timeout" {
  description = "How long a blocked client stays blocked, in seconds. A plan may pin this: free refuses anything other than the period itself, which the API states as \"not entitled to use a mitigation timeout different from 10\"."
  type        = number
  default     = 10
}

variable "tunnel_permission_group" {
  description = "Account-scoped group granting tunnel create/delete. `docs/OPERATIONS.md`: Account → Cloudflare Tunnel → Edit."
  type        = string
  default     = "Cloudflare Tunnel Write"
}

variable "dns_permission_group" {
  description = "Zone-scoped group granting DNS record create/delete. `docs/OPERATIONS.md`: Zone → DNS → Edit."
  type        = string
  default     = "DNS Write"
}
