import { spawn, type ChildProcess } from 'child_process';
import chalk from 'chalk';
import fs from 'fs';
import { LOG_PATTERNS, NETWORK_CONFIG, PLATFORM } from './config.js';
import { state } from './state.js';
import { UI } from './ui.js';
import { lang } from './lang.js';

/**
 * Binary Manager
 * 
 * Handles all operations related to the cloudflared binary.
 */
export class BinaryManager {
  /**
   * Validates that the cloudflared binary exists.
   */
  static validate(binaryPath: string): boolean {
    if (!fs.existsSync(binaryPath)) {
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

    if (!PLATFORM.IS_WINDOWS) {
      try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(binaryPath, 0o755);
        } catch (chmodErr) {
          console.error(
            chalk.red(`\n❌ Error: Cloudflared binary is not executable: ${binaryPath}`)
          );
          console.error(
            chalk.yellow(`👉 Fix it manually: chmod +x ${binaryPath}\n`)
          );
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Spawns the cloudflared tunnel process.
   */
  static spawn(binaryPath: string, token: string, port: number): ChildProcess {
    const isWindows = process.platform === 'win32';
    
    return spawn(binaryPath, [
      'tunnel',
      'run',
      '--token',
      token,
      '--url',
      `http://localhost:${port}`,
    ], {
      // Windows-specific options to prevent spawn errors
      windowsHide: true,
      // Use shell on Windows to handle path resolution better
      shell: isWindows,
      // Ensure stdio is set up properly
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /**
   * Attaches event handlers to the cloudflared process.
   */
  static attachHandlers(
    childProcess: ChildProcess,
    spinner: { fail: (msg: string) => void } | null = null,
    onFatalError?: () => Promise<void>,
  ): void {
    childProcess.stderr?.on('data', (chunk: Buffer) => this.handleStderr(chunk));
    childProcess.on('error', (err: Error) => this.handleError(err, spinner, onFatalError));
    childProcess.on('close', (code: number | null) => this.handleClose(code));
  }

  /**
   * Processes stderr output from cloudflared.
   */
  private static handleStderr(chunk: Buffer): void {
    const msg = chunk.toString();

    if (LOG_PATTERNS.IGNORE.some((pattern) => msg.includes(pattern))) {
      return;
    }

    if (LOG_PATTERNS.NETWORK_WARNING.some((pattern) => msg.includes(pattern))) {
      this.handleNetworkWarning();
      return;
    }

    if (LOG_PATTERNS.SUCCESS.some((pattern) => msg.includes(pattern))) {
      const count = state.incrementConnection();
      
      if (count === 1) {
        state.resetNetworkIssues();
        console.log(chalk.green(lang.t('connection1')));
      } else if (count === 4) {
        console.log(chalk.green(lang.t('connection2')));
        UI.displayFooter(state.updateInfo);
      }
      return;
    }

    if (LOG_PATTERNS.ERROR.some((pattern) => msg.includes(pattern))) {
      console.error(chalk.red(`[Cloudflared] ${msg.trim()}`));
    }
  }

  /**
   * Handles network warnings.
   */
  private static handleNetworkWarning(): void {
    state.incrementNetworkIssue();
    
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
   * Displays network connectivity warning.
   */
  private static displayNetworkWarning(): void {
    console.log(chalk.yellow(lang.t('networkIssueTitle')));
    console.log(chalk.gray(lang.t('networkIssueDesc')));
    console.log(chalk.cyan(lang.t('networkIssueTunnel')));
    console.log(chalk.yellow(lang.t('networkIssueReasons')));
    console.log(chalk.gray(lang.t('networkIssueReason1')));
    console.log(chalk.gray(lang.t('networkIssueReason2')));
    console.log(chalk.gray(lang.t('networkIssueReason3')));
    console.log(chalk.yellow(lang.t('networkIssueFix')));
    console.log(chalk.gray(lang.t('networkIssueFix1')));
    console.log(chalk.gray(lang.t('networkIssueFix2')));
    console.log(chalk.gray(lang.t('networkIssueFix3')));
    console.log(chalk.gray(lang.t('networkIssueFix4')));
    console.log(chalk.blue(lang.t('networkIssueIgnore')));
  }

  /**
   * Handles spawn errors.
   */
  private static handleError(
    err: Error,
    spinner: { fail: (msg: string) => void } | null,
    onFatalError?: () => Promise<void>,
  ): void {
    if (spinner) {
      spinner.fail('Failed to spawn cloudflared process.');
    }
    console.error(chalk.red(`Process Error: ${err.message}`));
    
    if (process.platform === 'win32') {
      if (err.message.includes('UNKNOWN') || err.message.includes('ENOENT')) {
        console.error(chalk.yellow('\n💡 Windows troubleshooting tips:'));
        console.error(chalk.gray('   1. Check if Windows Defender/antivirus is blocking cloudflared.exe'));
        console.error(chalk.gray('   2. Try running the terminal as Administrator'));
        console.error(chalk.gray('   3. Reinstall nport: npm uninstall -g nport && npm install -g nport'));
      }
    } else if (err.message.includes('EACCES')) {
      console.error(chalk.yellow('\n💡 Permission denied troubleshooting:'));
      console.error(chalk.gray('   1. Run: chmod +x <path-to-nport>/bin/cloudflared'));
      console.error(chalk.gray('   2. Or reinstall: npm uninstall -g nport && npm install -g nport'));
    }

    if (onFatalError) {
      onFatalError();
    }
  }

  /**
   * Handles process exit.
   */
  private static handleClose(code: number | null): void {
    if (code !== 0 && code !== null) {
      console.log(chalk.red(`Tunnel process exited with code ${code}`));
    }
  }
}
