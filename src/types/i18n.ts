/**
 * Internationalization type definitions
 */

/**
 * Supported language codes
 */
export type LanguageCode = 'en' | 'vi';

/**
 * Translation keys used in the application
 */
export interface TranslationKeys {
  // Header
  header: string;
  
  // Spinners
  creatingTunnel: string;
  checkingUpdates: string;
  
  // Success messages
  tunnelLive: string;
  connection1: string;
  connection2: string;
  timeRemaining: string;
  
  // Footer
  footerTitle: string;
  footerSubtitle: string;
  dropStar: string;
  sendCoffee: string;
  newVersion: string;
  updateCommand: string;
  
  // Cleanup
  tunnelShutdown: string;
  cleaningUp: string;
  cleanupDone: string;
  cleanupFailed: string;
  subdomainReleased: string;
  serverBusy: string;
  
  // Goodbye
  goodbyeTitle: string;
  goodbyeMessage: string;
  website: string;
  author: string;
  changeLanguage: string;
  changeLanguageHint: string;
  
  // Version
  versionTitle: string;
  versionSubtitle: string;
  versionLatest: string;
  versionAvailable: string;
  versionUpdate: string;
  learnMore: string;
  
  // Language selection
  languagePrompt: string;
  languageQuestion: string;
  languageEnglish: string;
  languageVietnamese: string;
  languageInvalid: string;
  languageSaved: string;
  
  // Network warnings
  networkIssueTitle: string;
  networkIssueDesc: string;
  networkIssueTunnel: string;
  networkIssueReasons: string;
  networkIssueReason1: string;
  networkIssueReason2: string;
  networkIssueReason3: string;
  networkIssueFix: string;
  networkIssueFix1: string;
  networkIssueFix2: string;
  networkIssueFix3: string;
  networkIssueFix4: string;
  networkIssueIgnore: string;
}

/**
 * Translation dictionary for all languages
 */
export type Translations = Record<LanguageCode, TranslationKeys>;

/**
 * Variables that can be substituted in translation strings
 */
export interface TranslationVariables {
  port?: number;
  hours?: number;
  version?: string;
  [key: string]: string | number | undefined;
}
