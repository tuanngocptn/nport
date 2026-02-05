// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Environment variables required by the worker
 */
interface Env {
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_DOMAIN: string;
  CF_API_TOKEN?: string;
  CF_EMAIL?: string;
  CF_API_KEY?: string;
  TUNNEL_MAX_AGE_HOURS?: string;
}

/**
 * Cloudflare API response structure
 */
interface CloudflareApiResponse<T = unknown> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

/**
 * DNS record from Cloudflare API
 */
interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

/**
 * Tunnel from Cloudflare API
 */
interface Tunnel {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'inactive';
  token?: string;
  created_at?: string;
}

/**
 * Created tunnel response
 */
interface CreatedTunnel {
  id: string;
  token: string;
  cnameTarget: string;
}

/**
 * Request body for creating a tunnel
 */
interface CreateTunnelBody {
  subdomain?: string;
}

/**
 * Request body for deleting a tunnel
 */
interface DeleteTunnelBody {
  subdomain?: string;
  tunnelId?: string;
}

/**
 * API response structure
 */
interface ApiResponse {
  success: boolean;
  error?: string;
  tunnelId?: string;
  tunnelToken?: string;
  url?: string;
}

// ============================================================================
// Configuration & Constants
// ============================================================================

/** Required environment variables */
const REQUIRED_ENV_VARS: (keyof Env)[] = ['CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_DOMAIN'];

/** Empty array means no prefix filtering - all tunnels will be cleaned up */
const CLEANUP_PREFIXES: string[] = [];

/** Protected subdomains that cannot be created or cleaned up */
const PROTECTED_SUBDOMAINS: string[] = ['api'];

/** Default maximum age for healthy tunnels before cleanup (in hours) */
const DEFAULT_TUNNEL_MAX_AGE_HOURS = 4;

/** Cloudflare API base URL */
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** HTTP redirect status codes */
const HTTP_REDIRECT_URL = 'https://nport.link';

// ============================================================================
// Cloudflare API Client
// ============================================================================

/**
 * Makes authenticated requests to Cloudflare API
 * @param url - The API endpoint URL
 * @param method - HTTP method (GET, POST, DELETE)
 * @param body - Request body (will be JSON stringified)
 * @param env - Environment variables containing CF credentials
 * @returns Parsed JSON response
 * @throws Error if request fails or response indicates error
 */
async function callCloudflareAPI<T>(
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body: object | null,
  env: Env
): Promise<CloudflareApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Prefer API Token (recommended by Cloudflare), fallback to API Key
  if (env.CF_API_TOKEN) {
    headers['Authorization'] = `Bearer ${env.CF_API_TOKEN}`;
  } else if (env.CF_EMAIL && env.CF_API_KEY) {
    headers['X-Auth-Email'] = env.CF_EMAIL;
    headers['X-Auth-Key'] = env.CF_API_KEY;
  } else {
    throw new Error('Missing authentication: Need either CF_API_TOKEN or (CF_EMAIL + CF_API_KEY)');
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const responseText = await response.text();
  let responseJson: CloudflareApiResponse<T>;

  try {
    responseJson = JSON.parse(responseText) as CloudflareApiResponse<T>;
  } catch {
    throw new Error(`Non-JSON response: ${responseText}`);
  }

  if (!response.ok || !responseJson.success) {
    const errorDetails = responseJson.errors
      ? responseJson.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')
      : responseText;
    throw new Error(`CF API Error: ${errorDetails}`);
  }

  return responseJson;
}

// ============================================================================
// DNS Operations
// ============================================================================

/**
 * Finds any DNS record (A, AAAA, or CNAME) by full domain name
 * @param fullDnsName - Complete domain name (e.g., "test.nport.link")
 * @param env - Environment variables
 * @returns DNS record object or null if not found
 */
async function findDnsRecord(fullDnsName: string, env: Env): Promise<DnsRecord | null> {
  const url = `${CF_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?name=${fullDnsName}`;
  const response = await callCloudflareAPI<DnsRecord[]>(url, 'GET', null, env);
  return response.result.find((r) => r.name === fullDnsName) || null;
}

/**
 * Creates a DNS CNAME record
 * @param fullDnsName - Complete domain name
 * @param target - CNAME target (e.g., "{tunnelId}.cfargotunnel.com")
 * @param env - Environment variables
 * @returns Created DNS record or null if duplicate
 */
async function createDnsRecord(
  fullDnsName: string,
  target: string,
  env: Env
): Promise<CloudflareApiResponse<DnsRecord> | null> {
  const url = `${CF_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`;
  const payload = {
    type: 'CNAME',
    name: fullDnsName,
    content: target,
    proxied: true,
    ttl: 1,
  };

  try {
    return await callCloudflareAPI<DnsRecord>(url, 'POST', payload, env);
  } catch (error) {
    // Ignore duplicate record errors
    const errorString = JSON.stringify(error);
    const errorMessage = error instanceof Error ? error.message : '';
    if (
      errorString.includes('already exists') ||
      errorString.includes('81053') ||
      errorMessage.includes('already exists')
    ) {
      console.log(`[DNS] Record already exists: ${fullDnsName}`);
      return null;
    }
    throw error;
  }
}

