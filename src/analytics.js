// ============================================================================
// Firebase Analytics for CLI
// Using Google Analytics 4 Measurement Protocol
// ============================================================================

import axios from "axios";
import { createHash, randomUUID } from "crypto";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

/**
 * Firebase/GA4 Web Configuration.
 * 
 * Full Firebase config from the website for reference.
 * Used for potential future features requiring Firebase services.
 * 
 * @constant {Object}
 * @private
 */
const FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyArRxHZJUt4o2RxiLqX1yDSkuUd6ZFy45I",
  authDomain: "nport-link.firebaseapp.com",
  projectId: "nport-link",
  storageBucket: "nport-link.firebasestorage.app",
  messagingSenderId: "515584605320",
  appId: "1:515584605320:web:88daabc8d77146c6e7f33d",
  measurementId: "G-8MYXZL6PGD"
};

/**
 * Analytics-specific configuration for GA4 Measurement Protocol.
 * 
 * @constant {Object}
 * @property {string} measurementId - GA4 Measurement ID
 * @property {string} apiSecret - API secret for Measurement Protocol (from env)
 * @private
 */
const FIREBASE_CONFIG = {
  measurementId: FIREBASE_WEB_CONFIG.measurementId,
  apiSecret: process.env.NPORT_ANALYTICS_SECRET || "YOUR_API_SECRET_HERE",
};

/**
 * Analytics behavior configuration.
 * 
 * @constant {Object}
 * @property {boolean} enabled - Whether analytics is enabled
 * @property {boolean} debug - Whether to log debug messages
 * @property {number} timeout - Request timeout in ms
 * @property {string} userIdFile - Path to persistent user ID file
 * @private
 */
const ANALYTICS_CONFIG = {
  enabled: true,
  debug: process.env.NPORT_DEBUG === "true",
  timeout: 2000, // Don't block CLI for too long
  userIdFile: path.join(os.homedir(), ".nport", "analytics-id"),
};

// ============================================================================
// Analytics Manager
// ============================================================================

/**
 * Analytics Manager
 * 
 * Handles anonymous usage tracking via Google Analytics 4 Measurement Protocol.
 * Tracks CLI usage patterns to help improve the product.
 * 
 * Privacy features:
 * - Anonymous user ID based on machine characteristics (hashed)
 * - Can be disabled via NPORT_ANALYTICS=false environment variable
 * - No personal information collected
 * - Non-blocking (won't slow down CLI)
 * 
 * Events tracked:
 * - cli_start: When CLI is launched
 * - tunnel_created: When a tunnel is successfully created
 * - tunnel_error: When tunnel creation fails
 * - tunnel_shutdown: When tunnel is closed (with duration)
 * - update_available: When a new version is detected
 * 
 * @example
 * // Initialize and track
 * await analytics.initialize();
 * analytics.trackCliStart(3000, "myapp", "2.0.7");
 * analytics.trackTunnelCreated("myapp", 3000);
 */
class AnalyticsManager {
  constructor() {
    /**
     * Anonymous user ID (machine-based hash)
     * @type {string|null}
     */
    this.userId = null;
    
    /**
     * Random session ID for this CLI session
     * @type {string|null}
     */
    this.sessionId = null;
    
    /**
     * Whether analytics is disabled
     * @type {boolean}
     */
    this.disabled = false;
    
    // Disable analytics if environment variable is set
    if (process.env.NPORT_ANALYTICS === "false") {
      this.disabled = true;
    }
  }

