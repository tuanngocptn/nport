import { CONFIG } from "./config.js";

/**
 * Command Line Argument Parser
 * Handles parsing of CLI arguments for port, subdomain, and language
 */
export class ArgumentParser {
  static parse(argv) {
    const port = this.parsePort(argv);
    const subdomain = this.parseSubdomain(argv);
    const language = this.parseLanguage(argv);
    return { port, subdomain, language };
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

  static parseLanguage(argv) {
    // Check if --language flag exists without value (to trigger prompt)
    if (argv.includes('--language') || argv.includes('--lang') || argv.includes('-l')) {
      const langIndex = argv.indexOf('--language') !== -1 ? argv.indexOf('--language') :
                        argv.indexOf('--lang') !== -1 ? argv.indexOf('--lang') :
                        argv.indexOf('-l');
      
      // If flag is present but next arg is another flag or doesn't exist, return 'prompt'
      const nextArg = argv[langIndex + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        return 'prompt';
      }
    }

    // Try language flag formats: --language=en, --lang=en, -l en
    const formats = [
      () => this.findFlagWithEquals(argv, "--language="),
      () => this.findFlagWithEquals(argv, "--lang="),
      () => this.findFlagWithEquals(argv, "-l="),
      () => this.findFlagWithValue(argv, "--language"),
      () => this.findFlagWithValue(argv, "--lang"),
      () => this.findFlagWithValue(argv, "-l"),
    ];

    for (const format of formats) {
      const language = format();
      if (language) return language;
    }

    return null; // No language specified
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

