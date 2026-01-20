import axios from "axios";
import { CONFIG } from "./config.js";
import { analytics } from "./analytics.js";

/**
 * @typedef {Object} UpdateCheckResult
 * @property {string} current - Currently installed version
 * @property {string} latest - Latest version available on npm
 * @property {boolean} shouldUpdate - True if latest > current
 */

/**
 * Version Manager
 * 
 * Handles version checking and update notifications.
 * Queries the npm registry to check for newer versions.
 * 
 * @example
 * const updateInfo = await VersionManager.checkForUpdates();
 * if (updateInfo?.shouldUpdate) {
 *   console.log(`Update available: ${updateInfo.latest}`);
 * }
 */
export class VersionManager {
  /**
   * Checks the npm registry for available updates.
   * 
   * Makes a request to npm registry API to get the latest version.
   * Compares against the current version to determine if update is needed.
   * 
   * @returns {Promise<UpdateCheckResult|null>} Update information, or null on error
   * 
   * @example
   * const result = await VersionManager.checkForUpdates();
   * // result = { current: "2.0.6", latest: "2.0.7", shouldUpdate: true }
   */
  static async checkForUpdates() {
    try {
      const response = await axios.get(
        `https://registry.npmjs.org/${CONFIG.PACKAGE_NAME}/latest`,
        { timeout: CONFIG.UPDATE_CHECK_TIMEOUT }
      );

      const latestVersion = response.data.version;
      const shouldUpdate =
        this.compareVersions(latestVersion, CONFIG.CURRENT_VERSION) > 0;

      // Track update notification if available
      if (shouldUpdate) {
        analytics.trackUpdateAvailable(CONFIG.CURRENT_VERSION, latestVersion);
      }

      return {
        current: CONFIG.CURRENT_VERSION,
        latest: latestVersion,
        shouldUpdate,
      };
    } catch (error) {
      // Silently fail if can't check for updates
      return null;
    }
  }

  /**
   * Compares two semantic version strings.
   * 
   * Handles versions with different segment counts (e.g., "1.0" vs "1.0.0").
   * 
   * @param {string} v1 - First version string (e.g., "2.0.7")
   * @param {string} v2 - Second version string (e.g., "2.0.6")
   * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   * 
   * @example
   * VersionManager.compareVersions("2.0.7", "2.0.6")  // 1
   * VersionManager.compareVersions("2.0.6", "2.0.7")  // -1
   * VersionManager.compareVersions("2.0.7", "2.0.7")  // 0
   * VersionManager.compareVersions("1.0", "1.0.0")    // 0
   */
  static compareVersions(v1, v2) {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);

    // Compare up to the maximum length of both version arrays
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
      // Treat missing parts as 0 (e.g., "1.0" is "1.0.0")
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }
}
