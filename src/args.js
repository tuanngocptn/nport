import { CONFIG } from "./config.js";

/**
 * @typedef {Object} ParsedArguments
 * @property {number} port - Local port to tunnel (default: 8080)
 * @property {string} subdomain - Subdomain to use (generated if not provided)
 * @property {string|null} language - Language code, 'prompt', or null
 * @property {string|null} backendUrl - Custom backend URL or null
 * @property {string|null} setBackend - Backend URL to save, 'clear', or null
 */

/**
 * Command Line Argument Parser
 * 
 * Handles parsing of CLI arguments for the NPort command.
 * Supports multiple argument formats for flexibility.
 * 
 * Supported arguments:
 * - `<port>` - First positional argument (default: 8080)
 * - `--subdomain`, `-s` - Custom subdomain
 * - `--backend`, `-b` - Custom backend URL (one-time)
 * - `--set-backend` - Save backend URL permanently
 * - `--language`, `-l` - Set or prompt for language
 * - `--version`, `-v` - Show version (handled in index.js)
 * 
 * @example
 * // Parse: nport 3000 -s myapp --backend https://custom.api.com
 * const config = ArgumentParser.parse(['3000', '-s', 'myapp', '--backend', 'https://custom.api.com']);
 * // config = { port: 3000, subdomain: 'myapp', backendUrl: 'https://custom.api.com', ... }
 */
export class ArgumentParser {
  /**
   * Parses command-line arguments into a configuration object.
   * 
   * @param {string[]} argv - Array of command-line arguments (process.argv.slice(2))
   * @returns {ParsedArguments} Parsed configuration object
   * 
   * @example
   * const args = ['3000', '-s', 'myapp'];
   * const config = ArgumentParser.parse(args);
   * // { port: 3000, subdomain: 'myapp', language: null, backendUrl: null, setBackend: null }
   */
  static parse(argv) {
    const port = this.parsePort(argv);
    const subdomain = this.parseSubdomain(argv);
    const language = this.parseLanguage(argv);
    const backendUrl = this.parseBackendUrl(argv);
    const setBackend = this.parseSetBackend(argv);
    return { port, subdomain, language, backendUrl, setBackend };
  }

  /**
   * Extracts the port number from arguments.
   * 
   * The port is expected as the first positional argument.
   * Falls back to CONFIG.DEFAULT_PORT (8080) if not provided or invalid.
   * 
   * @param {string[]} argv - Command-line arguments
   * @returns {number} Port number to tunnel
   * 
   * @example
   * ArgumentParser.parsePort(['3000', '-s', 'myapp']) // 3000
   * ArgumentParser.parsePort(['-s', 'myapp'])         // 8080 (default)
   * ArgumentParser.parsePort(['abc'])                 // 8080 (invalid, use default)
   */
  static parsePort(argv) {
    const portArg = parseInt(argv[0]);
    return portArg || CONFIG.DEFAULT_PORT;
  }

  /**
   * Extracts the subdomain from arguments.
   * 
   * Supports multiple formats:
   * - `--subdomain=myapp`
   * - `--subdomain myapp`
   * - `-s=myapp`
   * - `-s myapp`
   * 
   * If no subdomain is provided, generates a random one.
   * 
   * @param {string[]} argv - Command-line arguments
   * @returns {string} Subdomain to use
   * 
   * @example
   * ArgumentParser.parseSubdomain(['-s', 'myapp'])     // 'myapp'
   * ArgumentParser.parseSubdomain(['--subdomain=foo']) // 'foo'
   * ArgumentParser.parseSubdomain(['3000'])            // 'user-1234' (random)
   */
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

  /**
   * Extracts the language setting from arguments.
   * 
   * Supports:
   * - `--language en` or `-l vi` - Set specific language
   * - `--language` or `-l` (no value) - Returns 'prompt' to show picker
   * - No flag - Returns null (use saved preference)
   * 
   * @param {string[]} argv - Command-line arguments
   * @returns {string|null} Language code, 'prompt', or null
   * 
   * @example
   * ArgumentParser.parseLanguage(['-l', 'vi'])  // 'vi'
   * ArgumentParser.parseLanguage(['--language']) // 'prompt'
   * ArgumentParser.parseLanguage(['3000'])       // null
   */
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

