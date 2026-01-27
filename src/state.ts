import type { ChildProcess } from 'child_process';
import type { UpdateCheckResult } from './types/index.js';

/**
 * Application State Manager
 * 
 * Singleton class that manages all runtime state for the tunnel.
 */
class TunnelState {
  tunnelId: string | null = null;
  subdomain: string | null = null;
  port: number | null = null;
  backendUrl: string | null = null;
  tunnelProcess: ChildProcess | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  connectionCount = 0;
  startTime: number | null = null;
  updateInfo: UpdateCheckResult | null = null;
  
  // Network issue tracking
  private networkIssueCount = 0;
  private lastNetworkWarningTime = 0;
  networkWarningShown = false;

  /**
   * Sets the tunnel connection information.
   */
  setTunnel(
    tunnelId: string | null,
    subdomain: string,
    port: number,
    backendUrl: string | null = null
  ): void {
    this.tunnelId = tunnelId;
    this.subdomain = subdomain;
    this.port = port;
    this.backendUrl = backendUrl;
    if (!this.startTime) {
      this.startTime = Date.now();
    }
  }

  /**
   * Stores version update information.
   */
  setUpdateInfo(updateInfo: UpdateCheckResult | null): void {
    this.updateInfo = updateInfo;
  }

  /**
   * Stores reference to the cloudflared child process.
   */
  setProcess(process: ChildProcess): void {
    this.tunnelProcess = process;
  }

  /**
   * Stores the auto-cleanup timeout ID.
   */
  setTimeout(timeoutId: ReturnType<typeof setTimeout>): void {
    this.timeoutId = timeoutId;
  }

  /**
   * Clears the auto-cleanup timeout if set.
   */
  clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Increments the connection count and returns the new value.
   */
  incrementConnection(): number {
    this.connectionCount++;
    return this.connectionCount;
  }

  /**
   * Checks if a tunnel is currently active.
   */
  hasTunnel(): boolean {
    return this.tunnelId !== null;
  }

  /**
   * Checks if the cloudflared process is running.
   */
  hasProcess(): boolean {
    return this.tunnelProcess !== null && !this.tunnelProcess.killed;
  }

  /**
   * Gets the tunnel duration in seconds.
   */
  getDurationSeconds(): number {
    if (!this.startTime) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Increments the network issue counter.
   */
  incrementNetworkIssue(): number {
    this.networkIssueCount++;
    return this.networkIssueCount;
  }

  /**
   * Resets the network issue counter.
   */
  resetNetworkIssues(): void {
    this.networkIssueCount = 0;
  }

  /**
   * Determines if a network warning should be shown.
   */
  shouldShowNetworkWarning(threshold: number, cooldown: number): boolean {
    const now = Date.now();
    if (
      this.networkIssueCount >= threshold &&
      now - this.lastNetworkWarningTime > cooldown
    ) {
      this.lastNetworkWarningTime = now;
      return true;
    }
    return false;
  }

  /**
   * Sets whether a network warning has been shown.
   */
  setNetworkWarningShown(value: boolean): void {
    this.networkWarningShown = value;
  }

  /**
   * Resets all state to initial values.
   */
  reset(): void {
    this.clearTimeout();
    this.tunnelId = null;
    this.subdomain = null;
    this.port = null;
    this.backendUrl = null;
    this.tunnelProcess = null;
    this.connectionCount = 0;
    this.startTime = null;
    this.updateInfo = null;
    this.networkIssueCount = 0;
    this.lastNetworkWarningTime = 0;
    this.networkWarningShown = false;
  }
}

/**
 * Singleton instance
 */
export const state = new TunnelState();
