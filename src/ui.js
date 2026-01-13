import chalk from "chalk";
import { CONFIG } from "./config.js";
import { lang } from "./lang.js";

/**
 * UI Display Manager
 * Handles all console output and user interface with multilingual support
 */
export class UI {
  static displayProjectInfo() {
    const line = "─".repeat(56);
    console.log(chalk.gray(`\n ╭${line}╮`));
    console.log(chalk.cyan.bold(` │  ${lang.t("header")}`) + " ".repeat(56 - lang.t("header").length - 4) + chalk.gray("│"));
    console.log(chalk.gray(` ╰${line}╯\n`));
  }

  static displayStartupBanner(port) {
    this.displayProjectInfo();
  }

  static displayTunnelSuccess(url, port, updateInfo) {
    console.log(); // Extra spacing
    console.log(chalk.cyan.bold(`   👉  ${url}  👈\n`));
    console.log(chalk.gray("   " + "─".repeat(54) + "\n"));
    console.log(chalk.gray(`   ${lang.t("timeRemaining", { hours: CONFIG.TUNNEL_TIMEOUT_HOURS })}\n`));
  }
  
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
    console.log(chalk.red.bold(`\n\n   ${lang.t("tunnelShutdown")}\n`));
    process.stdout.write(chalk.gray(`      ${lang.t("cleaningUp")}`));
  }

  static displayCleanupSuccess() {
    console.log(chalk.green(lang.t("cleanupDone")));
    console.log(chalk.gray(`      ${lang.t("subdomainReleased")}\n`));
    this.displayGoodbye();
  }

  static displayCleanupError() {
    console.log(chalk.red(lang.t("cleanupFailed")));
    console.log(chalk.gray(`      ${lang.t("serverBusy")}\n`));
    this.displayGoodbye();
  }

  static displayGoodbye() {
    console.log(chalk.gray("   " + "─".repeat(54) + "\n"));
    console.log(chalk.cyan.bold(`   ${lang.t("goodbyeTitle")}\n`));
    console.log(chalk.gray(`      ${lang.t("goodbyeMessage")}\n`));
    console.log(chalk.cyan(`      ${lang.t("website")}`) + chalk.white("https://nport.link"));
    console.log(chalk.cyan(`      ${lang.t("author")}`) + chalk.white("Nick Pham (https://github.com/tuanngocptn)"));
    console.log(chalk.cyan(`      ${lang.t("changeLanguage")}`) + chalk.yellow(lang.t("changeLanguageHint")));
    console.log();
  }

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
