import axios from 'axios';
import type { UpdateCheckResult, NpmPackageInfo } from './types/index.js';
import { CONFIG } from './config.js';
import { analytics } from './analytics.js';

/**
 * Version Manager
 * 
 * Handles version checking and update notifications.
 */
export class VersionManager {
  /**
   * Checks the npm registry for available updates.
   */
  static async checkForUpdates(): Promise<UpdateCheckResult | null> {
    try {
      const response = await axios.get<NpmPackageInfo>(
        `https://registry.npmjs.org/${CONFIG.PACKAGE_NAME}/latest`,
        { timeout: CONFIG.UPDATE_CHECK_TIMEOUT }
      );

      const latestVersion = response.data.version;
      const shouldUpdate = this.compareVersions(latestVersion, CONFIG.CURRENT_VERSION) > 0;

      if (shouldUpdate) {
        analytics.trackUpdateAvailable(CONFIG.CURRENT_VERSION, latestVersion);
      }

      return {
        current: CONFIG.CURRENT_VERSION,
        latest: latestVersion,
        shouldUpdate,
      };
    } catch {
      return null;
    }
  }

  /**
   * Compares two semantic version strings.
   */
  static compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }
}
