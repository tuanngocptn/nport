/**
 * @typedef {import('child_process').ChildProcess} ChildProcess
 */

/**
 * @typedef {Object} UpdateInfo
 * @property {string} current - Current installed version
 * @property {string} latest - Latest available version
 * @property {boolean} shouldUpdate - True if update is available
 */

/**
 * Application State Manager
 * 
 * Singleton class that manages all runtime state for the tunnel.
 * Tracks connection info, process references, timers, and network status.
 * 
 * This is the central state store that other modules read from and write to.
 * 
 * @example
 * // Store tunnel info
 * state.setTunnel("abc123", "myapp", 3000);
 * 
 * // Check if tunnel is active
 * if (state.hasTunnel()) {
 *   console.log(`Running for ${state.getDurationSeconds()} seconds`);
 * }
 * 
 * // Cleanup
 * state.clearTimeout();
 * state.reset();
 */
class TunnelState {
  constructor() {
    /**
     * UUID of the current tunnel
     * @type {string|null}
     */
    this.tunnelId = null;
    
    /**
     * Current subdomain (e.g., "myapp")
     * @type {string|null}
     */
    this.subdomain = null;
    
    /**
     * Local port being tunneled
     * @type {number|null}
     */
    this.port = null;
    
    /**
     * Custom backend URL if specified
     * @type {string|null}
     */
    this.backendUrl = null;
    
    /**
     * Reference to the cloudflared child process
     * @type {ChildProcess|null}
     */
    this.tunnelProcess = null;
    
    /**
     * ID of the auto-cleanup timeout
     * @type {NodeJS.Timeout|null}
     */
    this.timeoutId = null;
    
    /**
     * Number of successful cloudflared connections (max 4)
     * @type {number}
     */
    this.connectionCount = 0;
    
    /**
     * Timestamp when tunnel was created
     * @type {number|null}
     */
    this.startTime = null;
    
    /**
     * Version update information
     * @type {UpdateInfo|null}
     */
    this.updateInfo = null;
    
    // Network issue tracking
    /**
     * Count of network issues for warning threshold
     * @type {number}
     */
    this.networkIssueCount = 0;
    
    /**
     * Timestamp of last network warning shown
     * @type {number}
     */
    this.lastNetworkWarningTime = 0;
    
    /**
     * Whether network warning has been shown this session
     * @type {boolean}
     */
    this.networkWarningShown = false;
  }

  /**
   * Sets the tunnel connection information.
   * 
   * @param {string|null} tunnelId - UUID of the tunnel
   * @param {string} subdomain - Subdomain being used
   * @param {number} port - Local port being tunneled
   * @param {string|null} [backendUrl=null] - Custom backend URL
   * @returns {void}
   */
  setTunnel(tunnelId, subdomain, port, backendUrl = null) {
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
   * 
   * @param {UpdateInfo|null} updateInfo - Update check results
   * @returns {void}
   */
  setUpdateInfo(updateInfo) {
    this.updateInfo = updateInfo;
  }

  /**
   * Stores reference to the cloudflared child process.
   * 
   * @param {ChildProcess} process - The spawned cloudflared process
   * @returns {void}
   */
  setProcess(process) {
    this.tunnelProcess = process;
  }

  /**
   * Stores the auto-cleanup timeout ID.
   * 
   * @param {NodeJS.Timeout} timeoutId - setTimeout return value
   * @returns {void}
   */
  setTimeout(timeoutId) {
    this.timeoutId = timeoutId;
  }

  /**
   * Clears the auto-cleanup timeout if set.
   * 
   * Should be called during manual cleanup to prevent double-cleanup.
   * 
   * @returns {void}
   */
  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Increments the connection count and returns the new value.
   * 
   * Cloudflared establishes 4 connections for redundancy.
   * Used to display progress messages at connection 1 and 4.
   * 
   * @returns {number} The new connection count
   */
  incrementConnection() {
    this.connectionCount++;
    return this.connectionCount;
  }

  /**
   * Checks if a tunnel is currently active.
   * 
   * @returns {boolean} True if tunnelId is set
   */
  hasTunnel() {
    return this.tunnelId !== null;
  }

  /**
   * Checks if the cloudflared process is running.
   * 
   * @returns {boolean} True if process exists and hasn't been killed
   */
  hasProcess() {
    return this.tunnelProcess && !this.tunnelProcess.killed;
  }

  /**
   * Gets the tunnel duration in seconds.
   * 
   * @returns {number} Seconds since tunnel creation, or 0 if not started
   */
  getDurationSeconds() {
    if (!this.startTime) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Increments the network issue counter.
   * 
   * Used to track QUIC/connectivity issues for warning threshold.
   * 
   * @returns {number} The new issue count
   */
  incrementNetworkIssue() {
    this.networkIssueCount++;
    return this.networkIssueCount;
  }

  /**
   * Resets the network issue counter.
   * 
   * Called when connection succeeds to clear previous issues.
   * 
   * @returns {void}
   */
  resetNetworkIssues() {
    this.networkIssueCount = 0;
  }

  /**
   * Determines if a network warning should be shown.
   * 
   * Returns true if:
   * - Issue count >= threshold
   * - Enough time has passed since last warning (cooldown)
   * 
   * @param {number} threshold - Minimum issues before warning
   * @param {number} cooldown - Minimum ms between warnings
   * @returns {boolean} True if warning should be displayed
   */
  shouldShowNetworkWarning(threshold, cooldown) {
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
   * 
   * @param {boolean} value - True if warning was shown
   * @returns {void}
   */
  setNetworkWarningShown(value) {
    this.networkWarningShown = value;
  }

  /**
   * Resets all state to initial values.
   * 
   * Clears timeout, nullifies all references, resets counters.
   * Called during cleanup or when starting fresh.
   * 
   * @returns {void}
   */
  reset() {
    this.clearTimeout();
    this.tunnelId = null;
    this.subdomain = null;
    this.port = null;
    this.backendUrl = null;
    this.tunnelProcess = null;
    this.connectionCount = 0;
    this.startTime = null;
    this.updateInfo = null;
    
    // Reset network tracking
    this.networkIssueCount = 0;
    this.lastNetworkWarningTime = 0;
    this.networkWarningShown = false;
  }
}

/**
 * Singleton instance of TunnelState.
 * 
 * Import and use this instance throughout the application:
 * ```javascript
 * import { state } from "./state.js";
 * state.setTunnel(id, subdomain, port);
 * ```
 * 
 * @type {TunnelState}
 */
export const state = new TunnelState();
