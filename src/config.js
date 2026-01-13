import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

// Helper function to get backend URL with priority order
function getBackendUrl() {
  // Priority 1: Environment variable
  if (process.env.NPORT_BACKEND_URL) {
    return process.env.NPORT_BACKEND_URL;
  }
  
  // Priority 2: Saved config (will be set by config-manager if available)
  // Priority 3: Default
  return "https://api.nport.link";
}

// Application constants
export const CONFIG = {
  PACKAGE_NAME: packageJson.name,
  CURRENT_VERSION: packageJson.version,
  BACKEND_URL: getBackendUrl(),
  DEFAULT_PORT: 8080,
  SUBDOMAIN_PREFIX: "user-",
  TUNNEL_TIMEOUT_HOURS: 4,
  UPDATE_CHECK_TIMEOUT: 3000,
};

// Platform-specific configuration
export const PLATFORM = {
  IS_WINDOWS: process.platform === "win32",
  BIN_NAME: process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
};

// Paths
export const PATHS = {
  BIN_DIR: path.join(__dirname, "bin"),
  BIN_PATH: path.join(__dirname, "bin", PLATFORM.BIN_NAME),
};

// Log patterns for filtering cloudflared output
export const LOG_PATTERNS = {
  SUCCESS: ["Registered tunnel connection"],
  ERROR: ["ERR", "error"],
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

// Computed constants
export const TUNNEL_TIMEOUT_MS = CONFIG.TUNNEL_TIMEOUT_HOURS * 60 * 60 * 1000;

