import readline from 'readline';
import type { LanguageCode, TranslationKeys, TranslationVariables } from './types/index.js';
import { AVAILABLE_LANGUAGES } from './constants.js';
import { configManager } from './config-manager.js';

/**
 * Translation strings for all supported languages
 */
const TRANSLATIONS: Record<LanguageCode, TranslationKeys> = {
  en: {
    header: 'N P O R T  ⚡️  Free & Open Source from Vietnam ❤️',
    creatingTunnel: 'Creating tunnel for port {port}...',
    checkingUpdates: 'Checking for updates...',
    tunnelLive: '🚀 WE LIVE BABY!',
    connection1: '   ✔ [1/2] Connection established...',
    connection2: '   ✔ [2/2] Compression enabled...',
    timeRemaining: '⏱️  Time:     {hours}h remaining',
    footerTitle: '🔥 KEEP THE VIBE ALIVE?',
    footerSubtitle: '(Made with ❤️  in Vietnam)',
    dropStar: '⭐️  Drop a Star:   ',
    sendCoffee: '☕️  Buy Coffee:    ',
    newVersion: '🚨 NEW VERSION (v{version}) detected!',
    updateCommand: '> npm install -g nport@latest',
    tunnelShutdown: '🛑 TUNNEL SHUTDOWN.',
    cleaningUp: 'Cleaning up... ',
    cleanupDone: 'Done.',
    cleanupFailed: 'Failed.',
    subdomainReleased: 'Subdomain...   Released. 🗑️',
    serverBusy: '(Server might be down or busy)',
    goodbyeTitle: '👋 BEFORE YOU GO...',
    goodbyeMessage: 'Thanks for using NPort!',
    website: '🌐 Website:     ',
    author: '👤 Author:      ',
    changeLanguage: '🌍 Language:    ',
    changeLanguageHint: 'nport --language',
    versionTitle: 'NPort v{version}',
    versionSubtitle: 'Free & open source ngrok alternative',
    versionLatest: '✔ You\'re running the latest version!',
    versionAvailable: '🚨 New version available: v{version}',
    versionUpdate: 'Update now: ',
    learnMore: 'Learn more: ',
    languagePrompt: '\n🌍 Language Selection / Chọn ngôn ngữ / Selección de idioma\n',
    languageQuestion: 'Choose your language (1-3): ',
    languageEnglish: '1. English',
    languageVietnamese: '2. Tiếng Việt (Vietnamese)',
    languageSpanish: '3. Español (Spanish)',
    languageInvalid: 'Invalid choice. Using English by default.',
    languageSaved: '✔ Language preference saved!',
    networkIssueTitle: '\n⚠️  NETWORK CONNECTIVITY ISSUE DETECTED',
    networkIssueDesc: '   Cloudflared is having trouble maintaining a stable connection to Cloudflare\'s edge servers.',
    networkIssueTunnel: '   📡 Your tunnel is still working, but connection quality may be affected.',
    networkIssueReasons: '\n   💡 Possible reasons:',
    networkIssueReason1: '      • Unstable internet connection or high packet loss',
    networkIssueReason2: '      • Firewall/Router blocking UDP traffic (QUIC protocol)',
    networkIssueReason3: '      • ISP throttling or network congestion',
    networkIssueFix: '\n   🔧 What to try:',
    networkIssueFix1: '      • Check your internet connection stability',
    networkIssueFix2: '      • Try connecting from a different network',
    networkIssueFix3: '      • Disable VPN/Proxy if you\'re using one',
    networkIssueFix4: '      • The tunnel will automatically fallback to HTTP/2 if QUIC fails',
    networkIssueIgnore: '\n   ℹ️  This is usually not critical - your tunnel should continue working normally.\n',
    binaryChmodFailed: '⚠️  Could not set executable permissions on {filePath} (permission denied).\n   This usually happens when nport was installed with sudo.\n   The binary should still work. If you hit issues, try either:\n      • Fix permissions: sudo chmod 755 {filePath}\n      • Or run nport with sudo: sudo nport [...args]',
  },
  
  vi: {
    header: 'N P O R T  ⚡️  Việt Nam Mãi Đỉnh ❤️',
    creatingTunnel: '🛠️ Đang khởi động cổng {port}... Chuẩn bị bay nào!',
    checkingUpdates: '🔍 Đang dò la bản cập nhật mới... Đợi tí sắp có quà!',
    tunnelLive: '🚀 BẬT MODE TỐC HÀNH! ĐANG BAY RỒI NÈ!',
    connection1: '   ✔ [1/2] Đang cắm dây mạng vũ trụ...',
    connection2: '   ✔ [2/2] Đang bơm siêu nén khí tốc độ ánh sáng...',
    timeRemaining: '⏱️  Tăng tốc thần sầu: Còn {hours}h để quẩy!',
    footerTitle: '🔥 LƯU DANH SỬ SÁCH! ĐỪNG QUÊN STAR ⭐️',
    footerSubtitle: '(Made in Việt Nam, chuẩn không cần chỉnh! ❤️)',
    dropStar: '⭐️  Thả Star: ',
    sendCoffee: '☕️  Tặng Coffee: ',
    newVersion: '🚀 BẢN MỚI (v{version}) vừa hạ cánh!',
    updateCommand: '💡 Gõ liền: npm install -g nport@latest',
    tunnelShutdown: '🛑 Đã tới giờ \'chốt\' deal rồi cả nhà ơi...',
    cleaningUp: 'Đang dọn dẹp chiến trường... 🧹',
    cleanupDone: 'Xịn xò! Đã dọn xong rồi nè.',
    cleanupFailed: 'Oằn trời, dọn không nổi!',
    subdomainReleased: 'Subdomain...   Xí xoá! Tạm biệt nhé 🗑️✨',
    serverBusy: '(Có thể server đang bận order trà sữa)',
    goodbyeTitle: '👋 GẶP LẠI BẠN Ở ĐƯỜNG BĂNG KHÁC...',
    goodbyeMessage: 'Cảm ơn đã quẩy NPort! Lần sau chơi tiếp nha 😘',
    website: '🌐 Sân chơi chính: ',
    author: '👤 Nhà tài trợ: ',
    changeLanguage: '🌍 Đổi ngôn ngữ: ',
    changeLanguageHint: 'nport --language',
    versionTitle: 'NPort v{version}',
    versionSubtitle: 'Hơn cả Ngrok - Ma-de in Việt Nam',
    versionLatest: '🎉 Chúc mừng! Đang cùng server với bản mới nhất!',
    versionAvailable: '🌟 Vèo vèo: Có bản mới v{version} vừa cập bến!',
    versionUpdate: 'Update khẩn trương lẹ làng: ',
    learnMore: 'Khám phá thêm cho nóng: ',
    languagePrompt: '\n🌍 Chọn lựa ngôn ngữ ngay bên dưới nào!\n',
    languageQuestion: 'Chớp lấy một lựa chọn nha (1-3): ',
    languageEnglish: '1. English (Chuẩn quốc tế!)',
    languageVietnamese: '2. Tiếng Việt (Đỉnh của chóp)',
    languageSpanish: '3. Español (Tây Ban Nha)',
    languageInvalid: 'Ơ hơ, chọn sai rồi! Mặc định Tiếng Việt luôn cho nóng.',
    languageSaved: '🎯 Xong rồi! Lưu ngôn ngữ thành công!',
    networkIssueTitle: '\n⚠️  PHÁT HIỆN VẤN ĐỀ MẠNG',
    networkIssueDesc: '   Cloudflared đang gặp khó khăn khi giữ kết nối ổn định tới Cloudflare edge servers.',
    networkIssueTunnel: '   📡 Tunnel của bạn vẫn hoạt động, nhưng chất lượng kết nối có thể bị ảnh hưởng.',
    networkIssueReasons: '\n   💡 Có thể do:',
    networkIssueReason1: '      • Mạng internet không ổn định hoặc mất gói tin',
    networkIssueReason2: '      • Firewall/Router chặn UDP traffic (giao thức QUIC)',
    networkIssueReason3: '      • Nhà mạng throttle hoặc tắc nghẽn mạng',
    networkIssueFix: '\n   🔧 Thử các cách sau:',
    networkIssueFix1: '      • Kiểm tra kết nối internet của bạn',
    networkIssueFix2: '      • Thử đổi sang mạng khác (ví dụ: 4G/5G)',
    networkIssueFix3: '      • Tắt VPN/Proxy nếu đang bật',
    networkIssueFix4: '      • Tunnel sẽ tự động chuyển sang HTTP/2 nếu QUIC fail',
    networkIssueIgnore: '\n   ℹ️  Lỗi này thường không nghiêm trọng - tunnel vẫn hoạt động bình thường.\n',
    binaryChmodFailed: '⚠️  Không thể đặt quyền thực thi cho {filePath} (quyền bị từ chối).\n   Lỗi này thường xảy ra khi cài nport bằng sudo.\n   Binary vẫn hoạt động bình thường. Nếu gặp lỗi, thử một trong hai cách:\n      • Sửa quyền: sudo chmod 755 {filePath}\n      • Hoặc chạy nport với sudo: sudo nport [...args]',
  },

  es: {
    header: 'N P O R T ⚡️ Gratis y código abierto desde Vietnam ❤️',
    creatingTunnel: 'Creando túnel para el puerto {port}...',
    checkingUpdates: 'Buscando actualizaciones...',
    tunnelLive: '🚀 ¡ESTAMOS EN VIVO!',
    connection1: '   ✔ [1/2] Conexión establecida...',
    connection2: '   ✔ [2/2] Compresión activada...',
    timeRemaining: '⏱️  Tiempo:     {hours}h restantes',
    footerTitle: '🔥 ¿MANTENER LA VIBRA VIVA?',
    footerSubtitle: '(Hecho con ❤️ en Vietnam)',
    dropStar: '⭐️  Déjanos una Estrella:   ',
    sendCoffee: '☕️  Invítanos un Café:    ',
    newVersion: '🚨 ¡NUEVA VERSIÓN (v{version}) detectada!',
    updateCommand: '> npm install -g nport@latest',
    tunnelShutdown: '🛑 TÚNEL APAGADO.',
    cleaningUp: 'Limpiando...',
    cleanupDone: 'Listo.',
    cleanupFailed: 'Falló.',
    subdomainReleased: 'Subdominio...   Liberado. 🗑️',
    serverBusy: '(El servidor podría estar caído o ocupado)',
    goodbyeTitle: '👋 ANTES DE IRTE...',
    goodbyeMessage: '¡Gracias por usar NPort!',
    website: '🌐 Sitio web:     ',
    author: '👤 Autor:      ',
    changeLanguage: '🌍 Idioma:    ',
    changeLanguageHint: 'nport --language',
    versionTitle: 'NPort v{version}',
    versionSubtitle: 'Alternativa gratuita y de código abierto a ngrok',
    versionLatest: '✔ ¡Estás usando la última versión!',
    versionAvailable: '🚨 Nueva versión disponible: v{version}',
    versionUpdate: 'Actualiza ahora: ',
    learnMore: 'Más información: ',
    languagePrompt: '\n🌍 Selección de idioma / Language Selection / Chọn ngôn ngữ\n',
    languageQuestion: 'Elige tu idioma (1-3): ',
    languageEnglish: '1. English (Inglés)',
    languageVietnamese: '2. Tiếng Việt (Vietnamita)',
    languageSpanish: '3. Español',
    languageInvalid: 'Opción inválida. Usando inglés por defecto.',
    languageSaved: '✔ ¡Preferencia de idioma guardada!',
    networkIssueTitle: '\n⚠️  PROBLEMA DE CONECTIVIDAD DE RED DETECTADO',
    networkIssueDesc: '   Cloudflared está teniendo problemas para mantener una conexión estable con los servidores edge de Cloudflare.',
    networkIssueTunnel: '   📡 Tu túnel sigue funcionando, pero la calidad de la conexión puede verse afectada.',
    networkIssueReasons: '\n   💡 Posibles razones:',
    networkIssueReason1: '      • Conexión a internet inestable o alta pérdida de paquetes',
    networkIssueReason2: '      • Firewall/Router bloqueando tráfico UDP (protocolo QUIC)',
    networkIssueReason3: '      • Limitación del ISP o congestión de red',
    networkIssueFix: '\n   🔧 Qué puedes intentar:',
    networkIssueFix1: '      • Verifica la estabilidad de tu conexión a internet',
    networkIssueFix2: '      • Prueba conectarte desde otra red',
    networkIssueFix3: '      • Desactiva la VPN/Proxy si estás usando una',
    networkIssueFix4: '      • El túnel cambiará automáticamente a HTTP/2 si QUIC falla',
    networkIssueIgnore: '\n   ℹ️  Esto generalmente no es crítico: tu túnel debería seguir funcionando con normalidad.\n',
    binaryChmodFailed: '⚠️  No se pudieron establecer permisos de ejecución en {filePath} (permiso denegado).\n   Esto suele ocurrir cuando nport se instaló con sudo.\n   El binario debería seguir funcionando. Si tienes problemas, prueba una de estas opciones:\n      • Corregir permisos: sudo chmod 755 {filePath}\n      • O ejecutar nport con sudo: sudo nport [...args]',
  }
};

