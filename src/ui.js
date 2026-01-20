import chalk from "chalk";
import { CONFIG } from "./config.js";
import { lang } from "./lang.js";

/**
 * @typedef {Object} UpdateInfo
 * @property {string} current - Current installed version
 * @property {string} latest - Latest available version on npm
 * @property {boolean} shouldUpdate - True if an update is available
 */

/**
 * UI Display Manager
 * 
 * Handles all console output and user interface formatting.
 * Uses chalk for colors and supports multilingual output via lang.t().
 * 
 * All user-facing strings use the language manager for i18n support.
 * Visual elements like borders and spacing are consistent across all displays.
 * 
 * @example
 * // Display startup banner
 * UI.displayStartupBanner(3000);
 * 
 * // Display success with tunnel URL
 * UI.displayTunnelSuccess("https://myapp.nport.link", 3000, updateInfo);
 */
export class UI {
  /**
   * Displays the project info header box.
   * 
   * Shows:
   * ```
   * ╭────────────────────────────────────────────────────────╮
   * │  N P O R T  ⚡️  Free & Open Source from Vietnam        │
   * ╰────────────────────────────────────────────────────────╯
   * ```
   * 
   * @returns {void}
   */
  static displayProjectInfo() {
    const line = "─".repeat(56);
    const headerText = lang.t("header");
    // Calculate proper padding (accounting for emojis which take visual space)
    const visualLength = 59; // Target visual width
    const padding = " ".repeat(Math.max(0, visualLength - headerText.length - 4));
    
    console.log(chalk.gray(`\n ╭${line}╮`));
    console.log(chalk.cyan.bold(` │  ${headerText}`) + padding + chalk.gray("│"));
    console.log(chalk.gray(` ╰${line}╯\n`));
  }

  /**
   * Displays the startup banner when the CLI starts.
   * 
   * Currently shows the project info header.
   * Could be extended to show additional startup information.
   * 
   * @param {number} port - The port being tunneled (for potential future use)
   * @returns {void}
   * 
   * @example
   * UI.displayStartupBanner(3000);
   */
  static displayStartupBanner(port) {
    this.displayProjectInfo();
  }

  /**
   * Displays the tunnel success message with the public URL.
   * 
   * Shows:
   * - The public HTTPS URL prominently
   * - Time remaining (4h by default)
   * 
   * @param {string} url - The public tunnel URL (e.g., "https://myapp.nport.link")
   * @param {number} port - The local port being tunneled
   * @param {UpdateInfo|null} updateInfo - Version update information, if available
   * @returns {void}
   * 
   * @example
   * UI.displayTunnelSuccess("https://myapp.nport.link", 3000, null);
   */
  static displayTunnelSuccess(url, port, updateInfo) {
    console.log(); // Extra spacing
    console.log(chalk.cyan.bold(`   👉  ${url}  👈\n`));
    console.log(chalk.gray("   " + "─".repeat(54) + "\n"));
    console.log(chalk.gray(`   ${lang.t("timeRemaining", { hours: CONFIG.TUNNEL_TIMEOUT_HOURS })}\n`));
  }
  
  /**
   * Displays the footer with call-to-action links.
   * 
   * Shows:
   * - Encouragement to star the repo
   * - Buy Me a Coffee link
   * - Update notification (if available)
   * 
   * Called after cloudflared connections are established.
   * 
   * @param {UpdateInfo|null} updateInfo - Version update information
   * @returns {void}
   * 
   * @example
   * UI.displayFooter({ current: "2.0.6", latest: "2.0.7", shouldUpdate: true });
   */
  static displayFooter(updateInfo) {
    console.log(chalk.gray("   " + "─".repeat(54) + "\n"));
    console.log(chalk.yellow.bold(`   ${lang.t("footerTitle")}\n`));
    console.log(chalk.gray(`      ${lang.t("footerSubtitle")}\n`));
    console.log(chalk.cyan(`   ${lang.t("dropStar")}`) + chalk.white("https://github.com/tuanngocptn/nport"));
    console.log(chalk.yellow(`   ${lang.t("sendCoffee")}`) + chalk.white("https://buymeacoffee.com/tuanngocptn"));
    
    if (updateInfo && updateInfo.shouldUpdate) {
      console.log(chalk.red.bold(`\n   ${lang.t("newVersion", { version: updateInfo.latest })}`));
      console.log(chalk.gray("      ") + chalk.cyan(lang.t("updateCommand")));
    }
    console.log();
  }