/**
 * Deletes a DNS record by full domain name
 * @param fullDnsName - Complete domain name
 * @param env - Environment variables
 * @returns True if deleted, false if not found
 */
async function deleteDnsRecord(fullDnsName: string, env: Env): Promise<boolean> {
  const record = await findDnsRecord(fullDnsName, env);

  if (!record) {
    console.log(`[DNS] Record not found: ${fullDnsName}`);
    return false;
  }

  const url = `${CF_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`;
  await callCloudflareAPI<void>(url, 'DELETE', null, env);
  console.log(`[DNS] Deleted record: ${record.id} (${record.name})`);
  return true;
}

// ============================================================================
// Tunnel Operations
// ============================================================================

/**
 * Creates a new Cloudflare Tunnel
 * @param name - Tunnel name (typically the subdomain)
 * @param env - Environment variables
 * @returns Tunnel data with id, token, and CNAME target
 */
async function createTunnel(name: string, env: Env): Promise<CreatedTunnel> {
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/tunnels`;
  const payload = { name, config_src: 'cloudflare' };

  const response = await callCloudflareAPI<Tunnel>(url, 'POST', payload, env);
  const { id, token } = response.result;

  if (!token) {
    throw new Error('Tunnel created but no token returned');
  }

  return {
    id,
    token,
    cnameTarget: `${id}.cfargotunnel.com`,
  };
}

/**
 * Deletes a Cloudflare Tunnel by ID
 * @param tunnelId - The tunnel ID to delete
 * @param env - Environment variables
 */
async function deleteTunnel(tunnelId: string, env: Env): Promise<void> {
  if (!tunnelId) {
    console.log('[Tunnel] No tunnel ID provided, skipping deletion');
    return;
  }

  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/tunnels/${tunnelId}`;
  await callCloudflareAPI<void>(url, 'DELETE', null, env);
  console.log(`[Tunnel] Deleted: ${tunnelId}`);
}

/**
 * Lists all tunnels with given name
 * @param name - Tunnel name to search for
 * @param env - Environment variables
 * @returns List of tunnel objects with that name
 */
async function findTunnelByName(name: string, env: Env): Promise<Tunnel[]> {
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/tunnels?name=${name}&is_deleted=false`;
  const response = await callCloudflareAPI<Tunnel[]>(url, 'GET', null, env);
  return response.result;
}

/**
 * Lists all tunnels with given status
 * @param status - Tunnel status filter (e.g., 'down')
 * @param env - Environment variables
 * @returns List of tunnel objects
 */
async function listTunnels(status: Tunnel['status'], env: Env): Promise<Tunnel[]> {
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/tunnels?is_deleted=false&status=${status}`;
  const response = await callCloudflareAPI<Tunnel[]>(url, 'GET', null, env);
  return response.result;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validates that all required environment variables are present
 * @param env - Environment variables
 * @returns Error message if validation fails, null otherwise
 */
function validateEnvironment(env: Env): string | null {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);

  if (missing.length > 0) {
    return `Missing Secrets: ${missing.join(', ')}`;
  }

  // Check authentication credentials
  const hasApiToken = !!env.CF_API_TOKEN;
  const hasApiKey = !!(env.CF_EMAIL && env.CF_API_KEY);

  if (!hasApiToken && !hasApiKey) {
    return `Missing Authentication: Need either CF_API_TOKEN or (CF_EMAIL + CF_API_KEY)`;
  }

  return null;
}

/**
 * Constructs full DNS name from subdomain and base domain
 * @param subdomain - The subdomain part
 * @param baseDomain - The base domain (from CF_DOMAIN)
 * @returns Full domain name (e.g., "test.nport.link")
 */
function buildFullDnsName(subdomain: string, baseDomain: string): string {
  return `${subdomain}.${baseDomain}`;
}

/**
 * Checks if a tunnel name should be cleaned up
 * @param tunnelName - The tunnel name to check
 * @returns True if tunnel should be cleaned up
 */
function shouldCleanupTunnel(tunnelName: string): boolean {
  // Never clean up protected subdomains
  if (PROTECTED_SUBDOMAINS.includes(tunnelName)) {
    return false;
  }

  // If CLEANUP_PREFIXES is empty, clean up all tunnels (except protected ones)
  if (CLEANUP_PREFIXES.length === 0) {
    return true;
  }
  // Otherwise, only clean up tunnels matching specific prefixes
  return CLEANUP_PREFIXES.some((prefix) => tunnelName.startsWith(prefix));
}

