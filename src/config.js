import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

/**
 * Gets the backend URL based on priority order.
 * 
 * Priority:
 * 1. Environment variable (NPORT_BACKEND_URL)
 * 2. Saved config (set by config-manager if available)
 * 3. Default (https://api.nport.link)
 * 
 * @returns {string} The backend URL to use
 * @private
 */
function getBackendUrl() {
  // Priority 1: Environment variable
  if (process.env.NPORT_BACKEND_URL) {
    return process.env.NPORT_BACKEND_URL;
  }
  
  // Priority 2: Saved config (will be set by config-manager if available)
  // Priority 3: Default
  return "https://api.nport.link";
}

/**
 * Application configuration constants.
 * 
 * These values are used throughout the application for:
 * - Package metadata (name, version)
 * - API endpoints
 * - Default values
 * - Timing configurations
 * 
 * @constant {Object}
 * @property {string} PACKAGE_NAME - npm package name ("nport")
 * @property {string} CURRENT_VERSION - Current package version from package.json
 * @property {string} BACKEND_URL - Backend API URL
 * @property {number} DEFAULT_PORT - Default port if not specified (8080)
 * @property {string} SUBDOMAIN_PREFIX - Prefix for random subdomains ("user-")
 * @property {number} TUNNEL_TIMEOUT_HOURS - Auto-cleanup timeout (4 hours)
 * @property {number} UPDATE_CHECK_TIMEOUT - Timeout for npm version check (3000ms)
 */
export const CONFIG = {
  PACKAGE_NAME: packageJson.name,
  CURRENT_VERSION: packageJson.version,
  BACKEND_URL: getBackendUrl(),
  DEFAULT_PORT: 8080,
  SUBDOMAIN_PREFIX: "user-",
  TUNNEL_TIMEOUT_HOURS: 4,
  UPDATE_CHECK_TIMEOUT: 3000,
};

/**
 * Platform-specific configuration.
 * 
 * Detects the current OS and adjusts binary naming accordingly.
 * 
 * @constant {Object}
 * @property {boolean} IS_WINDOWS - True if running on Windows
 * @property {string} BIN_NAME - Binary filename ("cloudflared" or "cloudflared.exe")
 */
export const PLATFORM = {
  IS_WINDOWS: process.platform === "win32",
  BIN_NAME: process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
};

/**
 * File system paths for the application.
 * 
 * @constant {Object}
 * @property {string} BIN_DIR - Directory containing the cloudflared binary
 * @property {string} BIN_PATH - Full path to the cloudflared binary
 */
export const PATHS = {
  BIN_DIR: path.join(__dirname, "bin"),
  BIN_PATH: path.join(__dirname, "bin", PLATFORM.BIN_NAME),
};

/**
 * Log patterns for filtering cloudflared output.
 * 
 * Used by BinaryManager to categorize and filter stderr messages:
 * - SUCCESS: Messages indicating successful connection
 * - ERROR: Critical error messages to show user
 * - NETWORK_WARNING: Connectivity issues (QUIC, timeouts)
 * - IGNORE: Harmless warnings to suppress
 * 
 * @constant {Object}
 * @property {string[]} SUCCESS - Patterns indicating connection success
 * @property {string[]} ERROR - Patterns indicating critical errors
 * @property {string[]} NETWORK_WARNING - Patterns for network connectivity issues
 * @property {string[]} IGNORE - Patterns for harmless messages to suppress
 */
export const LOG_PATTERNS = {
  SUCCESS: ["Registered tunnel connection"],
  ERROR: ["ERR", "error"],
  
  // Network-related warnings (not critical errors)
  NETWORK_WARNING: [
    "failed to accept QUIC stream",
    "failed to dial to edge with quic",
    "failed to accept incoming stream requests",
    "Failed to dial a quic connection",
    "timeout: no recent network activity",
    "failed to dial to edge",
    "quic:",
  ],
  
  IGNORE: [
    "Cannot determine default origin certificate path",
    "No file cert.pem",
    "origincert option",
    "TUNNEL_ORIGIN_CERT",
    "context canceled",
    "failed to run the datagram handler",
    "failed to serve tunnel connection",
    "Connection terminated",
    "no more connections active and exiting",
    "Serve tunnel error",
    "accept stream listener encountered a failure",
    "Retrying connection",
    "icmp router terminated",
    "use of closed network connection",
    "Application error 0x0",
  ],
};

/**
 * Network warning display configuration.
 * 
 * Controls when and how often to show network connectivity warnings.
 * 
 * @constant {Object}
 * @property {number} WARNING_THRESHOLD - Number of errors before showing warning (5)
 * @property {number} WARNING_COOLDOWN - Minimum ms between warnings (30000 = 30s)
 */
export const NETWORK_CONFIG = {
  WARNING_THRESHOLD: 5,  // Show warning after 5 network errors
  WARNING_COOLDOWN: 30000,  // Only show warning every 30 seconds
};

/**
 * Computed timeout in milliseconds.
 * 
 * Converts TUNNEL_TIMEOUT_HOURS to milliseconds for use with setTimeout.
 * 
 * @constant {number}
 */
export const TUNNEL_TIMEOUT_MS = CONFIG.TUNNEL_TIMEOUT_HOURS * 60 * 60 * 1000;
