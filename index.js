#!/usr/bin/env node

/**
 * NPort - Free & Open Source ngrok Alternative
 * 
 * Main entry point for the NPort CLI application.
 * Handles command-line arguments and orchestrates tunnel creation.
 * 
 * @module nport
 * @see https://nport.link
 * @see https://github.com/tuanngocptn/nport
 * 
 * @example
 * // Basic usage
 * $ nport 3000
 * 
 * @example
 * // With custom subdomain
 * $ nport 3000 -s myapp
 * 
 * @example
 * // Check version
 * $ nport -v
 */

import ora from "ora";
import chalk from "chalk";
import { ArgumentParser } from "./src/args.js";
import { TunnelOrchestrator } from "./src/tunnel.js";
import { VersionManager } from "./src/version.js";
import { UI } from "./src/ui.js";
import { CONFIG } from "./src/config.js";
import { lang } from "./src/lang.js";
import { configManager } from "./src/config-manager.js";

/**
 * Displays version information with update check.
 * 
 * Shows current version and checks npm registry for updates.
 * Used when user runs `nport -v` or `nport --version`.
 * 
 * @returns {Promise<void>}
 * @private
 */
async function displayVersion() {
  const spinner = ora(lang.t("checkingUpdates")).start();
  const updateInfo = await VersionManager.checkForUpdates();
  spinner.stop();
  
  UI.displayVersion(CONFIG.CURRENT_VERSION, updateInfo);
}

/**
 * Handles the --set-backend command.
 * 
 * Saves or clears the custom backend URL in persistent config.
 * Used when user runs `nport --set-backend <url>`.
 * 
 * @param {string} value - Backend URL to save, or 'clear' to remove
 * @returns {void}
 * @private
 */
function handleSetBackend(value) {
  if (value === 'clear') {
    // Clear saved backend URL
    configManager.setBackendUrl(null);
    console.log(chalk.green('✔ Backend URL cleared. Using default backend.'));
    console.log(chalk.gray('  Default: https://api.nport.link\n'));
  } else {
    // Save new backend URL
    configManager.setBackendUrl(value);
    console.log(chalk.green('✔ Backend URL saved successfully!'));
    console.log(chalk.cyan(`  Backend: ${value}`));
    console.log(chalk.gray('\n  This backend will be used for all future sessions.'));
    console.log(chalk.gray('  To clear: nport --set-backend\n'));
  }
  
  // Show current configuration
  const savedUrl = configManager.getBackendUrl();
  if (savedUrl) {
    console.log(chalk.white('Current configuration:'));
    console.log(chalk.cyan(`  Saved backend: ${savedUrl}`));
  }
}

/**
 * Main application entry point.
 * 
 * Execution flow:
 * 1. Parse command-line arguments
 * 2. Initialize language (may prompt user on first run)
 * 3. Handle special flags (-v, --set-backend, --language)
 * 4. Load saved backend URL if not specified via CLI
 * 5. Start tunnel via TunnelOrchestrator
 * 
 * @returns {Promise<void>}
 * @throws {Error} Exits with code 1 on fatal errors
 */
async function main() {
  try {
    const args = process.argv.slice(2);
    
    // Parse arguments
    const config = ArgumentParser.parse(args);
    
    // Initialize language first (may prompt user)
    await lang.initialize(config.language);
    
    // Check for version flag (after language is set)
    if (args.includes('-v') || args.includes('--version')) {
      await displayVersion();
      process.exit(0);
    }
    
    // Handle --set-backend command
    if (config.setBackend) {
      handleSetBackend(config.setBackend);
      process.exit(0);
    }
    
    // If only --language flag was used, show success message and exit
    if (config.language === 'prompt' && 
        (args.includes('--language') || args.includes('--lang') || args.includes('-l'))) {
      // Language was already selected in initialize(), just exit
      process.exit(0);
    }
    
    // Load saved backend URL if no CLI backend specified
    if (!config.backendUrl) {
      const savedBackend = configManager.getBackendUrl();
      if (savedBackend) {
        config.backendUrl = savedBackend;
      }
    }
    
    // Start tunnel
    await TunnelOrchestrator.start(config);
  } catch (error) {
    console.error(`Fatal Error: ${error.message}`);
    process.exit(1);
  }
}

// Register cleanup handlers for graceful shutdown
process.on("SIGINT", () => TunnelOrchestrator.cleanup());
process.on("SIGTERM", () => TunnelOrchestrator.cleanup());

// Start application
main();
