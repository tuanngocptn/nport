import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UserConfig } from './types/index.js';

/**
 * Configuration Manager
 * 
 * Handles persistent storage of user preferences in ~/.nport/config.json.
 */
class ConfigManager {
  private configDir: string;
  private configFile: string;
  private oldLangFile: string;
  private config: UserConfig;

  constructor() {
    this.configDir = path.join(os.homedir(), '.nport');
    this.configFile = path.join(this.configDir, 'config.json');
    this.oldLangFile = path.join(this.configDir, 'lang');
    this.config = this.loadConfig();
    this.migrateOldConfig();
  }

  /**
   * Loads configuration from the JSON file.
   */
  private loadConfig(): UserConfig {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf8');
        return JSON.parse(data) as UserConfig;
      }
    } catch {
      console.warn('Warning: Could not load config file, using defaults');
    }
    return {};
  }

  /**
   * Migrates old configuration files to the new unified format.
   */
  private migrateOldConfig(): void {
    try {
      if (!this.config.language && fs.existsSync(this.oldLangFile)) {
        const oldLang = fs.readFileSync(this.oldLangFile, 'utf8').trim();
        if (oldLang && ['en', 'vi'].includes(oldLang)) {
          this.config.language = oldLang;
          this.saveConfig();
          try {
            fs.unlinkSync(this.oldLangFile);
          } catch {
            // Ignore if can't delete
          }
        }
      }
    } catch {
      // Ignore migration errors
    }
  }

  /**
   * Saves the current configuration to disk.
   */
  private saveConfig(): boolean {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
      return true;
    } catch {
      console.warn('Warning: Could not save configuration');
      return false;
    }
  }

  /**
   * Gets the saved backend URL.
   */
  getBackendUrl(): string | null {
    return this.config.backendUrl ?? null;
  }

  /**
   * Sets or clears the backend URL.
   */
  setBackendUrl(url: string | null): boolean {
    if (!url) {
      delete this.config.backendUrl;
    } else {
      this.config.backendUrl = url;
    }
    return this.saveConfig();
  }

  /**
   * Gets the saved language preference.
   */
  getLanguage(): string | null {
    return this.config.language ?? null;
  }

  /**
   * Sets or clears the language preference.
   */
  setLanguage(lang: string | null): boolean {
    if (!lang) {
      delete this.config.language;
    } else {
      this.config.language = lang;
    }
    return this.saveConfig();
  }

  /**
   * Gets a copy of all configuration.
   */
  getAll(): UserConfig {
    return { ...this.config };
  }

  /**
   * Clears all configuration.
   */
  clear(): boolean {
    this.config = {};
    return this.saveConfig();
  }
}

/**
 * Singleton instance
 */
export const configManager = new ConfigManager();
