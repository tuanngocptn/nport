import axios from 'axios';
import { createHash } from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { SystemInfo, GA4Payload } from './types/index.js';
import { ANALYTICS_TIMEOUT } from './constants.js';

/**
 * GA4 Configuration for CLI Analytics
 * 
 * This uses a dedicated data stream for CLI usage tracking,
 * separate from the website analytics.
 */
const GA4_CONFIG = {
  measurementId: 'G-JJHG4DP1K9',
  apiSecret: 'NjNID8jtRJe9s8uSBz2jfw',
};

const ANALYTICS_CONFIG = {
  enabled: true,
  debug: process.env.NPORT_DEBUG === 'true',
  timeout: ANALYTICS_TIMEOUT,
  userIdFile: path.join(os.homedir(), '.nport', 'analytics-id'),
};

/**
 * Analytics Manager
 */
class AnalyticsManager {
  private userId: string | null = null;
  private sessionId: number | null = null;
  private sessionStartTime: number | null = null;
  private disabled = false;

  constructor() {
    if (process.env.NPORT_ANALYTICS === 'false') {
      this.disabled = true;
    }
  }

  /**
   * Initializes analytics.
   */
  async initialize(): Promise<void> {
    if (this.disabled) return;

    if (!GA4_CONFIG.apiSecret) {
      if (ANALYTICS_CONFIG.debug) {
        console.warn('[Analytics] API secret not configured. Analytics disabled.');
      }
      this.disabled = true;
      return;
    }

    try {
      this.userId = await this.getUserId();
      this.sessionId = this.generateSessionId();
      this.sessionStartTime = Date.now();
      
      if (ANALYTICS_CONFIG.debug) {
        console.log('[Analytics] Initialized successfully');
        console.log(`[Analytics] User ID: ${this.userId}`);
        console.log(`[Analytics] Session ID: ${this.sessionId}`);
      }
    } catch (error) {
      if (ANALYTICS_CONFIG.debug) {
        console.warn('[Analytics] Failed to initialize:', error);
      }
      this.disabled = true;
    }
  }

  /**
   * Gets or creates a persistent user ID.
   */
  private async getUserId(): Promise<string> {
    try {
      const configDir = path.join(os.homedir(), '.nport');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      if (fs.existsSync(ANALYTICS_CONFIG.userIdFile)) {
        const userId = fs.readFileSync(ANALYTICS_CONFIG.userIdFile, 'utf8').trim();
        if (userId) return userId;
      }

      const userId = this.generateAnonymousId();
      fs.writeFileSync(ANALYTICS_CONFIG.userIdFile, userId, 'utf8');
      return userId;
    } catch {
      return this.generateAnonymousId();
    }
  }

  /**
   * Generates an anonymous user ID.
   */
  private generateAnonymousId(): string {
    const machineId = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.homedir(),
    ].join('-');
    
    return createHash('sha256').update(machineId).digest('hex').substring(0, 32);
  }

  /**
   * Generates a session ID.
   * GA4 requires session_id to be a numeric timestamp (in seconds).
   */
  private generateSessionId(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Tracks an event.
   */
  private async trackEvent(eventName: string, params: Record<string, string | number | boolean> = {}): Promise<void> {
    if (this.disabled || !ANALYTICS_CONFIG.enabled || !this.userId) return;

    try {
      const payload = this.buildPayload(eventName, params);
      
      // Always use production endpoint to record events
      const baseUrl = 'https://www.google-analytics.com/mp/collect';
      
      const url = `${baseUrl}?measurement_id=${GA4_CONFIG.measurementId}&api_secret=${GA4_CONFIG.apiSecret}`;
      
      if (ANALYTICS_CONFIG.debug) {
        console.log(`[Analytics] Sending event: ${eventName}`);
        console.log('[Analytics] Payload:', JSON.stringify(payload, null, 2));
      }
      
      axios.post(url, payload, {
        timeout: ANALYTICS_CONFIG.timeout,
        headers: { 'Content-Type': 'application/json' },
      }).then((response) => {
        if (ANALYTICS_CONFIG.debug) {
          console.log(`[Analytics] Response status: ${response.status}`);
          if (response.data) {
            console.log('[Analytics] Response:', JSON.stringify(response.data, null, 2));
          }
        }
      }).catch((error) => {
        if (ANALYTICS_CONFIG.debug) {
          console.warn('[Analytics] Request failed:', error.message);
        }
      });
    } catch (error) {
      if (ANALYTICS_CONFIG.debug) {
        console.warn('[Analytics] Error tracking event:', error);
      }
    }
  }

  /**
   * Calculates engagement time since session start.
   */
  private getEngagementTime(): number {
    if (!this.sessionStartTime) return 100;
    return Math.max(100, Date.now() - this.sessionStartTime);
  }

  /**
   * Builds GA4 payload.
   */
  private buildPayload(eventName: string, params: Record<string, string | number | boolean>): GA4Payload {
    return {
      client_id: this.userId!,
      timestamp_micros: Date.now() * 1000, // Current time in microseconds
      events: [
        {
          name: eventName,
          params: {
            session_id: String(this.sessionId!), // GA4 expects string for session_id in params
            engagement_time_msec: this.getEngagementTime(), // Must be a number
            ...this.getSystemInfo(),
            ...params,
          },
        },
      ],
    };
  }

  /**
   * Gets system information.
   */
  private getSystemInfo(): SystemInfo {
    return {
      os_platform: os.platform(),
      os_version: os.release(),
      os_arch: os.arch(),
      node_version: process.version,
    };
  }

  /**
   * Tracks CLI start.
   */
  trackCliStart(port: number, subdomain: string, version: string): void {
    this.trackEvent('cli_start', {
      port: String(port),
      has_custom_subdomain: subdomain && !subdomain.startsWith('user-'),
      cli_version: version,
    });
  }

  /**
   * Tracks tunnel creation.
   */
  trackTunnelCreated(subdomain: string, port: number): void {
    this.trackEvent('tunnel_created', {
      subdomain_type: subdomain.startsWith('user-') ? 'random' : 'custom',
      port: String(port),
    });
  }

  /**
   * Tracks tunnel error.
   */
  trackTunnelError(errorType: string, errorMessage: string): void {
    this.trackEvent('tunnel_error', {
      error_type: errorType,
      error_message: errorMessage.substring(0, 100),
    });
  }

  /**
   * Tracks tunnel shutdown.
   */
  trackTunnelShutdown(reason: string, durationSeconds: number): void {
    this.trackEvent('tunnel_shutdown', {
      shutdown_reason: reason,
      duration_seconds: String(Math.floor(durationSeconds)),
    });
  }

  /**
   * Tracks update available.
   */
  trackUpdateAvailable(currentVersion: string, latestVersion: string): void {
    this.trackEvent('update_available', {
      current_version: currentVersion,
      latest_version: latestVersion,
    });
  }
}

export const analytics = new AnalyticsManager();
