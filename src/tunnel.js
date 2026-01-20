import ora from "ora";
import chalk from "chalk";
import { CONFIG, PATHS, TUNNEL_TIMEOUT_MS } from "./config.js";
import { state } from "./state.js";
import { BinaryManager } from "./binary.js";
import { APIClient } from "./api.js";
import { VersionManager } from "./version.js";
import { UI } from "./ui.js";
import { analytics } from "./analytics.js";
import { lang } from "./lang.js";

/**
 * @typedef {Object} TunnelConfig
 * @property {number} port - Local port to tunnel (e.g., 3000)
 * @property {string} subdomain - Subdomain to use (e.g., "myapp")
 * @property {string|null} backendUrl - Custom backend URL or null for default
 * @property {string|null} language - Language code or null for default
 */

/**
 * Tunnel Orchestrator
 * 
 * Main controller for the entire tunnel lifecycle. This is the core module
 * that coordinates all other components (API, Binary, UI, Analytics).
 * 
 * Lifecycle:
 * 1. `start()` - Initialize analytics, create tunnel, spawn cloudflared
 * 2. (Running) - cloudflared maintains connection to Cloudflare Edge
 * 3. `cleanup()` - Kill process, delete tunnel, remove DNS record
 * 
 * @example
 * // Start a tunnel
 * await TunnelOrchestrator.start({
 *   port: 3000,
 *   subdomain: "myapp",
 *   backendUrl: null
 * });
 * 
 * // Cleanup is automatic on SIGINT/SIGTERM, but can be called manually
 * await TunnelOrchestrator.cleanup();
 */
export class TunnelOrchestrator {
  /**
   * Starts the tunnel creation process.
   * 
   * This method orchestrates the entire tunnel startup:
   * 1. Initializes analytics tracking
   * 2. Displays startup UI banner
   * 3. Checks for CLI updates
   * 4. Validates cloudflared binary exists
   * 5. Creates tunnel via backend API
   * 6. Spawns cloudflared process with tunnel token
   * 7. Sets up auto-cleanup timeout (4 hours)
   * 
   * @param {TunnelConfig} config - Tunnel configuration options
   * @returns {Promise<void>}
   * @throws {Error} If binary is missing or tunnel creation fails
   * 
   * @example
   * await TunnelOrchestrator.start({
   *   port: 3000,
   *   subdomain: "myapp",
   *   backendUrl: null
   * });
   */
  static async start(config) {
    state.setTunnel(null, config.subdomain, config.port, config.backendUrl);

    // Initialize analytics
    await analytics.initialize();

    // Track CLI start
    analytics.trackCliStart(config.port, config.subdomain, CONFIG.CURRENT_VERSION);

    // Display UI
    UI.displayStartupBanner(config.port);

    // Check for updates
    const updateInfo = await VersionManager.checkForUpdates();
    state.setUpdateInfo(updateInfo);

    // Validate binary
    if (!BinaryManager.validate(PATHS.BIN_PATH)) {
      analytics.trackTunnelError("binary_missing", "Cloudflared binary not found");
      // Give analytics a moment to send before exiting
      await new Promise(resolve => setTimeout(resolve, 100));
      process.exit(1);
    }

    const spinner = ora(lang.t("creatingTunnel", { port: config.port })).start();

    try {
      // Create tunnel
      const tunnel = await APIClient.createTunnel(config.subdomain, config.backendUrl);
      state.setTunnel(tunnel.tunnelId, config.subdomain, config.port, config.backendUrl);

      // Track successful tunnel creation
      analytics.trackTunnelCreated(config.subdomain, config.port);

      spinner.stop();
      console.log(chalk.green(`   ${lang.t("tunnelLive")}`));
      UI.displayTunnelSuccess(tunnel.url, config.port, updateInfo);

      // Spawn cloudflared
      const process = BinaryManager.spawn(
        PATHS.BIN_PATH,
        tunnel.tunnelToken,
        config.port
      );
      state.setProcess(process);
      BinaryManager.attachHandlers(process, spinner);

      // Set timeout
      const timeoutId = setTimeout(() => {
        UI.displayTimeoutWarning();
        this.cleanup("timeout");
      }, TUNNEL_TIMEOUT_MS);
      state.setTimeout(timeoutId);
    } catch (error) {
      // Track tunnel creation error
      const errorType = error.message.includes("already taken") 
        ? "subdomain_taken" 
        : "tunnel_creation_failed";
      analytics.trackTunnelError(errorType, error.message);

      UI.displayError(error, spinner);
      // Give analytics a moment to send before exiting
      await new Promise(resolve => setTimeout(resolve, 100));
      process.exit(1);
    }
  }

  /**
   * Gracefully shuts down the tunnel and cleans up resources.
   * 
   * This method handles:
   * 1. Clears the auto-cleanup timeout
   * 2. Tracks shutdown analytics with duration
   * 3. Kills the cloudflared process
   * 4. Calls backend API to delete tunnel and DNS record
   * 5. Displays goodbye message
   * 6. Exits the process
   * 
   * Called automatically when:
   * - User presses Ctrl+C (SIGINT)
   * - Process receives SIGTERM
   * - 4-hour timeout expires
   * 
   * @param {string} [reason="manual"] - Shutdown reason for analytics
   *   - "manual" - User pressed Ctrl+C
   *   - "timeout" - 4-hour limit reached
   *   - "error" - Unexpected error occurred
   * @returns {Promise<void>}
   * 
   * @example
   * // Called automatically on SIGINT, but can be manual:
   * await TunnelOrchestrator.cleanup("manual");
   */
  static async cleanup(reason = "manual") {
    state.clearTimeout();

    if (!state.hasTunnel()) {
      process.exit(0);
    }

    UI.displayCleanupStart();

    // Track tunnel shutdown with duration
    const duration = state.getDurationSeconds();
    analytics.trackTunnelShutdown(reason, duration);

    try {
      // Kill process
      if (state.hasProcess()) {
        state.tunnelProcess.kill();
      }

      // Delete tunnel
      await APIClient.deleteTunnel(state.subdomain, state.tunnelId, state.backendUrl);
      UI.displayCleanupSuccess();
    } catch (err) {
      UI.displayCleanupError();
    }

    // Give analytics a moment to send (non-blocking)
    await new Promise(resolve => setTimeout(resolve, 100));

    process.exit(0);
  }
}
