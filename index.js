#!/usr/bin/env node

import ora from "ora";
import { ArgumentParser } from "./src/args.js";
import { TunnelOrchestrator } from "./src/tunnel.js";
import { VersionManager } from "./src/version.js";
import { UI } from "./src/ui.js";
import { CONFIG } from "./src/config.js";
import { lang } from "./src/lang.js";

/**
 * NPort - Free & Open Source ngrok Alternative
 * 
 * Main entry point for the NPort CLI application.
 * Handles command-line arguments and orchestrates tunnel creation.
 */

/**
 * Display version information with update check
 */
async function displayVersion() {
  const spinner = ora(lang.t("checkingUpdates")).start();
  const updateInfo = await VersionManager.checkForUpdates();
  spinner.stop();
  
  UI.displayVersion(CONFIG.CURRENT_VERSION, updateInfo);
}

/**
 * Main application entry point
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
    
    // If only --language flag was used, show success message and exit
    if (config.language === 'prompt' && 
        (args.includes('--language') || args.includes('--lang') || args.includes('-l'))) {
      // Language was already selected in initialize(), just exit
      process.exit(0);
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
