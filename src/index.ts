#!/usr/bin/env node

/**
 * NPort - Free & Open Source ngrok Alternative
 * 
 * Main entry point for the NPort CLI application.
 */

import ora from 'ora';
import chalk from 'chalk';
import type { TunnelConfig } from './types/index.js';
import { ArgumentParser } from './args.js';
import { TunnelOrchestrator } from './tunnel.js';
import { VersionManager } from './version.js';
import { UI } from './ui.js';
import { CONFIG } from './config.js';
import { lang } from './lang.js';
import { configManager } from './config-manager.js';

/**
 * Displays version information with update check.
 */
async function displayVersion(): Promise<void> {
  const spinner = ora(lang.t('checkingUpdates')).start();
  const updateInfo = await VersionManager.checkForUpdates();
  spinner.stop();
  
  UI.displayVersion(CONFIG.CURRENT_VERSION, updateInfo);
}

/**
 * Handles the --set-backend command.
 */
function handleSetBackend(value: string): void {
  if (value === 'clear') {
    configManager.setBackendUrl(null);
    console.log(chalk.green('✔ Backend URL cleared. Using default backend.'));
    console.log(chalk.gray('  Default: https://api.nport.link\n'));
  } else {
    configManager.setBackendUrl(value);
    console.log(chalk.green('✔ Backend URL saved successfully!'));
    console.log(chalk.cyan(`  Backend: ${value}`));
    console.log(chalk.gray('\n  This backend will be used for all future sessions.'));
    console.log(chalk.gray('  To clear: nport --set-backend\n'));
  }
  
  const savedUrl = configManager.getBackendUrl();
  if (savedUrl) {
    console.log(chalk.white('Current configuration:'));
    console.log(chalk.cyan(`  Saved backend: ${savedUrl}`));
  }
}

/**
 * Main application entry point.
 */
async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const parsedArgs = ArgumentParser.parse(args);
    
    await lang.initialize(parsedArgs.language);
    
    if (args.includes('-v') || args.includes('--version')) {
      await displayVersion();
      process.exit(0);
    }
    
    if (parsedArgs.setBackend) {
      handleSetBackend(parsedArgs.setBackend);
      process.exit(0);
    }
    
    if (parsedArgs.language === 'prompt' && 
        (args.includes('--language') || args.includes('--lang') || args.includes('-l'))) {
      process.exit(0);
    }
    
    let backendUrl = parsedArgs.backendUrl;
    if (!backendUrl) {
      const savedBackend = configManager.getBackendUrl();
      if (savedBackend) {
        backendUrl = savedBackend;
      }
    }
    
    const config: TunnelConfig = {
      port: parsedArgs.port,
      subdomain: parsedArgs.subdomain,
      backendUrl,
      language: parsedArgs.language,
    };
    
    await TunnelOrchestrator.start(config);
  } catch (error) {
    console.error(`Fatal Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Register cleanup handlers
process.on('SIGINT', () => TunnelOrchestrator.cleanup());
process.on('SIGTERM', () => TunnelOrchestrator.cleanup());

// Start application
main();
