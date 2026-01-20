import { spawn } from "child_process";
import chalk from "chalk";
import fs from "fs";
import { LOG_PATTERNS, NETWORK_CONFIG } from "./config.js";
import { state } from "./state.js";
import { UI } from "./ui.js";
import { lang } from "./lang.js";

/**
 * @typedef {import('child_process').ChildProcess} ChildProcess
 */

/**
 * Binary Manager
 * 
 * Handles all operations related to the cloudflared binary:
 * - Validation that binary exists
 * - Spawning the tunnel process
 * - Parsing and filtering cloudflared output
 * - Managing network warning messages
 * 
 * The cloudflared binary is downloaded automatically on first install
 * via the bin-manager.js postinstall script.
 * 
 * @example
 * // Validate binary exists
 * if (BinaryManager.validate("/path/to/cloudflared")) {
 *   // Spawn the process
 *   const proc = BinaryManager.spawn("/path/to/cloudflared", "eyJ...", 3000);
 *   BinaryManager.attachHandlers(proc);
 * }
 */
export class BinaryManager {
  /**
   * Validates that the cloudflared binary exists at the specified path.
   * 
   * If the binary is missing, displays an error message with recovery instructions.
   * 
   * @param {string} binaryPath - Full path to the cloudflared binary
   * @returns {boolean} True if binary exists, false otherwise
   * 
   * @example
   * if (!BinaryManager.validate(PATHS.BIN_PATH)) {
   *   process.exit(1);
   * }
   */
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

  /**
   * Spawns the cloudflared tunnel process.
   * 
   * Runs: `cloudflared tunnel run --token <token> --url http://localhost:<port>`
   * 
   * The process maintains a persistent connection to Cloudflare's edge network
   * and proxies all incoming traffic to the local port.
   * 
   * @param {string} binaryPath - Full path to the cloudflared binary
   * @param {string} token - Base64-encoded tunnel token from the backend
   * @param {number} port - Local port to forward traffic to
   * @returns {ChildProcess} The spawned child process
   * 
   * @example
   * const proc = BinaryManager.spawn(
   *   "/path/to/cloudflared",
   *   "eyJhIjoiYWJjMTIzLi4uIiwidCI6ImRlZjQ1Ni4uLiJ9",
   *   3000
   * );
   */
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

  /**
   * Attaches event handlers to the cloudflared process.
   * 
   * Handles:
   * - stderr: Parse and filter cloudflared log output
   * - error: Display spawn errors
   * - close: Handle process exit
   * 
   * @param {ChildProcess} process - The cloudflared child process
   * @param {Object|null} [spinner=null] - Ora spinner instance (for error display)
   * @returns {void}
   * 
   * @example
   * const proc = BinaryManager.spawn(binaryPath, token, port);
   * BinaryManager.attachHandlers(proc, spinner);
   */
  static attachHandlers(process, spinner = null) {
    process.stderr.on("data", (chunk) => this.handleStderr(chunk));
    process.on("error", (err) => this.handleError(err, spinner));
    process.on("close", (code) => this.handleClose(code));
  }

  /**
   * Processes stderr output from cloudflared.
   * 
   * Filters and categorizes log messages:
   * - IGNORE patterns: Harmless warnings (certificate path, context canceled)
   * - NETWORK_WARNING patterns: Connectivity issues (QUIC, timeouts)
   * - SUCCESS patterns: Connection established messages
   * - ERROR patterns: Critical errors shown to user
   * 
   * @param {Buffer} chunk - Raw stderr data from cloudflared
   * @returns {void}
   * @private
   */
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

  /**
   * Handles network-related warnings from cloudflared.
   * 
   * Tracks the count of network issues and shows a user-friendly
   * warning message after reaching a threshold (5 errors).
   * Uses a cooldown period (30 seconds) between warnings.
   * 
   * @param {string} msg - The network warning message
   * @returns {void}
   * @private
   */
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

  /**
   * Displays a detailed network connectivity warning to the user.
   * 
   * Shows:
   * - What the issue is (QUIC/connectivity problems)
   * - Reassurance that tunnel still works
   * - Possible causes
   * - Suggested fixes
   * 
   * @returns {void}
   * @private
   */
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

  /**
   * Handles spawn errors from the cloudflared process.
   * 
   * Called when the process fails to start (e.g., binary not executable).
   * 
   * @param {Error} err - The spawn error
   * @param {Object|null} spinner - Ora spinner instance to fail
   * @returns {void}
   * @private
   */
  static handleError(err, spinner) {
    if (spinner) {
      spinner.fail("Failed to spawn cloudflared process.");
    }
    console.error(chalk.red(`Process Error: ${err.message}`));
  }

  /**
   * Handles the cloudflared process exit.
   * 
   * Shows an error message if the process exited with a non-zero code.
   * Exit code 0 or null (signal termination) is considered normal.
   * 
   * @param {number|null} code - Exit code, or null if terminated by signal
   * @returns {void}
   * @private
   */
  static handleClose(code) {
    if (code !== 0 && code !== null) {
      console.log(chalk.red(`Tunnel process exited with code ${code}`));
    }
  }
}