/**
 * Language Manager
 */
class LanguageManager {
  private currentLanguage: LanguageCode = 'en';
  private readonly availableLanguages: readonly string[] = AVAILABLE_LANGUAGES;

  /**
   * Gets a translated string with variable substitution.
   */
  t(key: keyof TranslationKeys, vars: TranslationVariables = {}): string {
    const translations = TRANSLATIONS[this.currentLanguage] || TRANSLATIONS.en;
    let text: string = translations[key] || TRANSLATIONS.en[key] || key;
    
    Object.keys(vars).forEach(varKey => {
      const value = vars[varKey];
      if (value !== undefined) {
        text = text.replace(`{${varKey}}`, String(value));
      }
    });
    
    return text;
  }

  /**
   * Loads saved language preference.
   */
  private loadLanguagePreference(): LanguageCode | null {
    const lang = configManager.getLanguage();
    if (lang && this.availableLanguages.includes(lang)) {
      return lang as LanguageCode;
    }
    return null;
  }

  /**
   * Saves language preference.
   */
  private saveLanguagePreference(lang: LanguageCode): void {
    configManager.setLanguage(lang);
  }

  /**
   * Sets the current language.
   */
  setLanguage(lang: string): boolean {
    if (this.availableLanguages.includes(lang)) {
      this.currentLanguage = lang as LanguageCode;
      return true;
    }
    return false;
  }

