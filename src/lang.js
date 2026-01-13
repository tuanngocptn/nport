import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { configManager } from "./config-manager.js";

// ============================================================================
// Language Translations
// ============================================================================

const TRANSLATIONS = {
  en: {
    // Header
    header: "N P O R T  ⚡️  Free & Open Source from Vietnam ❤️",
    
    // Spinners
    creatingTunnel: "Creating tunnel for port {port}...",
    checkingUpdates: "Checking for updates...",
    
    // Success messages
    tunnelLive: "🚀 WE LIVE BABY!",
    connection1: "   ✔ [1/2] Connection established...",
    connection2: "   ✔ [2/2] Compression enabled...",
    timeRemaining: "⏱️  Time:     {hours}h remaining",
    
    // Footer
    footerTitle: "🔥 KEEP THE VIBE ALIVE?",
    footerSubtitle: "(Made with ❤️  in Vietnam)",
    dropStar: "⭐️  Drop a Star:   ",
    sendCoffee: "☕️  Buy Coffee:    ",
    newVersion: "🚨 NEW VERSION (v{version}) detected!",
    updateCommand: "> npm install -g nport@latest",
    
    // Cleanup
    tunnelShutdown: "🛑 TUNNEL SHUTDOWN.",
    cleaningUp: "Cleaning up... ",
    cleanupDone: "Done.",
    cleanupFailed: "Failed.",
    subdomainReleased: "Subdomain...   Released. 🗑️",
    serverBusy: "(Server might be down or busy)",
    
    // Goodbye
    goodbyeTitle: "👋 BEFORE YOU GO...",
    goodbyeMessage: "Thanks for using NPort!",
    website: "🌐 Website:     ",
    author: "👤 Author:      ",
    changeLanguage: "🌍 Language:    ",
    changeLanguageHint: "nport --language",
    
    // Version
    versionTitle: "NPort v{version}",
    versionSubtitle: "Free & open source ngrok alternative",
    versionLatest: "✔ You're running the latest version!",
    versionAvailable: "🚨 New version available: v{version}",
    versionUpdate: "Update now: ",
    learnMore: "Learn more: ",
    
    // Language selection
    languagePrompt: "\n🌍 Language Selection / Chọn ngôn ngữ\n",
    languageQuestion: "Choose your language (1-2): ",
    languageEnglish: "1. English",
    languageVietnamese: "2. Tiếng Việt (Vietnamese)",
    languageInvalid: "Invalid choice. Using English by default.",
    languageSaved: "✔ Language preference saved!",
  },
  
  vi: {
    // Header
    header: "N P O R T  ⚡️  Việt Nam Mãi Đỉnh ❤️",
    
    // Spinners
    creatingTunnel: "🛠️ Đang khởi động cổng {port}... Chuẩn bị bay nào!",
    checkingUpdates: "🔍 Đang dò la bản cập nhật mới... Đợi tí sắp có quà!",
    
    // Success messages
    tunnelLive: "🚀 BẬT MODE TỐC HÀNH! ĐANG BAY RỒI NÈ!",
    connection1: "   ✔ [1/2] Đang cắm dây mạng vũ trụ...",
    connection2: "   ✔ [2/2] Đang bơm siêu nén khí tốc độ ánh sáng...",
    timeRemaining: "⏱️  Tăng tốc thần sầu: Còn {hours}h để quẩy!",
    
    // Footer
    footerTitle: "🔥 LƯU DANH SỬ SÁCH! ĐỪNG QUÊN STAR ⭐️",
    footerSubtitle: "(Made in Việt Nam, chuẩn không cần chỉnh! ❤️)",
    dropStar: "⭐️  Thả Star: ",
    sendCoffee: "☕️  Tặng Coffee: ",
    newVersion: "🚀 BẢN MỚI (v{version}) vừa hạ cánh!",
    updateCommand: "💡 Gõ liền: npm install -g nport@latest",
    
    // Cleanup
    tunnelShutdown: "🛑 Đã tới giờ 'chốt' deal rồi cả nhà ơi...",
    cleaningUp: "Đang dọn dẹp chiến trường... 🧹",
    cleanupDone: "Xịn xò! Đã dọn xong rồi nè.",
    cleanupFailed: "Oằn trời, dọn không nổi!",
    subdomainReleased: "Subdomain...   Xí xoá! Tạm biệt nhé 🗑️✨",
    serverBusy: "(Có thể server đang bận order trà sữa)",
    
    // Goodbye
    goodbyeTitle: "👋 GẶP LẠI BẠN Ở ĐƯỜNG BĂNG KHÁC...",
    goodbyeMessage: "Cảm ơn đã quẩy NPort! Lần sau chơi tiếp nha 😘",
    website: "🌐 Sân chơi chính: ",
    author: "👤 Nhà tài trợ: ",
    changeLanguage: "🌍 Đổi ngôn ngữ: ",
    changeLanguageHint: "nport --language",
    
    // Version
    versionTitle: "NPort v{version}",
    versionSubtitle: "Hơn cả Ngrok - Ma-de in Ziệt Nam",
    versionLatest: "🎉 Chúc mừng! Đang cùng server với bản mới nhất!",
    versionAvailable: "🌟 Vèo vèo: Có bản mới v{version} vừa cập bến!",
    versionUpdate: "Update khẩn trương lẹ làng: ",
    learnMore: "Khám phá thêm cho nóng: ",
    
    // Language selection
    languagePrompt: "\n🌍 Chọn lựa ngôn ngữ ngay bên dưới nào!\n",
    languageQuestion: "Chớp lấy một lựa chọn nha (1-2): ",
    languageEnglish: "1. English (Chuẩn quốc tế!)",
    languageVietnamese: "2. Tiếng Việt (Đỉnh của chóp)",
    languageInvalid: "Ơ hơ, chọn sai rồi! Mặc định Tiếng Việt luôn cho nóng.",
    languageSaved: "🎯 Xong rồi! Lưu ngôn ngữ thành công!",
  }
};

