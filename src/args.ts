import type { ParsedArguments } from './types/index.js';
import { CONFIG } from './config.js';

/**
 * Command Line Argument Parser
 * 
 * Handles parsing of CLI arguments for the NPort command.
 */
export class ArgumentParser {
  /**
   * Parses command-line arguments into a configuration object.
   */
  static parse(argv: string[]): ParsedArguments {
    const port = this.parsePort(argv);
    const subdomain = this.parseSubdomain(argv);
    const language = this.parseLanguage(argv);
    const backendUrl = this.parseBackendUrl(argv);
    const setBackend = this.parseSetBackend(argv);
    return { port, subdomain, language, backendUrl, setBackend };
  }

  /**
   * Extracts the port number from arguments.
   */
  static parsePort(argv: string[]): number {
    const portArg = parseInt(argv[0], 10);
    return portArg || CONFIG.DEFAULT_PORT;
  }

  /**
   * Extracts the subdomain from arguments.
   */
  static parseSubdomain(argv: string[]): string {
    const formats = [
      () => this.findFlagWithEquals(argv, '--subdomain='),
      () => this.findFlagWithEquals(argv, '-s='),
      () => this.findFlagWithValue(argv, '--subdomain'),
      () => this.findFlagWithValue(argv, '-s'),
    ];

    for (const format of formats) {
      const subdomain = format();
      if (subdomain) return subdomain;
    }

    return this.generateRandomSubdomain();
  }

  /**
   * Extracts the language setting from arguments.
   */
  static parseLanguage(argv: string[]): string | null {
    if (argv.includes('--language') || argv.includes('--lang') || argv.includes('-l')) {
      const langIndex = argv.indexOf('--language') !== -1 ? argv.indexOf('--language') :
                        argv.indexOf('--lang') !== -1 ? argv.indexOf('--lang') :
                        argv.indexOf('-l');
      
      const nextArg = argv[langIndex + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        return 'prompt';
      }
    }

    const formats = [
      () => this.findFlagWithEquals(argv, '--language='),
      () => this.findFlagWithEquals(argv, '--lang='),
      () => this.findFlagWithEquals(argv, '-l='),
      () => this.findFlagWithValue(argv, '--language'),
      () => this.findFlagWithValue(argv, '--lang'),
      () => this.findFlagWithValue(argv, '-l'),
    ];

    for (const format of formats) {
      const language = format();
      if (language) return language;
    }

    return null;
  }

  /**
   * Extracts the backend URL from arguments.
   */
  static parseBackendUrl(argv: string[]): string | null {
    const formats = [
      () => this.findFlagWithEquals(argv, '--backend='),
      () => this.findFlagWithEquals(argv, '-b='),
      () => this.findFlagWithValue(argv, '--backend'),
      () => this.findFlagWithValue(argv, '-b'),
    ];

    for (const format of formats) {
      const url = format();
      if (url) return url;
    }

    return null;
  }

  /**
   * Extracts the set-backend command from arguments.
   */
  static parseSetBackend(argv: string[]): string | null {
    const formats = [
      () => this.findFlagWithEquals(argv, '--set-backend='),
      () => this.findFlagWithValue(argv, '--set-backend'),
    ];

    for (const format of formats) {
      const url = format();
      if (url) return url;
    }

    if (argv.includes('--set-backend')) {
      return 'clear';
    }

    return null;
  }

  /**
   * Finds a flag with value in --flag=value format.
   */
  private static findFlagWithEquals(argv: string[], flag: string): string | null {
    const arg = argv.find((a) => a.startsWith(flag));
    return arg ? arg.split('=')[1] : null;
  }

  /**
   * Finds a flag with value in --flag value format.
   */
  private static findFlagWithValue(argv: string[], flag: string): string | null {
    const index = argv.indexOf(flag);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
  }

  /**
   * Generates a random subdomain.
   */
  private static generateRandomSubdomain(): string {
    return `${CONFIG.SUBDOMAIN_PREFIX}${Math.floor(Math.random() * 10000)}`;
  }
}
