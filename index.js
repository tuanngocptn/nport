#!/usr/bin/env node

import axios from "axios";
import { spawn } from "child_process";
import chalk from "chalk";
import ora from "ora";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { analytics } from "./analytics.js";

// ============================================================================
// Module Setup & Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const packageJson = require("./package.json");

// Application constants
const CONFIG = {
  PACKAGE_NAME: packageJson.name,
  CURRENT_VERSION: packageJson.version,
  BACKEND_URL: "https://nport.tuanngocptn.workers.dev",
  DEFAULT_PORT: 8080,
  SUBDOMAIN_PREFIX: "user-",
  TUNNEL_TIMEOUT_HOURS: 4,
  UPDATE_CHECK_TIMEOUT: 3000,
};

// Platform-specific configuration
const PLATFORM = {
  IS_WINDOWS: process.platform === "win32",
  BIN_NAME: process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
};

// Paths
const PATHS = {
  BIN_DIR: path.join(__dirname, "bin"),
  BIN_PATH: path.join(__dirname, "bin", PLATFORM.BIN_NAME),
};

// Log patterns for filtering cloudflared output
const LOG_PATTERNS = {
  SUCCESS: ["Registered tunnel connection"],
  ERROR: ["ERR", "error"],
  IGNORE: [
    "Cannot determine default origin certificate path",
    "No file cert.pem",
    "origincert option",
    "TUNNEL_ORIGIN_CERT",
    "context canceled",
    "failed to run the datagram handler",
    "failed to serve tunnel connection",
    "Connection terminated",
    "no more connections active and exiting",
    "Serve tunnel error",
    "accept stream listener encountered a failure",
    "Retrying connection",
    "icmp router terminated",
    "use of closed network connection",
    "Application error 0x0",
  ],
};

// Computed constants
const TUNNEL_TIMEOUT_MS = CONFIG.TUNNEL_TIMEOUT_HOURS * 60 * 60 * 1000;

// ============================================================================
// Application State
// ============================================================================

class TunnelState {
  constructor() {
    this.tunnelId = null;
    this.subdomain = null;
    this.port = null;
    this.tunnelProcess = null;
    this.timeoutId = null;
    this.connectionCount = 0;
    this.startTime = null;
  }

  setTunnel(tunnelId, subdomain, port) {
    this.tunnelId = tunnelId;
    this.subdomain = subdomain;
    this.port = port;
    if (!this.startTime) {
      this.startTime = Date.now();
    }
  }

  setProcess(process) {
    this.tunnelProcess = process;
  }

  setTimeout(timeoutId) {
    this.timeoutId = timeoutId;
  }

  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  incrementConnection() {
    this.connectionCount++;
    return this.connectionCount;
  }

  hasTunnel() {
    return this.tunnelId !== null;
  }

  hasProcess() {
    return this.tunnelProcess && !this.tunnelProcess.killed;
  }

  getDurationSeconds() {
    if (!this.startTime) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  reset() {
    this.clearTimeout();
    this.tunnelId = null;
    this.subdomain = null;
    this.port = null;
    this.tunnelProcess = null;
    this.connectionCount = 0;
    this.startTime = null;
  }
}

const state = new TunnelState();

// ============================================================================
// Argument Parsing
// ============================================================================

class ArgumentParser {
  static parse(argv) {
    const port = this.parsePort(argv);
    const subdomain = this.parseSubdomain(argv);
    return { port, subdomain };
  }

  static parsePort(argv) {
    const portArg = parseInt(argv[0]);
    return portArg || CONFIG.DEFAULT_PORT;
  }

  static parseSubdomain(argv) {
    // Try all subdomain formats
    const formats = [
      () => this.findFlagWithEquals(argv, "--subdomain="),
      () => this.findFlagWithEquals(argv, "-s="),
      () => this.findFlagWithValue(argv, "--subdomain"),
      () => this.findFlagWithValue(argv, "-s"),
    ];

    for (const format of formats) {
      const subdomain = format();
      if (subdomain) return subdomain;
    }

    return this.generateRandomSubdomain();
  }

  static findFlagWithEquals(argv, flag) {
    const arg = argv.find((a) => a.startsWith(flag));
    return arg ? arg.split("=")[1] : null;
  }

  static findFlagWithValue(argv, flag) {
    const index = argv.indexOf(flag);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
  }

  static generateRandomSubdomain() {
    return `${CONFIG.SUBDOMAIN_PREFIX}${Math.floor(Math.random() * 10000)}`;
  }
}

// ============================================================================
// Binary Management
// ============================================================================

class BinaryManager {
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

    // Show success messages with connection count
    if (LOG_PATTERNS.SUCCESS.some((pattern) => msg.includes(pattern))) {
      const count = state.incrementConnection();
      
      const messages = [
        "✔ Connection established [1/4] - Establishing redundancy...",
        "✔ Connection established [2/4] - Building tunnel network...",
        "✔ Connection established [3/4] - Almost there...",
        "✔ Connection established [4/4] - Tunnel is fully active! 🚀",
      ];
      
      if (count <= 4) {
        console.log(chalk.blueBright(messages[count - 1]));
      }
      return;
    }

