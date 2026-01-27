import chalk from 'chalk';
import type { UpdateCheckResult } from './types/index.js';
import { GITHUB_URL, COFFEE_URL, WEBSITE_URL } from './constants.js';
import { CONFIG } from './config.js';
import { lang } from './lang.js';

/**
 * UI Display Manager
 * 
 * Handles all console output and user interface formatting.
 */
export class UI {
  /**
   * Displays the project info header box.
   */
  static displayProjectInfo(): void {
    const line = '─'.repeat(56);
    const headerText = lang.t('header');
    const visualLength = 59;
    const padding = ' '.repeat(Math.max(0, visualLength - headerText.length - 4));
    
    console.log(chalk.gray(`\n ╭${line}╮`));
    console.log(chalk.cyan.bold(` │  ${headerText}`) + padding + chalk.gray('│'));
    console.log(chalk.gray(` ╰${line}╯\n`));
  }

  /**
   * Displays the startup banner.
   */
  static displayStartupBanner(_port: number): void {
    this.displayProjectInfo();
  }

  /**
   * Displays the tunnel success message.
   */
  static displayTunnelSuccess(url: string, _port: number, _updateInfo: UpdateCheckResult | null): void {
    console.log();
    console.log(chalk.cyan.bold(`   👉  ${url}  👈\n`));
    console.log(chalk.gray('   ' + '─'.repeat(54) + '\n'));
    console.log(chalk.gray(`   ${lang.t('timeRemaining', { hours: CONFIG.TUNNEL_TIMEOUT_HOURS })}\n`));
  }
  
  /**
   * Displays the footer with call-to-action links.
   */
  static displayFooter(updateInfo: UpdateCheckResult | null): void {
    console.log(chalk.gray('   ' + '─'.repeat(54) + '\n'));
    console.log(chalk.yellow.bold(`   ${lang.t('footerTitle')}\n`));
    console.log(chalk.gray(`      ${lang.t('footerSubtitle')}\n`));
    console.log(chalk.cyan(`   ${lang.t('dropStar')}`) + chalk.white(GITHUB_URL));
    console.log(chalk.yellow(`   ${lang.t('sendCoffee')}`) + chalk.white(COFFEE_URL));
    
    if (updateInfo?.shouldUpdate) {
      console.log(chalk.red.bold(`\n   ${lang.t('newVersion', { version: updateInfo.latest })}`));
      console.log(chalk.gray('      ') + chalk.cyan(lang.t('updateCommand')));
    }
    console.log();
  }

  /**
   * Displays timeout warning.
   */
  static displayTimeoutWarning(): void {
    console.log(
      chalk.yellow(
        `\n⏰ Tunnel has been running for ${CONFIG.TUNNEL_TIMEOUT_HOURS} hours.`
      )
    );
    console.log(chalk.yellow('   Automatically shutting down...'));
  }

  /**
   * Displays an error message.
   */
  static displayError(error: Error, spinner: { fail: (msg: string) => void } | null = null): void {
    if (spinner) {
      spinner.fail('Failed to connect to server.');
    }
    console.error(chalk.red(error.message));
  }

  /**
   * Displays cleanup start.
   */
  static displayCleanupStart(): void {
    console.log(chalk.red.bold(`\n\n   ${lang.t('tunnelShutdown')}\n`));
    process.stdout.write(chalk.gray(`      ${lang.t('cleaningUp')}`));
  }

  /**
   * Displays cleanup success.
   */
  static displayCleanupSuccess(): void {
    console.log(chalk.green(lang.t('cleanupDone')));
    console.log(chalk.gray(`      ${lang.t('subdomainReleased')}\n`));
    this.displayGoodbye();
  }

  /**
   * Displays cleanup error.
   */
  static displayCleanupError(): void {
    console.log(chalk.red(lang.t('cleanupFailed')));
    console.log(chalk.gray(`      ${lang.t('serverBusy')}\n`));
    this.displayGoodbye();
  }

  /**
   * Displays goodbye message.
   */
  static displayGoodbye(): void {
    console.log(chalk.gray('   ' + '─'.repeat(54) + '\n'));
    console.log(chalk.cyan.bold(`   ${lang.t('goodbyeTitle')}\n`));
    console.log(chalk.gray(`      ${lang.t('goodbyeMessage')}\n`));
    console.log(chalk.cyan(`      ${lang.t('website')}`) + chalk.white(WEBSITE_URL));
    console.log(chalk.cyan(`      ${lang.t('author')}`) + chalk.white('Nick Pham (https://github.com/tuanngocptn)'));
    console.log(chalk.cyan(`      ${lang.t('changeLanguage')}`) + chalk.yellow(lang.t('changeLanguageHint')));
    console.log();
  }

  /**
   * Displays version information.
   */
  static displayVersion(current: string, updateInfo: UpdateCheckResult | null): void {
    console.log(chalk.cyan.bold(`\n${lang.t('versionTitle', { version: current })}`));
    console.log(chalk.gray(`${lang.t('versionSubtitle')}\n`));
    
    if (updateInfo?.shouldUpdate) {
      console.log(chalk.yellow(lang.t('versionAvailable', { version: updateInfo.latest })));
      console.log(chalk.cyan(lang.t('versionUpdate')) + chalk.white('npm install -g nport@latest\n'));
    } else {
      console.log(chalk.green(`${lang.t('versionLatest')}\n`));
    }
    
    console.log(chalk.gray(lang.t('learnMore')) + chalk.cyan(`${WEBSITE_URL}\n`));
  }
}