  /**
   * Gets the current language code.
   */
  getLanguage(): LanguageCode {
    return this.currentLanguage;
  }

  /**
   * Prompts user to select a language.
   */
  async promptLanguageSelection(): Promise<LanguageCode> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(this.t('languagePrompt'));
      console.log(`   ${this.t('languageEnglish')}`);
      console.log(`   ${this.t('languageVietnamese')}`);
      console.log(`   ${this.t('languageSpanish')}\n`);

      rl.question(`${this.t('languageQuestion')}`, (answer) => {
        rl.close();
        
        const choice = answer.trim();
        let selectedLang: LanguageCode = 'en';
        
        if (choice === '1') {
          selectedLang = 'en';
        } else if (choice === '2') {
          selectedLang = 'vi';
        } else if (choice === '3') {
          selectedLang = 'es';
        } else {
          console.log(`\n${this.t('languageInvalid')}\n`);
        }
        
        this.setLanguage(selectedLang);
        this.saveLanguagePreference(selectedLang);
        console.log(`${this.t('languageSaved')}\n`);
        
        resolve(selectedLang);
      });
    });
  }

  /**
   * Initializes the language system.
   */
  async initialize(cliLanguage: string | null = null): Promise<LanguageCode> {
    if (cliLanguage && cliLanguage !== 'prompt' && this.setLanguage(cliLanguage)) {
      this.saveLanguagePreference(cliLanguage as LanguageCode);
      return cliLanguage as LanguageCode;
    }

    if (cliLanguage === 'prompt') {
      return await this.promptLanguageSelection();
    }

    const savedLang = this.loadLanguagePreference();
    if (savedLang) {
      this.setLanguage(savedLang);
      return savedLang;
    }

    return await this.promptLanguageSelection();
  }
}

export const lang = new LanguageManager();