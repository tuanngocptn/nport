import fs from "fs";
import path from "path";
import os from "os";

/**
 * Configuration Manager
 * Handles persistent storage of user preferences (backend URL, language, etc.)
 */
class ConfigManager {
  constructor() {
    this.configDir = path.join(os.homedir(), ".nport");
    this.configFile = path.join(this.configDir, "config.json");
    this.oldLangFile = path.join(this.configDir, "lang"); // For migration
    this.config = this.loadConfig();
    this.migrateOldConfig();
  }

  /**
   * Load configuration from file
   * @returns {object} Configuration object
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
   * Migrate old configuration files to new unified format from version 2.0.5
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
   * Save configuration to file
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
   * Get backend URL from config
   * @returns {string|null} Saved backend URL or null
   */
  getBackendUrl() {
    return this.config.backendUrl || null;
  }

  /**
   * Set backend URL in config
   * @param {string} url - Backend URL to save
   * @returns {boolean} Success status
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
   * Get language from config
   * @returns {string|null} Saved language code or null
   */
  getLanguage() {
    return this.config.language || null;
  }

  /**
   * Set language in config
   * @param {string} lang - Language code to save (e.g., 'en', 'vi')
   * @returns {boolean} Success status
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
   * Get all configuration
   * @returns {object} All configuration
   */
  getAll() {
    return { ...this.config };
  }

  /**
   * Clear all configuration
   * @returns {boolean} Success status
   */
  clear() {
    this.config = {};
    return this.saveConfig();
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
