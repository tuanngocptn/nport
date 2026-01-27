/**
 * Analytics type definitions
 * 
 * These types define the structure of analytics events
 * and tracking data.
 */

/**
 * Base analytics event
 */
export interface AnalyticsEvent {
  /** Event name */
  name: string;
  /** Event parameters */
  params: Record<string, string | number | boolean>;
  /** Timestamp when event occurred */
  timestamp?: number;
}

/**
 * CLI start event parameters
 */
export interface CliStartEventParams {
  /** Port being tunneled */
  port: string;
  /** Whether a custom subdomain was provided */
  has_custom_subdomain: boolean;
  /** CLI version */
  cli_version: string;
}

/**
 * Tunnel created event parameters
 */
export interface TunnelCreatedEventParams {
  /** Type of subdomain (random or custom) */
  subdomain_type: 'random' | 'custom';
  /** Port being tunneled */
  port: string;
}

/**
 * Tunnel error event parameters
 */
export interface TunnelErrorEventParams {
  /** Type of error */
  error_type: string;
  /** Error message (truncated) */
  error_message: string;
}

/**
 * Tunnel shutdown event parameters
 */
export interface TunnelShutdownEventParams {
  /** Reason for shutdown */
  shutdown_reason: 'manual' | 'timeout' | 'error';
  /** Duration in seconds */
  duration_seconds: string;
}

/**
 * Update available event parameters
 */
export interface UpdateAvailableEventParams {
  /** Current version */
  current_version: string;
  /** Latest version */
  latest_version: string;
}

/**
 * System information for analytics context
 */
export interface SystemInfo {
  /** Operating system platform */
  os_platform: string;
  /** OS version */
  os_version: string;
  /** CPU architecture */
  os_arch: string;
  /** Node.js version */
  node_version: string;
}

/**
 * GA4 Measurement Protocol payload
 */
export interface GA4Payload {
  /** Client ID (user identifier) */
  client_id: string;
  /** Array of events */
  events: Array<{
    /** Event name */
    name: string;
    /** Event parameters */
    params: Record<string, string | number | boolean>;
  }>;
}
