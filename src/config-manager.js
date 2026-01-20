import fs from "fs";
import path from "path";
import os from "os";

/**
 * @typedef {Object} UserConfig
 * @property {string} [language] - Preferred language code (e.g., "en", "vi")
 * @property {string} [backendUrl] - Custom backend URL
 */

/**
 * Configuration Manager
 * 
 * Handles persistent storage of user preferences in ~/.nport/config.json.
 * Manages settings like language preference and custom backend URL.
 * 
 * Features:
 * - Automatic migration from old config format (pre-2.0.5)
 * - Graceful handling of missing/corrupted config files
 * - JSON-based storage for easy debugging
 * 
 * @example
 * // Get saved backend URL
 * const url = configManager.getBackendUrl();
 * 
 * // Save a new language preference
 * configManager.setLanguage("vi");
 */
class ConfigManager {
  constructor() {
    /**
     * Path to the .nport config directory
     * @type {string}
     */
    this.configDir = path.join(os.homedir(), ".nport");
    
    /**
     * Path to the config.json file
     * @type {string}
     */
    this.configFile = path.join(this.configDir, "config.json");
    
    /**
     * Path to old language file (for migration)
     * @type {string}
     */
    this.oldLangFile = path.join(this.configDir, "lang");
    
    /**
     * In-memory config object
     * @type {UserConfig}
     */
    this.config = this.loadConfig();
    this.migrateOldConfig();
  }

  /**
   * Loads configuration from the JSON file.
   * 
   * @returns {UserConfig} Configuration object, or empty object if not found
   * @private
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf8");
        return JSON.parse(data);
      }
    } catch (error) {
      // If config is corrupted or invalid, return default
      console.warn("Warning: Could not load config file, using defaults");
    }
    return {};
  }

  /**
   * Migrates old configuration files to the new unified format.
   * 
   * In version 2.0.5, configuration was unified into config.json.
   * This method migrates the old ~/.nport/lang file to the new format.
   * 
   * @returns {void}
   * @private
   */
  migrateOldConfig() {
    try {
      // Migrate old language file if it exists and no language in config
      if (!this.config.language && fs.existsSync(this.oldLangFile)) {
        const oldLang = fs.readFileSync(this.oldLangFile, "utf8").trim();
        if (oldLang && ["en", "vi"].includes(oldLang)) {
          this.config.language = oldLang;
          this.saveConfig();
          // Optionally delete old file
          try {
            fs.unlinkSync(this.oldLangFile);
          } catch (err) {
            // Ignore if can't delete
          }
        }
      }
    } catch (error) {
      // Ignore migration errors
    }
  }

  /**
   * Saves the current configuration to disk.
   * 
   * Creates the ~/.nport directory if it doesn't exist.
   * 
   * @returns {boolean} True if save succeeded, false otherwise
   * @private
   */
  saveConfig() {
    try {
      // Ensure .nport directory exists
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), "utf8");
      return true;
    } catch (error) {
      console.warn("Warning: Could not save configuration");
      return false;
    }
  }

  /**
   * Gets the saved backend URL.
   * 
   * @returns {string|null} Saved backend URL, or null if not set
   * 
   * @example
   * const url = configManager.getBackendUrl();
   * if (url) {
   *   console.log(`Using custom backend: ${url}`);
   * }
   */
  getBackendUrl() {
    return this.config.backendUrl || null;
  }

  /**
   * Sets or clears the backend URL.
   * 
   * @param {string|null} url - Backend URL to save, or null/falsy to clear
   * @returns {boolean} True if save succeeded
   * 
   * @example
   * // Set custom backend
   * configManager.setBackendUrl("https://my-backend.com");
   * 
   * // Clear custom backend (use default)
   * configManager.setBackendUrl(null);
   */
  setBackendUrl(url) {
    if (!url) {
      delete this.config.backendUrl;
    } else {
      this.config.backendUrl = url;
    }
    return this.saveConfig();
  }

  /**
   * Gets the saved language preference.
   * 
   * @returns {string|null} Language code (e.g., "en", "vi"), or null if not set
   * 
   * @example
   * const lang = configManager.getLanguage();
   * if (lang) {
   *   console.log(`Using language: ${lang}`);
   * }
   */
  getLanguage() {
    return this.config.language || null;
  }

  /**
   * Sets or clears the language preference.
   * 
   * @param {string|null} lang - Language code to save (e.g., "en", "vi"), or null to clear
   * @returns {boolean} True if save succeeded
   * 
   * @example
   * configManager.setLanguage("vi");
   */
  setLanguage(lang) {
    if (!lang) {
      delete this.config.language;
    } else {
      this.config.language = lang;
    }
    return this.saveConfig();
  }

  /**
   * Gets a copy of all configuration.
   * 
   * @returns {UserConfig} Copy of the configuration object
   * 
   * @example
   * const allConfig = configManager.getAll();
   * console.log(JSON.stringify(allConfig, null, 2));
   */
  getAll() {
    return { ...this.config };
  }

  /**
   * Clears all configuration and saves empty config.
   * 
   * @returns {boolean} True if save succeeded
   * 
   * @example
   * configManager.clear();
   */
  clear() {
    this.config = {};
    return this.saveConfig();
  }
}

/**
 * Singleton instance of ConfigManager.
 * 
 * @type {ConfigManager}
 */
export const configManager = new ConfigManager();