// ============================================================================
// Language Manager
// ============================================================================

class LanguageManager {
  constructor() {
    this.currentLanguage = "en";
    this.availableLanguages = ["en", "vi"];
  }

  /**
   * Get translation string with variable substitution
   * @param {string} key - Translation key
   * @param {object} vars - Variables to substitute
   * @returns {string} Translated string
   */
  t(key, vars = {}) {
    const translations = TRANSLATIONS[this.currentLanguage] || TRANSLATIONS.en;
    let text = translations[key] || TRANSLATIONS.en[key] || key;
    
    // Replace variables like {port}, {version}, etc.
    Object.keys(vars).forEach(varKey => {
      text = text.replace(`{${varKey}}`, vars[varKey]);
    });
    
    return text;
  }

  /**
   * Load saved language preference
   * @returns {string|null} Saved language code or null
   */
  loadLanguagePreference() {
    const lang = configManager.getLanguage();
    if (lang && this.availableLanguages.includes(lang)) {
      return lang;
    }
    return null;
  }

  /**
   * Save language preference
   * @param {string} lang - Language code to save
   */
  saveLanguagePreference(lang) {
    configManager.setLanguage(lang);
  }

  /**
   * Set current language
   * @param {string} lang - Language code
   */
  setLanguage(lang) {
    if (this.availableLanguages.includes(lang)) {
      this.currentLanguage = lang;
      return true;
    }
    return false;
  }

  /**
   * Get current language
   * @returns {string} Current language code
   */
  getLanguage() {
    return this.currentLanguage;
  }

  /**
   * Prompt user to select language
   * @returns {Promise<string>} Selected language code
   */
  async promptLanguageSelection() {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(this.t("languagePrompt"));
      console.log(`   ${this.t("languageEnglish")}`);
      console.log(`   ${this.t("languageVietnamese")}\n`);

      rl.question(`${this.t("languageQuestion")}`, (answer) => {
        rl.close();
        
        const choice = answer.trim();
        let selectedLang = "en";
        
        if (choice === "1") {
          selectedLang = "en";
        } else if (choice === "2") {
          selectedLang = "vi";
        } else {
          console.log(`\n${this.t("languageInvalid")}\n`);
        }
        
        this.setLanguage(selectedLang);
        this.saveLanguagePreference(selectedLang);
        console.log(`${this.t("languageSaved")}\n`);
        
        resolve(selectedLang);
      });
    });
  }

  /**
   * Initialize language - load from config or prompt user
   * @param {string|null} cliLanguage - Language from CLI argument (or 'prompt' to force prompt)
   * @returns {Promise<string>} Selected language code
   */
  async initialize(cliLanguage = null) {
    // Priority 1: CLI argument with value (e.g., --language en)
    if (cliLanguage && cliLanguage !== 'prompt' && this.setLanguage(cliLanguage)) {
      this.saveLanguagePreference(cliLanguage);
      return cliLanguage;
    }

    // Priority 2: Force prompt if --language flag without value
    if (cliLanguage === 'prompt') {
      return await this.promptLanguageSelection();
    }

    // Priority 3: Saved preference
    const savedLang = this.loadLanguagePreference();
    if (savedLang) {
      this.setLanguage(savedLang);
      return savedLang;
    }

    // Priority 4: Prompt user on first run
    return await this.promptLanguageSelection();
  }
}

// ============================================================================
// Export singleton instance
// ============================================================================

export const lang = new LanguageManager();

