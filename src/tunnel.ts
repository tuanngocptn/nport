import ora from 'ora';
import chalk from 'chalk';
import fs from 'fs';
import type { TunnelConfig, ShutdownReason } from './types/index.js';
import { CONFIG, PATHS, TUNNEL_TIMEOUT_MS } from './config.js';
import { state } from './state.js';
import { BinaryManager } from './binary.js';
import { ensureCloudflared } from './bin-manager.js';
import { APIClient } from './api.js';
import { VersionManager } from './version.js';
import { UI } from './ui.js';
import { analytics } from './analytics.js';
import { lang } from './lang.js';

/**
 * Tunnel Orchestrator
 * 
 * Main controller for the entire tunnel lifecycle.
 */
export class TunnelOrchestrator {
  /**
   * Starts the tunnel creation process.
   */
  static async start(config: TunnelConfig): Promise<void> {
    state.setTunnel(null, config.subdomain, config.port, config.backendUrl);

    await analytics.initialize();
    analytics.trackCliStart(config.port, config.subdomain, CONFIG.CURRENT_VERSION);

    UI.displayStartupBanner(config.port);

    const updateInfo = await VersionManager.checkForUpdates();
    state.setUpdateInfo(updateInfo);

    // Check if binary exists, download if missing
    if (!fs.existsSync(PATHS.BIN_PATH)) {
      console.log(chalk.yellow('\n📦 Cloudflared binary not found. Downloading...\n'));
      try {
        await ensureCloudflared();
      } catch (error) {
        analytics.trackTunnelError('binary_download_failed', (error as Error).message);
        console.error(chalk.red(`\n❌ Failed to download cloudflared: ${(error as Error).message}`));
        process.exit(1);
      }
    }

    if (!BinaryManager.validate(PATHS.BIN_PATH)) {
      analytics.trackTunnelError('binary_missing', 'Cloudflared binary not found');
      await new Promise(resolve => setTimeout(resolve, 100));
      process.exit(1);
    }

    const spinner = ora(lang.t('creatingTunnel', { port: config.port })).start();

    try {
      const tunnel = await APIClient.createTunnel(config.subdomain, config.backendUrl);
      state.setTunnel(tunnel.tunnelId, config.subdomain, config.port, config.backendUrl);

      analytics.trackTunnelCreated(config.subdomain, config.port);

      spinner.stop();
      console.log(chalk.green(`   ${lang.t('tunnelLive')}`));
      UI.displayTunnelSuccess(tunnel.url, config.port, updateInfo);

      const childProcess = BinaryManager.spawn(
        PATHS.BIN_PATH,
        tunnel.tunnelToken,
        config.port
      );
      state.setProcess(childProcess);
      BinaryManager.attachHandlers(childProcess, spinner);

      const timeoutId = setTimeout(() => {
        UI.displayTimeoutWarning();
        this.cleanup('timeout');
      }, TUNNEL_TIMEOUT_MS);
      state.setTimeout(timeoutId);
    } catch (error) {
      const err = error as Error;
      const errorType = err.message.includes('already taken') 
        ? 'subdomain_taken' 
        : 'tunnel_creation_failed';
      analytics.trackTunnelError(errorType, err.message);

      UI.displayError(err, spinner);
      await new Promise(resolve => setTimeout(resolve, 100));
      process.exit(1);
    }
  }

  /**
   * Gracefully shuts down the tunnel.
   */
  static async cleanup(reason: ShutdownReason = 'manual'): Promise<void> {
    state.clearTimeout();

    if (!state.hasTunnel()) {
      process.exit(0);
    }

    UI.displayCleanupStart();

    const duration = state.getDurationSeconds();
    analytics.trackTunnelShutdown(reason, duration);

    try {
      if (state.hasProcess() && state.tunnelProcess) {
        state.tunnelProcess.kill();
      }

      if (state.subdomain && state.tunnelId) {
        await APIClient.deleteTunnel(state.subdomain, state.tunnelId, state.backendUrl);
      }
      UI.displayCleanupSuccess();
    } catch {
      UI.displayCleanupError();
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(0);
  }
}