    // Show critical errors only
    if (LOG_PATTERNS.ERROR.some((pattern) => msg.includes(pattern))) {
      console.error(chalk.red(`[Cloudflared] ${msg.trim()}`));
    }
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

// ============================================================================
// API Client
// ============================================================================

class APIClient {
  static async createTunnel(subdomain) {
    try {
      const { data } = await axios.post(CONFIG.BACKEND_URL, { subdomain });

      if (!data.success) {
        throw new Error(data.error || "Unknown error from backend");
      }

      return {
        tunnelId: data.tunnelId,
        tunnelToken: data.tunnelToken,
        url: data.url,
      };
    } catch (error) {
      throw this.handleError(error, subdomain);
    }
  }

  static async deleteTunnel(subdomain, tunnelId) {
    await axios.delete(CONFIG.BACKEND_URL, {
      data: { subdomain, tunnelId },
    });
  }

  static handleError(error, subdomain) {
    if (error.response?.data?.error) {
      const errorMsg = error.response.data.error;

      // Check for duplicate tunnel error
      if (
        errorMsg.includes("already have a tunnel") ||
        errorMsg.includes("[1013]")
      ) {
        return new Error(
          `Subdomain "${subdomain}" is already taken or in use.\n\n` +
            chalk.yellow(`💡 Try one of these options:\n`) +
            chalk.gray(`   1. Choose a different subdomain: `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-v2\n`) +
            chalk.gray(`   2. Use a random subdomain:       `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`) +
            chalk.gray(
              `   3. Wait a few minutes and retry if you just stopped a tunnel with this name`
            )
        );
      }

      return new Error(`Backend Error: ${errorMsg}`);
    }

    if (error.response) {
      const errorMsg = JSON.stringify(error.response.data, null, 2);
      return new Error(`Backend Error: ${errorMsg}`);
    }

    return error;
  }
}

// ============================================================================
// Version Management
// ============================================================================

class VersionManager {
  static async checkForUpdates() {
    try {
      const response = await axios.get(
        `https://registry.npmjs.org/${CONFIG.PACKAGE_NAME}/latest`,
        { timeout: CONFIG.UPDATE_CHECK_TIMEOUT }
      );

      const latestVersion = response.data.version;
      const shouldUpdate =
        this.compareVersions(latestVersion, CONFIG.CURRENT_VERSION) > 0;

      // Track update notification if available
      if (shouldUpdate) {
        analytics.trackUpdateAvailable(CONFIG.CURRENT_VERSION, latestVersion);
      }

      return {
        current: CONFIG.CURRENT_VERSION,
        latest: latestVersion,
        shouldUpdate,
      };
    } catch (error) {
      // Silently fail if can't check for updates
      return null;
    }
  }

  static compareVersions(v1, v2) {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);

    // Compare up to the maximum length of both version arrays
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
      // Treat missing parts as 0 (e.g., "1.0" is "1.0.0")
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }
}

// ============================================================================
// UI Display
// ============================================================================

class UI {
  static displayUpdateNotification(updateInfo) {
    if (!updateInfo || !updateInfo.shouldUpdate) return;

    const border = "═".repeat(59);
    const boxWidth = 59;
    
    // Calculate padding dynamically
    const currentVersionText = `  Current version: v${updateInfo.current}`;
    const latestVersionText = `  Latest version:  v${updateInfo.latest}`;
    const runCommandText = `  Run: npm install -g ${CONFIG.PACKAGE_NAME}@latest`;
    
    console.log(chalk.yellow(`\n╔${border}╗`));
    console.log(
      chalk.yellow("║") +
        chalk.bold.yellow("  📦 Update Available!") +
        " ".repeat(37) +
        chalk.yellow("║")
    );
    console.log(chalk.yellow(`╠${border}╣`));
    console.log(
      chalk.yellow("║") +
        chalk.gray(`  Current version: `) +
        chalk.red(`v${updateInfo.current}`) +
        " ".repeat(boxWidth - currentVersionText.length) +
        chalk.yellow("║")
    );
    console.log(
      chalk.yellow("║") +
        chalk.gray(`  Latest version:  `) +
        chalk.green(`v${updateInfo.latest}`) +
        " ".repeat(boxWidth - latestVersionText.length) +
        chalk.yellow("║")
    );
    console.log(chalk.yellow(`╠${border}╣`));
    console.log(
      chalk.yellow("║") +
        chalk.cyan(`  Run: `) +
        chalk.bold(`npm install -g ${CONFIG.PACKAGE_NAME}@latest`) +
        " ".repeat(boxWidth - runCommandText.length) +
        chalk.yellow("║")
    );
    console.log(chalk.yellow(`╚${border}╝\n`));
  }

