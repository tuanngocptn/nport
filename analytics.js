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
const __dirname = path.dirname(__filename);

// Firebase/GA4 Configuration (from website/home.html)
// Full Firebase config for reference (if needed for future features)
const FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyArRxHZJUt4o2RxiLqX1yDSkuUd6ZFy45I",
  authDomain: "nport-link.firebaseapp.com",
  projectId: "nport-link",
  storageBucket: "nport-link.firebasestorage.app",
  messagingSenderId: "515584605320",
  appId: "1:515584605320:web:88daabc8d77146c6e7f33d",
  measurementId: "G-8MYXZL6PGD"
};

// Analytics-specific config (for GA4 Measurement Protocol)
const FIREBASE_CONFIG = {
  measurementId: FIREBASE_WEB_CONFIG.measurementId,
  apiSecret: process.env.NPORT_ANALYTICS_SECRET || "YOUR_API_SECRET_HERE", // Get from Firebase Console
};

// Analytics Configuration
const ANALYTICS_CONFIG = {
  enabled: true, // Can be disabled by environment variable
  debug: process.env.NPORT_DEBUG === "true",
  timeout: 2000, // Don't block CLI for too long
  userIdFile: path.join(os.homedir(), ".nport-analytics"),
};

// ============================================================================
// Analytics Manager
// ============================================================================

class AnalyticsManager {
  constructor() {
    this.userId = null;
    this.sessionId = null;
    this.disabled = false;
    
    // Disable analytics if environment variable is set
    if (process.env.NPORT_ANALYTICS === "false") {
      this.disabled = true;
    }
  }

  /**
   * Initialize analytics - must be called before tracking
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
   * Get or create a persistent user ID
   */
  async getUserId() {
    try {
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
   * Generate anonymous user ID based on machine characteristics
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
   * Generate session ID
   */
  generateSessionId() {
    return randomUUID();
  }

  /**
   * Track an event
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
   * Build GA4 Measurement Protocol payload
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
   * Get system information for context
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
   * Track CLI start
   */
  async trackCliStart(port, subdomain, version) {
    await this.trackEvent("cli_start", {
      port: String(port),
      has_custom_subdomain: subdomain && !subdomain.startsWith("user-"),
      cli_version: version,
    });
  }

  /**
   * Track tunnel creation
   */
  async trackTunnelCreated(subdomain, port) {
    await this.trackEvent("tunnel_created", {
      subdomain_type: subdomain.startsWith("user-") ? "random" : "custom",
      port: String(port),
    });
  }

  /**
   * Track tunnel error
   */
  async trackTunnelError(errorType, errorMessage) {
    await this.trackEvent("tunnel_error", {
      error_type: errorType,
      error_message: errorMessage.substring(0, 100), // Limit length
    });
  }

  /**
   * Track tunnel shutdown
   */
  async trackTunnelShutdown(reason, durationSeconds) {
    await this.trackEvent("tunnel_shutdown", {
      shutdown_reason: reason, // "manual", "timeout", "error"
      duration_seconds: String(Math.floor(durationSeconds)),
    });
  }

  /**
   * Track CLI update notification shown
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

export const analytics = new AnalyticsManager();

