/**
 * NPort - Shared Types
 * 
 * Central export for all type definitions used across the application.
 */

// Tunnel types
export type {
  TunnelConfig,
  TunnelResponse,
  ApiResponse,
  CreateTunnelApiResponse,
  TunnelState,
  ShutdownReason,
  TunnelEvent,
} from './tunnel.js';

// Config types
export type {
  ParsedArguments,
  UserConfig,
  AppConfig,
  PlatformConfig,
  PathsConfig,
  LogPatterns,
  NetworkConfig,
} from './config.js';

// Analytics types
export type {
  AnalyticsEvent,
  CliStartEventParams,
  TunnelCreatedEventParams,
  TunnelErrorEventParams,
  TunnelShutdownEventParams,
  UpdateAvailableEventParams,
  SystemInfo,
  GA4Payload,
} from './analytics.js';

// Version types
export type {
  UpdateCheckResult,
  NpmPackageInfo,
} from './version.js';

// i18n types
export type {
  LanguageCode,
  TranslationKeys,
  Translations,
  TranslationVariables,
} from './i18n.js';
