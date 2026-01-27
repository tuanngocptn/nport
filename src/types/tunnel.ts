/**
 * Tunnel-related type definitions
 * 
 * These types define the data structures used for tunnel creation,
 * management, and communication between CLI and backend.
 */

/**
 * Configuration for creating a new tunnel
 */
export interface TunnelConfig {
  /** Local port to tunnel (e.g., 3000) */
  port: number;
  /** Subdomain to use (e.g., "myapp" for myapp.nport.link) */
  subdomain: string;
  /** Custom backend URL or null for default */
  backendUrl: string | null;
  /** Language code or null for default */
  language: string | null;
}

/**
 * Response from the backend after creating a tunnel
 */
export interface TunnelResponse {
  /** UUID of the created tunnel */
  tunnelId: string;
  /** Base64-encoded token for cloudflared authentication */
  tunnelToken: string;
  /** Full HTTPS URL of the tunnel (e.g., "https://myapp.nport.link") */
  url: string;
}

/**
 * Backend API response wrapper
 */
export interface ApiResponse<T = unknown> {
  /** Whether the request was successful */
  success: boolean;
  /** Error message if success is false */
  error?: string;
  /** Response data if success is true */
  data?: T;
}

/**
 * Create tunnel API response
 */
export interface CreateTunnelApiResponse extends ApiResponse {
  tunnelId?: string;
  tunnelToken?: string;
  url?: string;
}

/**
 * Tunnel state information
 */
export interface TunnelState {
  /** UUID of the current tunnel */
  tunnelId: string | null;
  /** Current subdomain */
  subdomain: string | null;
  /** Local port being tunneled */
  port: number | null;
  /** Custom backend URL */
  backendUrl: string | null;
  /** Number of established connections */
  connectionCount: number;
  /** Timestamp when tunnel was created */
  startTime: number | null;
}

/**
 * Shutdown reason types
 */
export type ShutdownReason = 'manual' | 'timeout' | 'error';

/**
 * Tunnel lifecycle events
 */
export type TunnelEvent = 
  | 'created'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'shutdown';
