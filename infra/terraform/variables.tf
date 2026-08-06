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
  description = "Requests per period, per client IP, allowed to the control-plane hostname before the edge blocks."
  type        = number
  default     = 600

  validation {
    condition     = var.api_rate_limit_requests >= 120
    error_message = "Below ~120/min this would fire before the Worker's own 60/min per-source limiter, hiding the control it is supposed to sit outside."
  }
}

variable "api_rate_limit_period" {
  description = "The window in seconds. Cloudflare accepts 10, 60, 600 or 3600 and nothing else."
  type        = number
  default     = 60

  validation {
    condition     = contains([10, 60, 600, 3600], var.api_rate_limit_period)
    error_message = "Cloudflare accepts only 10, 60, 600 or 3600 seconds."
  }
}

variable "api_rate_limit_timeout" {
  description = "How long a blocked client stays blocked, in seconds."
  type        = number
  default     = 600
}

# Cloudflare's permission-group names, as variables because they are upstream strings this project
# does not control. If Cloudflare renames one, the fix is a value here rather than a patch to
# secrets.tf — and the precondition there tells you the new name is needed.
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
