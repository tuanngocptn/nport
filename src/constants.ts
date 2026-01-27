/**
 * Shared constants used across the application
 */

/**
 * Default backend API URL
 */
export const DEFAULT_BACKEND_URL = 'https://api.nport.link';

/**
 * Default port if not specified
 */
export const DEFAULT_PORT = 8080;

/**
 * Prefix for random subdomains
 */
export const SUBDOMAIN_PREFIX = 'user-';

/**
 * Auto-cleanup timeout in hours
 */
export const TUNNEL_TIMEOUT_HOURS = 4;

/**
 * Timeout for npm version check in milliseconds
 */
export const UPDATE_CHECK_TIMEOUT = 3000;

/**
 * Analytics request timeout in milliseconds
 */
export const ANALYTICS_TIMEOUT = 2000;

/**
 * Network warning configuration
 */
export const NETWORK_WARNING = {
  /** Number of errors before showing warning */
  THRESHOLD: 5,
  /** Minimum ms between warnings */
  COOLDOWN: 30000,
} as const;

/**
 * Log patterns for filtering cloudflared output
 */
export const LOG_PATTERNS = {
  SUCCESS: ['Registered tunnel connection'],
  ERROR: ['ERR', 'error'],
  NETWORK_WARNING: [
    'failed to accept QUIC stream',
    'failed to dial to edge with quic',
    'failed to accept incoming stream requests',
    'Failed to dial a quic connection',
    'timeout: no recent network activity',
    'failed to dial to edge',
    'quic:',
  ],
  IGNORE: [
    'Cannot determine default origin certificate path',
    'No file cert.pem',
    'origincert option',
    'TUNNEL_ORIGIN_CERT',
    'context canceled',
    'failed to run the datagram handler',
    'failed to serve tunnel connection',
    'Connection terminated',
    'no more connections active and exiting',
    'Serve tunnel error',
    'accept stream listener encountered a failure',
    'Retrying connection',
    'icmp router terminated',
    'use of closed network connection',
    'Application error 0x0',
  ],
} as const;

/**
 * Available language codes
 */
export const AVAILABLE_LANGUAGES = ['en', 'vi'] as const;

/**
 * GitHub repository URL
 */
export const GITHUB_URL = 'https://github.com/tuanngocptn/nport';

/**
 * Website URL
 */
export const WEBSITE_URL = 'https://nport.link';

/**
 * Buy Me a Coffee URL
 */
export const COFFEE_URL = 'https://buymeacoffee.com/tuanngocptn';
