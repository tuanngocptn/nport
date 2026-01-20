import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { configManager } from "./config-manager.js";

// ============================================================================
// Language Translations
// ============================================================================

/**
 * Translation strings for all supported languages.
 * 
 * Each language has a complete set of UI strings.
 * Variables use {varName} syntax for substitution.
 * 
 * To add a new language:
 * 1. Add language code to LanguageManager.availableLanguages
 * 2. Add translation object here with all keys
 * 
 * @constant {Object.<string, Object.<string, string>>}
 * @private
 */
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
    
    // Network warnings
    networkIssueTitle: "\n⚠️  NETWORK CONNECTIVITY ISSUE DETECTED",
    networkIssueDesc: "   Cloudflared is having trouble maintaining a stable connection to Cloudflare's edge servers.",
    networkIssueTunnel: "   📡 Your tunnel is still working, but connection quality may be affected.",
    networkIssueReasons: "\n   💡 Possible reasons:",
    networkIssueReason1: "      • Unstable internet connection or high packet loss",
    networkIssueReason2: "      • Firewall/Router blocking UDP traffic (QUIC protocol)",
    networkIssueReason3: "      • ISP throttling or network congestion",
    networkIssueFix: "\n   🔧 What to try:",
    networkIssueFix1: "      • Check your internet connection stability",
    networkIssueFix2: "      • Try connecting from a different network",
    networkIssueFix3: "      • Disable VPN/Proxy if you're using one",
    networkIssueFix4: "      • The tunnel will automatically fallback to HTTP/2 if QUIC fails",
    networkIssueIgnore: "\n   ℹ️  This is usually not critical - your tunnel should continue working normally.\n",
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
    versionSubtitle: "Hơn cả Ngrok - Ma-de in Việt Nam",
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
    
    // Network warnings
    networkIssueTitle: "\n⚠️  PHÁT HIỆN VẤN ĐỀ MẠNG",
    networkIssueDesc: "   Cloudflared đang gặp khó khăn khi giữ kết nối ổn định tới Cloudflare edge servers.",
    networkIssueTunnel: "   📡 Tunnel của bạn vẫn hoạt động, nhưng chất lượng kết nối có thể bị ảnh hưởng.",
    networkIssueReasons: "\n   💡 Có thể do:",
    networkIssueReason1: "      • Mạng internet không ổn định hoặc mất gói tin",
    networkIssueReason2: "      • Firewall/Router chặn UDP traffic (giao thức QUIC)",
    networkIssueReason3: "      • Nhà mạng throttle hoặc tắc nghẽn mạng",
    networkIssueFix: "\n   🔧 Thử các cách sau:",
    networkIssueFix1: "      • Kiểm tra kết nối internet của bạn",
    networkIssueFix2: "      • Thử đổi sang mạng khác (ví dụ: 4G/5G)",
    networkIssueFix3: "      • Tắt VPN/Proxy nếu đang bật",
    networkIssueFix4: "      • Tunnel sẽ tự động chuyển sang HTTP/2 nếu QUIC fail",
    networkIssueIgnore: "\n   ℹ️  Lỗi này thường không nghiêm trọng - tunnel vẫn hoạt động bình thường.\n",
  }
};

// ============================================================================
// Language Manager
// ============================================================================

/**
 * Language Manager
 * 
 * Handles internationalization (i18n) for the CLI.
 * Supports English and Vietnamese with automatic language detection.
 * 
 * Features:
 * - Variable substitution in translation strings
 * - Persistent language preference storage
 * - Interactive language selection prompt
 * - Graceful fallback to English
 * 
 * @example
 * // Initialize with saved preference or prompt
 * await lang.initialize();
 * 
 * // Get translated string
 * console.log(lang.t("tunnelLive")); // "🚀 WE LIVE BABY!"
 * 
 * // With variable substitution
 * console.log(lang.t("creatingTunnel", { port: 3000 }));
 * // "Creating tunnel for port 3000..."
 */
class LanguageManager {
  constructor() {
    /**
     * Currently active language code
     * @type {string}
     */
    this.currentLanguage = "en";
    
    /**
     * List of supported language codes
     * @type {string[]}
     */
    this.availableLanguages = ["en", "vi"];
  }

  /**
   * Gets a translated string with variable substitution.
   * 
   * Variables in the format {varName} are replaced with values from vars.
   * Falls back to English if translation not found.
   * Falls back to key if no translation exists.
   * 
   * @param {string} key - Translation key (e.g., "tunnelLive")
   * @param {Object.<string, string|number>} [vars={}] - Variables to substitute
   * @returns {string} Translated string with variables replaced
   * 
   * @example
   * lang.t("header")
   * // "N P O R T  ⚡️  Free & Open Source from Vietnam ❤️"
   * 
   * lang.t("timeRemaining", { hours: 4 })
   * // "⏱️  Time:     4h remaining"
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
   * Loads saved language preference from config.
   * 
   * @returns {string|null} Saved language code, or null if not set/invalid
   * @private
   */
  loadLanguagePreference() {
    const lang = configManager.getLanguage();
    if (lang && this.availableLanguages.includes(lang)) {
      return lang;
    }
    return null;
  }

  /**
   * Saves language preference to config.
   * 
   * @param {string} lang - Language code to save
   * @returns {void}
   * @private
   */
  saveLanguagePreference(lang) {
    configManager.setLanguage(lang);
  }

  /**
   * Sets the current language.
   * 
   * @param {string} lang - Language code (e.g., "en", "vi")
   * @returns {boolean} True if language was valid and set, false otherwise
   * 
   * @example
   * lang.setLanguage("vi"); // true
   * lang.setLanguage("fr"); // false (not available)
   */
  setLanguage(lang) {
    if (this.availableLanguages.includes(lang)) {
      this.currentLanguage = lang;
      return true;
    }
    return false;
  }

  /**
   * Gets the current language code.
   * 
   * @returns {string} Current language code
   */
  getLanguage() {
    return this.currentLanguage;
  }

  /**
   * Prompts user to select a language interactively.
   * 
   * Shows a numbered list of available languages and waits for input.
   * Saves the selection and updates current language.
   * 
   * @returns {Promise<string>} Selected language code
   * 
   * @example
   * const selected = await lang.promptLanguageSelection();
   * // Shows:
   * // 🌍 Language Selection / Chọn ngôn ngữ
   * //    1. English
   * //    2. Tiếng Việt (Vietnamese)
   * // Choose your language (1-2):
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
   * Initializes the language system.
   * 
   * Priority order:
   * 1. CLI argument with value (e.g., --language en)
   * 2. Force prompt if --language flag without value
   * 3. Saved preference from config
   * 4. Interactive prompt on first run
   * 
   * @param {string|null} [cliLanguage=null] - Language from CLI, or 'prompt' to force selection
   * @returns {Promise<string>} The selected/active language code
   * 
   * @example
   * // Use saved preference or prompt if first run
   * await lang.initialize();
   * 
   * // Force specific language
   * await lang.initialize("vi");
   * 
   * // Force interactive prompt
   * await lang.initialize("prompt");
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

/**
 * Singleton instance of LanguageManager.
 * 
 * @type {LanguageManager}
 * 
 * @example
 * import { lang } from "./lang.js";
 * 
 * await lang.initialize();
 * console.log(lang.t("tunnelLive"));
 */
export const lang = new LanguageManager();
