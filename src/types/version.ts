/**
 * Version-related type definitions
 */

/**
 * Result of checking for updates
 */
export interface UpdateCheckResult {
  /** Currently installed version */
  current: string;
  /** Latest version available on npm */
  latest: string;
  /** True if latest > current */
  shouldUpdate: boolean;
}

/**
 * npm registry package response (partial)
 */
export interface NpmPackageInfo {
  /** Package name */
  name: string;
  /** Latest version */
  version: string;
  /** Package description */
  description?: string;
}