  /**
   * Initializes analytics - must be called before tracking.
   * 
   * Sets up user ID (persistent) and session ID (per-run).
   * Silently disables if API secret is not configured.
   * 
   * @returns {Promise<void>}
   * 
   * @example
   * await analytics.initialize();
   */
  async initialize() {
    if (this.disabled) return;

    // Check if API secret is configured
    if (!FIREBASE_CONFIG.apiSecret || FIREBASE_CONFIG.apiSecret === "YOUR_API_SECRET_HERE") {
      if (ANALYTICS_CONFIG.debug) {
        console.warn("[Analytics] API secret not configured. Analytics disabled.");
        console.warn("[Analytics] Set NPORT_ANALYTICS_SECRET environment variable.");
      }
      this.disabled = true;
      return;
    }

    try {
      this.userId = await this.getUserId();
      this.sessionId = this.generateSessionId();
      
      if (ANALYTICS_CONFIG.debug) {
        console.log("[Analytics] Initialized successfully");
        console.log("[Analytics] User ID:", this.userId.substring(0, 8) + "...");
      }
    } catch (error) {
      if (ANALYTICS_CONFIG.debug) {
        console.error("[Analytics] Initialization failed:", error.message);
      }
      this.disabled = true;
    }
  }

  /**
   * Gets or creates a persistent anonymous user ID.
   * 
   * The user ID is:
   * - Generated from machine characteristics (hostname, platform, etc.)
   * - Hashed with SHA-256 for anonymity
   * - Stored in ~/.nport/analytics-id for persistence
   * 
   * @returns {Promise<string>} 32-character anonymous user ID
   * @private
   */
  async getUserId() {
    try {
      // Ensure .nport directory exists
      const configDir = path.join(os.homedir(), ".nport");
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Try to read existing user ID
      if (fs.existsSync(ANALYTICS_CONFIG.userIdFile)) {
        const userId = fs.readFileSync(ANALYTICS_CONFIG.userIdFile, "utf8").trim();
        if (userId) return userId;
      }

      // Generate new anonymous user ID
      const userId = this.generateAnonymousId();
      
      // Save for future use
      fs.writeFileSync(ANALYTICS_CONFIG.userIdFile, userId, "utf8");
      
      return userId;
    } catch (error) {
      // If file operations fail, use session-based ID
      return this.generateAnonymousId();
    }
  }

  /**
   * Generates an anonymous user ID based on machine characteristics.
   * 
   * Uses hostname, platform, architecture, and home directory.
   * The result is hashed to ensure anonymity.
   * 
   * @returns {string} 32-character SHA-256 hash
   * @private
   */
  generateAnonymousId() {
    const machineId = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.homedir(),
    ].join("-");
    