  /**
   * Extracts the backend URL from arguments (temporary, one-time use).
   * 
   * Supports:
   * - `--backend https://api.example.com`
   * - `--backend=https://api.example.com`
   * - `-b https://api.example.com`
   * 
   * @param {string[]} argv - Command-line arguments
   * @returns {string|null} Backend URL or null
   * 
   * @example
   * ArgumentParser.parseBackendUrl(['-b', 'https://api.example.com']) // 'https://api.example.com'
   * ArgumentParser.parseBackendUrl(['3000'])                          // null
   */
  static parseBackendUrl(argv) {
    // Try backend URL flag formats: --backend=url, --backend url, -b url
    const formats = [
      () => this.findFlagWithEquals(argv, "--backend="),
      () => this.findFlagWithEquals(argv, "-b="),
      () => this.findFlagWithValue(argv, "--backend"),
      () => this.findFlagWithValue(argv, "-b"),
    ];

    for (const format of formats) {
      const url = format();
      if (url) return url;
    }

    return null; // No backend URL specified
  }

  /**
   * Extracts the set-backend command from arguments (permanent save).
   * 
   * Supports:
   * - `--set-backend https://api.example.com` - Save URL
   * - `--set-backend` (no value) - Returns 'clear' to remove saved URL
   * 
   * @param {string[]} argv - Command-line arguments
   * @returns {string|null} Backend URL to save, 'clear', or null
   * 
   * @example
   * ArgumentParser.parseSetBackend(['--set-backend', 'https://api.example.com']) // 'https://api.example.com'
   * ArgumentParser.parseSetBackend(['--set-backend'])                             // 'clear'
   * ArgumentParser.parseSetBackend(['3000'])                                      // null
   */
  static parseSetBackend(argv) {
    // Try set-backend flag formats: --set-backend=url, --set-backend url
    const formats = [
      () => this.findFlagWithEquals(argv, "--set-backend="),
      () => this.findFlagWithValue(argv, "--set-backend"),
    ];

    for (const format of formats) {
      const url = format();
      if (url) return url;
    }

    // Check if --set-backend flag exists without value (to clear)
    if (argv.includes('--set-backend')) {
      return 'clear';
    }

    return null; // No set-backend specified
  }

  /**
   * Finds a flag with value in `--flag=value` format.
   * 
   * @param {string[]} argv - Command-line arguments
   * @param {string} flag - Flag prefix to search for (e.g., "--subdomain=")
   * @returns {string|null} Value after the equals sign, or null if not found
   * @private
   * 
   * @example
   * findFlagWithEquals(['--subdomain=myapp'], '--subdomain=') // 'myapp'
   * findFlagWithEquals(['--other=val'], '--subdomain=')       // null
   */
  static findFlagWithEquals(argv, flag) {
    const arg = argv.find((a) => a.startsWith(flag));
    return arg ? arg.split("=")[1] : null;
  }

  /**
   * Finds a flag with value in `--flag value` format (space-separated).
   * 
   * @param {string[]} argv - Command-line arguments
   * @param {string} flag - Flag to search for (e.g., "--subdomain")
   * @returns {string|null} Value following the flag, or null if not found
   * @private
   * 
   * @example
   * findFlagWithValue(['--subdomain', 'myapp'], '--subdomain') // 'myapp'
   * findFlagWithValue(['--subdomain'], '--subdomain')          // null (no value)
   */
  static findFlagWithValue(argv, flag) {
    const index = argv.indexOf(flag);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
  }

  /**
   * Generates a random subdomain with the configured prefix.
   * 
   * Format: `{SUBDOMAIN_PREFIX}{random_number}` (e.g., "user-1234")
   * 
   * @returns {string} Random subdomain
   * @private
   * 
   * @example
   * generateRandomSubdomain() // 'user-5678'
   */
  static generateRandomSubdomain() {
    return `${CONFIG.SUBDOMAIN_PREFIX}${Math.floor(Math.random() * 10000)}`;
  }
}
