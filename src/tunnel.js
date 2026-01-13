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
 * Tunnel Orchestrator
 * Main controller for tunnel lifecycle management
 */
export class TunnelOrchestrator {
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