  /**
   * Displays a warning when the tunnel timeout is reached.
   * 
   * Called automatically after 4 hours, before cleanup begins.
   * 
   * @returns {void}
   */
  static displayTimeoutWarning() {
    console.log(
      chalk.yellow(
        `\n⏰ Tunnel has been running for ${CONFIG.TUNNEL_TIMEOUT_HOURS} hours.`
      )
    );
    console.log(chalk.yellow("   Automatically shutting down..."));
  }

  /**
   * Displays an error message to the user.
   * 
   * Stops any active spinner and shows the error in red.
   * 
   * @param {Error} error - The error to display
   * @param {Object|null} [spinner=null] - Ora spinner instance to stop
   * @returns {void}
   * 
   * @example
   * try {
   *   await riskyOperation();
   * } catch (error) {
   *   UI.displayError(error, spinner);
   * }
   */
  static displayError(error, spinner = null) {
    if (spinner) {
      spinner.fail("Failed to connect to server.");
    }
    console.error(chalk.red(error.message));
  }

  /**
   * Displays the start of the cleanup process.
   * 
   * Shows "TUNNEL SHUTDOWN" header and begins the cleanup status line.
   * Used in conjunction with displayCleanupSuccess or displayCleanupError.
   * 
   * @returns {void}
   */
  static displayCleanupStart() {
    console.log(chalk.red.bold(`\n\n   ${lang.t("tunnelShutdown")}\n`));
    process.stdout.write(chalk.gray(`      ${lang.t("cleaningUp")}`));
  }

  /**
   * Displays successful cleanup completion.
   * 
   * Shows "Done" on the cleanup line and the goodbye message.
   * Called after successful tunnel and DNS deletion.
   * 
   * @returns {void}
   */
  static displayCleanupSuccess() {
    console.log(chalk.green(lang.t("cleanupDone")));
    console.log(chalk.gray(`      ${lang.t("subdomainReleased")}\n`));
    this.displayGoodbye();
  }

  /**
   * Displays cleanup failure message.
   * 
   * Shows "Failed" on the cleanup line with explanation.
   * Still shows goodbye message - the tunnel will be cleaned by scheduled job.
   * 
   * @returns {void}
   */
  static displayCleanupError() {
    console.log(chalk.red(lang.t("cleanupFailed")));
    console.log(chalk.gray(`      ${lang.t("serverBusy")}\n`));
    this.displayGoodbye();
  }

  /**
   * Displays the goodbye message when the CLI exits.
   * 
   * Shows:
   * - Thank you message
   * - Website link
   * - Author credit
   * - How to change language
   * 
   * @returns {void}
   */
  static displayGoodbye() {
    console.log(chalk.gray("   " + "─".repeat(54) + "\n"));
    console.log(chalk.cyan.bold(`   ${lang.t("goodbyeTitle")}\n`));
    console.log(chalk.gray(`      ${lang.t("goodbyeMessage")}\n`));
    console.log(chalk.cyan(`      ${lang.t("website")}`) + chalk.white("https://nport.link"));
    console.log(chalk.cyan(`      ${lang.t("author")}`) + chalk.white("Nick Pham (https://github.com/tuanngocptn)"));
    console.log(chalk.cyan(`      ${lang.t("changeLanguage")}`) + chalk.yellow(lang.t("changeLanguageHint")));
    console.log();
  }

  /**
   * Displays version information with update check.
   * 
   * Shows:
   * - Current version
   * - Whether an update is available
   * - Update command if needed
   * - Link to learn more
   * 
   * @param {string} current - Current installed version (e.g., "2.0.7")
   * @param {UpdateInfo|null} updateInfo - Version update information
   * @returns {void}
   * 
   * @example
   * UI.displayVersion("2.0.7", { current: "2.0.7", latest: "2.1.0", shouldUpdate: true });
   */
  static displayVersion(current, updateInfo) {
    console.log(chalk.cyan.bold(`\n${lang.t("versionTitle", { version: current })}`));
    console.log(chalk.gray(`${lang.t("versionSubtitle")}\n`));
    
    if (updateInfo && updateInfo.shouldUpdate) {
      console.log(chalk.yellow(lang.t("versionAvailable", { version: updateInfo.latest })));
      console.log(chalk.cyan(lang.t("versionUpdate")) + chalk.white(`npm install -g nport@latest\n`));
    } else {
      console.log(chalk.green(`${lang.t("versionLatest")}\n`));
    }
    
    console.log(chalk.gray(lang.t("learnMore")) + chalk.cyan("https://nport.link\n"));
  }
}