    return createHash("sha256").update(machineId).digest("hex").substring(0, 32);
  }

  /**
   * Generates a random session ID for this CLI session.
   * 
   * @returns {string} UUID v4 string
   * @private
   */
  generateSessionId() {
    return randomUUID();
  }

  /**
   * Tracks an event to Google Analytics.
   * 
   * Events are sent non-blocking to avoid slowing down the CLI.
   * Failures are silently ignored (unless debug mode is enabled).
   * 
   * @param {string} eventName - Name of the event (e.g., "cli_start")
   * @param {Object} [params={}] - Event parameters
   * @returns {Promise<void>}
   * @private
   */
  async trackEvent(eventName, params = {}) {
    if (this.disabled || !ANALYTICS_CONFIG.enabled) return;

    try {
      const payload = this.buildPayload(eventName, params);
      
      // Send to GA4 Measurement Protocol (non-blocking)
      axios.post(
        `https://www.google-analytics.com/mp/collect?measurement_id=${FIREBASE_CONFIG.measurementId}&api_secret=${FIREBASE_CONFIG.apiSecret}`,
        payload,
        {
          timeout: ANALYTICS_CONFIG.timeout,
          headers: { "Content-Type": "application/json" },
        }
      ).catch((error) => {
        // Silently fail - don't interrupt CLI operations
        if (ANALYTICS_CONFIG.debug) {
          console.error("[Analytics] Failed to send event:", error.message);
        }
      });

      if (ANALYTICS_CONFIG.debug) {
        console.log("[Analytics] Event tracked:", eventName, params);
      }
    } catch (error) {
      // Silently fail
      if (ANALYTICS_CONFIG.debug) {
        console.error("[Analytics] Error tracking event:", error.message);
      }
    }
  }

  /**
   * Builds the GA4 Measurement Protocol payload.
   * 
   * @param {string} eventName - Event name
   * @param {Object} params - Event parameters
   * @returns {Object} GA4 payload object
   * @private
   */
  buildPayload(eventName, params) {
    return {
      client_id: this.userId,
      events: [
        {
          name: eventName,
          params: {
            session_id: this.sessionId,
            engagement_time_msec: "100",
            ...this.getSystemInfo(),
            ...params,
          },
        },
      ],
    };
  }

  /**
   * Gets system information for analytics context.
   * 
   * @returns {Object} System info (platform, version, arch, node version)
   * @private
   */
  getSystemInfo() {
    return {
      os_platform: os.platform(),
      os_version: os.release(),
      os_arch: os.arch(),
      node_version: process.version,
    };
  }

  /**
   * Tracks CLI start event.
   * 
   * Called when user runs the nport command.
   * 
   * @param {number} port - Port being tunneled
   * @param {string} subdomain - Subdomain being used
   * @param {string} version - CLI version
   * @returns {Promise<void>}
   * 
   * @example
   * analytics.trackCliStart(3000, "myapp", "2.0.7");
   */
  async trackCliStart(port, subdomain, version) {
    await this.trackEvent("cli_start", {
      port: String(port),
      has_custom_subdomain: subdomain && !subdomain.startsWith("user-"),
      cli_version: version,
    });
  }

  /**
   * Tracks successful tunnel creation.
   * 
   * @param {string} subdomain - Subdomain used (type tracked, not actual value)
   * @param {number} port - Port being tunneled
   * @returns {Promise<void>}
   * 
   * @example
   * analytics.trackTunnelCreated("myapp", 3000);
   */
  async trackTunnelCreated(subdomain, port) {
    await this.trackEvent("tunnel_created", {
      subdomain_type: subdomain.startsWith("user-") ? "random" : "custom",
      port: String(port),
    });
  }

  /**
   * Tracks tunnel creation errors.
   * 
   * @param {string} errorType - Type of error (e.g., "subdomain_taken")
   * @param {string} errorMessage - Error message (truncated to 100 chars)
   * @returns {Promise<void>}
   * 
   * @example
   * analytics.trackTunnelError("subdomain_taken", "Subdomain myapp is in use");
   */
  async trackTunnelError(errorType, errorMessage) {
    await this.trackEvent("tunnel_error", {
      error_type: errorType,
      error_message: errorMessage.substring(0, 100), // Limit length
    });
  }

  /**
   * Tracks tunnel shutdown.
   * 
   * @param {string} reason - Shutdown reason ("manual", "timeout", "error")
   * @param {number} durationSeconds - How long the tunnel was running
   * @returns {Promise<void>}
   * 
   * @example
   * analytics.trackTunnelShutdown("manual", 3600);
   */
  async trackTunnelShutdown(reason, durationSeconds) {
    await this.trackEvent("tunnel_shutdown", {
      shutdown_reason: reason,
      duration_seconds: String(Math.floor(durationSeconds)),
    });
  }

  /**
   * Tracks when update notification is shown.
   * 
   * @param {string} currentVersion - Currently installed version
   * @param {string} latestVersion - Latest available version
   * @returns {Promise<void>}
   * 
   * @example
   * analytics.trackUpdateAvailable("2.0.6", "2.0.7");
   */
  async trackUpdateAvailable(currentVersion, latestVersion) {
    await this.trackEvent("update_available", {
      current_version: currentVersion,
      latest_version: latestVersion,
    });
  }
}

// ============================================================================
// Export singleton instance
// ============================================================================

/**
 * Singleton instance of AnalyticsManager.
 * 
 * @type {AnalyticsManager}
 */
export const analytics = new AnalyticsManager();