  static displayProjectInfo() {
    const line = "─".repeat(65);
    console.log(chalk.gray(`\n${line}`));
    console.log(
      chalk.cyan.bold("NPort") +
        chalk.gray(" - ngrok who? (Free & Open Source from Vietnam)")
    );
    console.log(chalk.gray(line));
    console.log(
      chalk.magenta("⚡ Built different: ") +
        chalk.white("No cap, actually free forever")
    );
    console.log(
      chalk.gray("🌐 Website:       ") +
        chalk.blue("https://nport.link")
    );
    console.log(
      chalk.gray("📦 NPM:           ") +
        chalk.blue("npm i -g nport")
    );
    console.log(
      chalk.gray("💻 GitHub:        ") +
        chalk.blue("https://github.com/tuanngocptn/nport")
    );
    console.log(
      chalk.gray("👤 Made by:       ") +
        chalk.cyan("@tuanngocptn") +
        chalk.gray(" (") +
        chalk.blue("https://github.com/tuanngocptn") +
        chalk.gray(")")
    );
    console.log(
      chalk.gray("☕ Buy me coffee: ") +
        chalk.yellow("https://buymeacoffee.com/tuanngocptn")
    );
    console.log(chalk.gray(line));
    console.log(chalk.dim("💭 No paywalls. No BS. Just vibes. ✨"));
    console.log(chalk.gray(`${line}\n`));
  }

  static displayStartupBanner(port) {
    this.displayProjectInfo();
    console.log(chalk.green(`🚀 Starting Tunnel for port ${port}...`));
  }

  static displayTunnelSuccess(url) {
    console.log(chalk.yellow(`🌍 Public URL: ${chalk.bold(url)}`));
    console.log(chalk.gray(`   (Using bundled binary)`));
    console.log(
      chalk.gray(`   Auto-cleanup in ${CONFIG.TUNNEL_TIMEOUT_HOURS} hours`)
    );
    console.log(chalk.gray("Connecting to global network..."));
  }

  static displayTimeoutWarning() {
    console.log(
      chalk.yellow(
        `\n⏰ Tunnel has been running for ${CONFIG.TUNNEL_TIMEOUT_HOURS} hours.`
      )
    );
    console.log(chalk.yellow("   Automatically shutting down..."));
  }

  static displayError(error, spinner = null) {
    if (spinner) {
      spinner.fail("Failed to connect to server.");
    }
    console.error(chalk.red(error.message));
  }

  static displayCleanupStart() {
    console.log(
      chalk.yellow("\n\n🛑 Shutting down... Cleaning up resources...")
    );
  }

  static displayCleanupSuccess() {
    console.log(chalk.green("✔ Cleanup successful. Subdomain released."));
  }

  static displayCleanupError() {
    console.error(
      chalk.red("✖ Cleanup failed (Server might be down or busy).")
    );
  }
}

// ============================================================================
// Tunnel Orchestrator
// ============================================================================

class TunnelOrchestrator {
  static async start(config) {
    state.setTunnel(null, config.subdomain, config.port);

    // Initialize analytics
    await analytics.initialize();

    // Track CLI start
    analytics.trackCliStart(config.port, config.subdomain, CONFIG.CURRENT_VERSION);

    // Display UI
    UI.displayStartupBanner(config.port);

    // Check for updates
    const updateInfo = await VersionManager.checkForUpdates();
    UI.displayUpdateNotification(updateInfo);

    // Validate binary
    if (!BinaryManager.validate(PATHS.BIN_PATH)) {
      analytics.trackTunnelError("binary_missing", "Cloudflared binary not found");
      // Give analytics a moment to send before exiting
      await new Promise(resolve => setTimeout(resolve, 100));
      process.exit(1);
    }

    const spinner = ora("Requesting access...").start();

    try {
      // Create tunnel
      const tunnel = await APIClient.createTunnel(config.subdomain);
      state.setTunnel(tunnel.tunnelId, config.subdomain, config.port);

      // Track successful tunnel creation
      analytics.trackTunnelCreated(config.subdomain, config.port);

      spinner.succeed(chalk.green("Tunnel created!"));
      UI.displayTunnelSuccess(tunnel.url);

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
      await APIClient.deleteTunnel(state.subdomain, state.tunnelId);
      UI.displayCleanupSuccess();
    } catch (err) {
      UI.displayCleanupError();
    }

    // Give analytics a moment to send (non-blocking)
    await new Promise(resolve => setTimeout(resolve, 100));

    process.exit(0);
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================

async function main() {
  try {
    const config = ArgumentParser.parse(process.argv.slice(2));
    await TunnelOrchestrator.start(config);
  } catch (error) {
    console.error(chalk.red(`Fatal Error: ${error.message}`));
    process.exit(1);
  }
}

// Register cleanup handlers
process.on("SIGINT", () => TunnelOrchestrator.cleanup());
process.on("SIGTERM", () => TunnelOrchestrator.cleanup());

// Start application
main();