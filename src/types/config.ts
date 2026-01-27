/**
 * Configuration type definitions
 * 
 * These types define the structure of application configuration,
 * user preferences, and runtime settings.
 */

/**
 * Parsed command-line arguments
 */
export interface ParsedArguments {
  /** Local port to tunnel (default: 8080) */
  port: number;
  /** Subdomain to use (generated if not provided) */
  subdomain: string;
  /** Language code, 'prompt', or null */
  language: string | null;
  /** Custom backend URL or null */
  backendUrl: string | null;
  /** Backend URL to save, 'clear', or null */
  setBackend: string | null;
}

/**
 * User configuration stored in ~/.nport/config.json
 */
export interface UserConfig {
  /** Preferred language code (e.g., "en", "vi") */
  language?: string;
  /** Custom backend URL */
  backendUrl?: string;
}

/**
 * Application constants configuration
 */
export interface AppConfig {
  /** npm package name */
  PACKAGE_NAME: string;
  /** Current package version */
  CURRENT_VERSION: string;
  /** Backend API URL */
  BACKEND_URL: string;
  /** Default port if not specified */
  DEFAULT_PORT: number;
  /** Prefix for random subdomains */
  SUBDOMAIN_PREFIX: string;
  /** Auto-cleanup timeout in hours */
  TUNNEL_TIMEOUT_HOURS: number;
  /** Timeout for npm version check in ms */
  UPDATE_CHECK_TIMEOUT: number;
}

/**
 * Platform-specific configuration
 */
export interface PlatformConfig {
  /** True if running on Windows */
  IS_WINDOWS: boolean;
  /** Binary filename ("cloudflared" or "cloudflared.exe") */
  BIN_NAME: string;
}

/**
 * File system paths configuration
 */
export interface PathsConfig {
  /** Directory containing the cloudflared binary */
  BIN_DIR: string;
  /** Full path to the cloudflared binary */
  BIN_PATH: string;
}

/**
 * Log pattern categories for filtering cloudflared output
 */
export interface LogPatterns {
  /** Patterns indicating successful connection */
  readonly SUCCESS: readonly string[];
  /** Patterns indicating critical errors */
  readonly ERROR: readonly string[];
  /** Patterns for network connectivity issues */
  readonly NETWORK_WARNING: readonly string[];
  /** Patterns for harmless messages to suppress */
  readonly IGNORE: readonly string[];
}

/**
 * Network warning display configuration
 */
export interface NetworkConfig {
  /** Number of errors before showing warning */
  WARNING_THRESHOLD: number;
  /** Minimum ms between warnings */
  WARNING_COOLDOWN: number;
}