/**
 * Creates standardized JSON response
 * @param data - Response data
 * @param status - HTTP status code
 * @returns Cloudflare Worker Response object
 */
function jsonResponse(data: ApiResponse, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Handles POST requests to create a new tunnel
 * @param body - Request body with optional subdomain
 * @param env - Environment variables
 * @returns JSON response with tunnel details
 */
async function handleCreateTunnel(body: CreateTunnelBody, env: Env): Promise<Response> {
  const subdomain = body.subdomain || `tun-${Date.now()}`;
  const fullDnsName = buildFullDnsName(subdomain, env.CF_DOMAIN);

  console.log(`[Worker] Creating tunnel: ${subdomain}`);

  // Step 0: Check if subdomain is protected
  if (PROTECTED_SUBDOMAINS.includes(subdomain)) {
    console.log(`[Worker] Cannot create tunnel: ${subdomain} is a protected subdomain`);
    throw new Error(
      `SUBDOMAIN_PROTECTED: Subdomain "${subdomain}" is reserved and cannot be used. Record already exists.`
    );
  }

  // Step 1: Check if tunnel with this name already exists
  try {
    const existingTunnels = await findTunnelByName(subdomain, env);

    if (existingTunnels && existingTunnels.length > 0) {
      const existingTunnel = existingTunnels[0];
      console.log(`[Worker] Found existing tunnel: ${existingTunnel.id} (status: ${existingTunnel.status})`);

      // Check if tunnel is inactive (down, degraded, or not healthy)
      const isInactive =
        existingTunnel.status === 'down' ||
        existingTunnel.status === 'degraded' ||
        existingTunnel.status === 'inactive';

      if (isInactive) {
        console.log(`[Worker] Tunnel is inactive (${existingTunnel.status}), cleaning up...`);

        // Clean up old DNS record
        await deleteDnsRecord(fullDnsName, env);

        // Delete old tunnel
        await deleteTunnel(existingTunnel.id, env);

        console.log(`[Worker] Cleanup complete, proceeding with new tunnel creation`);
      } else {
        // Tunnel is active - this is a real conflict
        console.log(`[Worker] Tunnel is active (${existingTunnel.status}), cannot create duplicate`);
        throw new Error(`SUBDOMAIN_IN_USE: Subdomain "${subdomain}" is currently in use by an active tunnel.`);
      }
    }
  } catch (error) {
    // If it's our custom error about active tunnel, rethrow it
    if (error instanceof Error && error.message.includes('SUBDOMAIN_IN_USE:')) {
      throw error;
    }
    // Otherwise, log and continue (tunnel lookup failed, but we can try to create anyway)
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`[Worker] Warning: Could not check for existing tunnel: ${errorMessage}`);
  }

  // Step 1.5: Check for orphaned DNS records (records without tunnels)
  try {
    const existingDnsRecord = await findDnsRecord(fullDnsName, env);
    if (existingDnsRecord) {
      console.log(`[Worker] Found orphaned DNS record: ${existingDnsRecord.id} (type: ${existingDnsRecord.type})`);
      console.log(`[Worker] Cleaning up orphaned DNS record...`);
      await deleteDnsRecord(fullDnsName, env);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`[Worker] Warning: Could not check for existing DNS record: ${errorMessage}`);
  }

  // Step 2: Create the tunnel
  const tunnel = await createTunnel(subdomain, env);

  // Step 3: Create DNS record
  console.log(`[Worker] Creating DNS: ${fullDnsName} -> ${tunnel.cnameTarget}`);
  await createDnsRecord(fullDnsName, tunnel.cnameTarget, env);

  return jsonResponse({
    success: true,
    tunnelId: tunnel.id,
    tunnelToken: tunnel.token,
    url: `https://${fullDnsName}`,
  });
}

/**
 * Handles DELETE requests to remove an existing tunnel
 * @param body - Request body with subdomain and tunnelId
 * @param env - Environment variables
 * @returns JSON response confirming deletion
 */
async function handleDeleteTunnel(body: DeleteTunnelBody, env: Env): Promise<Response> {
  const { subdomain, tunnelId } = body;
  const fullDnsName = buildFullDnsName(subdomain || `tun-${Date.now()}`, env.CF_DOMAIN);

  console.log(`[Worker] Deleting: ${fullDnsName} (Tunnel: ${tunnelId})`);

  // Step 1: Delete DNS record
  await deleteDnsRecord(fullDnsName, env);

  // Step 2: Delete tunnel
  if (tunnelId) {
    await deleteTunnel(tunnelId, env);
  }

  return jsonResponse({ success: true });
}

/**
 * Gets the tunnel max age in milliseconds from environment or default
 * @param env - Environment variables
 * @returns Max age in milliseconds
 */
