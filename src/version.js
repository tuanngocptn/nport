import axios from "axios";
import { CONFIG } from "./config.js";
import { analytics } from "./analytics.js";

/**
 * Version Manager
 * Handles version checking and update notifications
 */
export class VersionManager {
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

