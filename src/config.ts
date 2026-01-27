import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type { AppConfig, PlatformConfig, PathsConfig, LogPatterns, NetworkConfig } from './types/index.js';
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_PORT,
  SUBDOMAIN_PREFIX,
  TUNNEL_TIMEOUT_HOURS,
  UPDATE_CHECK_TIMEOUT,
  LOG_PATTERNS as SHARED_LOG_PATTERNS,
  NETWORK_WARNING,
} from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const require = createRequire(import.meta.url);

interface PackageJson {
  name: string;
  version: string;
}

const packageJson: PackageJson = require('../package.json');

/**
 * Gets the backend URL based on priority order.
 */
function getBackendUrl(): string {
  if (process.env.NPORT_BACKEND_URL) {
    return process.env.NPORT_BACKEND_URL;
  }
  return DEFAULT_BACKEND_URL;
}

/**
 * Application configuration constants
 */
export const CONFIG: AppConfig = {
  PACKAGE_NAME: packageJson.name,
  CURRENT_VERSION: packageJson.version,
  BACKEND_URL: getBackendUrl(),
  DEFAULT_PORT,
  SUBDOMAIN_PREFIX,
  TUNNEL_TIMEOUT_HOURS,
  UPDATE_CHECK_TIMEOUT,
};

/**
 * Platform-specific configuration
 */
export const PLATFORM: PlatformConfig = {
  IS_WINDOWS: process.platform === 'win32',
  BIN_NAME: process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
};

/**
 * File system paths
 */
export const PATHS: PathsConfig = {
  BIN_DIR: path.join(__dirname, 'bin'),
  BIN_PATH: path.join(__dirname, 'bin', PLATFORM.BIN_NAME),
};

/**
 * Log patterns for filtering cloudflared output
 */
export const LOG_PATTERNS: LogPatterns = SHARED_LOG_PATTERNS;

/**
 * Network warning configuration
 */
export const NETWORK_CONFIG: NetworkConfig = {
  WARNING_THRESHOLD: NETWORK_WARNING.THRESHOLD,
  WARNING_COOLDOWN: NETWORK_WARNING.COOLDOWN,
};

/**
 * Tunnel timeout in milliseconds
 */
export const TUNNEL_TIMEOUT_MS = CONFIG.TUNNEL_TIMEOUT_HOURS * 60 * 60 * 1000;
