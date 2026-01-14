import { spawn } from "child_process";
import chalk from "chalk";
import fs from "fs";
import { LOG_PATTERNS, NETWORK_CONFIG } from "./config.js";
import { state } from "./state.js";
import { UI } from "./ui.js";
import { lang } from "./lang.js";

/**
 * Binary Manager
 * Handles cloudflared binary validation, spawning, and process management
 */
export class BinaryManager {
  static validate(binaryPath) {
    if (fs.existsSync(binaryPath)) {
      return true;
    }

    console.error(
      chalk.red(`\n❌ Error: Cloudflared binary not found at: ${binaryPath}`)
    );
    console.error(
      chalk.yellow(
        "👉 Please run 'npm install' again to download the binary.\n"
      )
    );
    return false;
  }

  static spawn(binaryPath, token, port) {
    return spawn(binaryPath, [
      "tunnel",
      "run",
      "--token",
      token,
      "--url",
      `http://localhost:${port}`,
    ]);
  }

  static attachHandlers(process, spinner = null) {
    process.stderr.on("data", (chunk) => this.handleStderr(chunk));
    process.on("error", (err) => this.handleError(err, spinner));
    process.on("close", (code) => this.handleClose(code));
  }

  static handleStderr(chunk) {
    const msg = chunk.toString();

    // Skip harmless warnings
    if (LOG_PATTERNS.IGNORE.some((pattern) => msg.includes(pattern))) {
      return;
    }

    // Check for network warnings (QUIC/connectivity issues)
    if (LOG_PATTERNS.NETWORK_WARNING.some((pattern) => msg.includes(pattern))) {
      this.handleNetworkWarning(msg);
      return; // Don't show the raw error to user
    }

    // Show success messages with connection count
    if (LOG_PATTERNS.SUCCESS.some((pattern) => msg.includes(pattern))) {
      const count = state.incrementConnection();
      
      // Reset network issue count when connection succeeds
      if (count === 1) {
        state.resetNetworkIssues();
        console.log(chalk.green(lang.t("connection1")));
      } else if (count === 4) {
        console.log(chalk.green(lang.t("connection2")));
        // Display footer after tunnel is fully active
        UI.displayFooter(state.updateInfo);
      }
      return;
    }

    // Show critical errors only
    if (LOG_PATTERNS.ERROR.some((pattern) => msg.includes(pattern))) {
      console.error(chalk.red(`[Cloudflared] ${msg.trim()}`));
    }
  }

  static handleNetworkWarning(msg) {
    const count = state.incrementNetworkIssue();
    
    // Show user-friendly warning after threshold is reached
    if (
      state.shouldShowNetworkWarning(
        NETWORK_CONFIG.WARNING_THRESHOLD,
        NETWORK_CONFIG.WARNING_COOLDOWN
      )
    ) {
      this.displayNetworkWarning();
    }
  }

  static displayNetworkWarning() {
    console.log(chalk.yellow(lang.t("networkIssueTitle")));
    console.log(chalk.gray(lang.t("networkIssueDesc")));
    console.log(chalk.cyan(lang.t("networkIssueTunnel")));
    console.log(chalk.yellow(lang.t("networkIssueReasons")));
    console.log(chalk.gray(lang.t("networkIssueReason1")));
    console.log(chalk.gray(lang.t("networkIssueReason2")));
    console.log(chalk.gray(lang.t("networkIssueReason3")));
    console.log(chalk.yellow(lang.t("networkIssueFix")));
    console.log(chalk.gray(lang.t("networkIssueFix1")));
    console.log(chalk.gray(lang.t("networkIssueFix2")));
    console.log(chalk.gray(lang.t("networkIssueFix3")));
    console.log(chalk.gray(lang.t("networkIssueFix4")));
    console.log(chalk.blue(lang.t("networkIssueIgnore")));
  }

  static handleError(err, spinner) {
    if (spinner) {
      spinner.fail("Failed to spawn cloudflared process.");
    }
    console.error(chalk.red(`Process Error: ${err.message}`));
  }

  static handleClose(code) {
    if (code !== 0 && code !== null) {
      console.log(chalk.red(`Tunnel process exited with code ${code}`));
    }
  }
}