function getTunnelMaxAgeMs(env: Env): number {
  const hours = env.TUNNEL_MAX_AGE_HOURS
    ? parseFloat(env.TUNNEL_MAX_AGE_HOURS)
    : DEFAULT_TUNNEL_MAX_AGE_HOURS;

  // Validate parsed value, fallback to default if invalid
  const validHours = isNaN(hours) || hours <= 0 ? DEFAULT_TUNNEL_MAX_AGE_HOURS : hours;

  return validHours * 60 * 60 * 1000;
}

/**
 * Checks if a tunnel has exceeded the maximum age for healthy tunnels
 * @param tunnel - The tunnel to check
 * @param maxAgeMs - Maximum age in milliseconds
 * @returns True if tunnel is older than maxAgeMs
 */
function isTunnelExpired(tunnel: Tunnel, maxAgeMs: number): boolean {
  if (!tunnel.created_at) {
    return false;
  }

  const createdAt = new Date(tunnel.created_at).getTime();
  const now = Date.now();
  const age = now - createdAt;

  return age > maxAgeMs;
}

/**
 * Handles the scheduled cleanup job
 * @param env - Environment variables
 */
async function handleScheduledCleanup(env: Env): Promise<void> {
  const maxAgeMs = getTunnelMaxAgeMs(env);
  const maxAgeHours = maxAgeMs / (60 * 60 * 1000);
  console.log(`[Cron] Starting cleanup job... (max tunnel age: ${maxAgeHours} hours)`);

  try {
    // Fetch tunnels by status
    const downTunnels = await listTunnels('down', env);
    const inactiveTunnels = await listTunnels('inactive', env);
    const degradedTunnels = await listTunnels('degraded', env);
    const healthyTunnels = await listTunnels('healthy', env);

    // Dead tunnels are always cleaned up
    const deadTunnels = [...downTunnels, ...inactiveTunnels, ...degradedTunnels];
    console.log(`[Cron] Found ${deadTunnels.length} dead tunnels`);

    // Healthy tunnels older than configured max age should also be cleaned up
    const expiredHealthyTunnels = healthyTunnels.filter((tunnel) => isTunnelExpired(tunnel, maxAgeMs));
    console.log(`[Cron] Found ${expiredHealthyTunnels.length} expired healthy tunnels (older than ${maxAgeHours} hours)`);

    const tunnelsToCleanup = [...deadTunnels, ...expiredHealthyTunnels];

    for (const tunnel of tunnelsToCleanup) {
      // Check if tunnel should be cleaned up (based on CLEANUP_PREFIXES config)
      if (!shouldCleanupTunnel(tunnel.name)) {
        console.log(`[Cron] Skipping: ${tunnel.name} (doesn't match cleanup criteria)`);
        continue;
      }

      const ageInfo = tunnel.created_at
        ? ` (age: ${Math.round((Date.now() - new Date(tunnel.created_at).getTime()) / 1000 / 60)} min)`
        : '';
      console.log(`[Cron] Cleaning up: ${tunnel.name} (${tunnel.id}) [${tunnel.status}]${ageInfo}`);

      const fullDnsName = buildFullDnsName(tunnel.name, env.CF_DOMAIN);

      // Delete DNS record
      await deleteDnsRecord(fullDnsName, env);

      // Delete tunnel
      await deleteTunnel(tunnel.id, env);

      console.log(`[Cron] ✓ Cleanup complete for ${tunnel.name}`);
    }

    console.log('[Cron] Cleanup job finished');
  } catch (err) {
    console.error('[Cron Error]', err);
  }
}

// ============================================================================
// Worker Entry Points
// ============================================================================

export default {
  /**
   * Handles HTTP requests to create/delete tunnels
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Validate environment
    const envError = validateEnvironment(env);
    if (envError) {
      return jsonResponse({ success: false, error: envError }, 400);
    }

    // Handle GET requests - redirect to landing page
    if (request.method === 'GET') {
      return Response.redirect(HTTP_REDIRECT_URL, 301);
    }

    // Only accept POST and DELETE for API operations
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const body = (await request.json()) as CreateTunnelBody | DeleteTunnelBody;

      if (request.method === 'POST') {
        return await handleCreateTunnel(body as CreateTunnelBody, env);
      } else {
        return await handleDeleteTunnel(body as DeleteTunnelBody, env);
      }
    } catch (err) {
      console.error('[Worker Error]', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return jsonResponse({ success: false, error: errorMessage }, 500);
    }
  },

  /**
   * Scheduled job to clean up inactive tunnels
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduledCleanup(env);
  },
} satisfies ExportedHandler<Env>;

// Export types and utilities for testing
export type { Tunnel, Env };
export { getTunnelMaxAgeMs, isTunnelExpired, DEFAULT_TUNNEL_MAX_AGE_HOURS };
