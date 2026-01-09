// ============================================================================
// Configuration & Constants
// ============================================================================

const REQUIRED_ENV_VARS = ['CF_EMAIL', 'CF_API_KEY', 'CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_DOMAIN'];

// Note: Empty array means no prefix filtering - all tunnels will be cleaned up
const CLEANUP_PREFIXES = [];

// ============================================================================
// Cloudflare API Client
// ============================================================================

/**
 * Makes authenticated requests to Cloudflare API
 * @param {string} url - The API endpoint URL
 * @param {string} method - HTTP method (GET, POST, DELETE)
 * @param {object|null} body - Request body (will be JSON stringified)
 * @param {object} env - Environment variables containing CF credentials
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} If request fails or response indicates error
 */
async function callCloudflareAPI(url, method, body, env) {
	const headers = {
		'Content-Type': 'application/json',
		'X-Auth-Email': env.CF_EMAIL,
		'X-Auth-Key': env.CF_API_KEY,
	};

	const response = await fetch(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : null,
	});

	const responseText = await response.text();
	let responseJson;

	try {
		responseJson = JSON.parse(responseText);
	} catch (e) {
		throw new Error(`Non-JSON response: ${responseText}`);
	}

	if (!response.ok || !responseJson.success) {
		const errorDetails = responseJson.errors ? responseJson.errors.map((e) => `[${e.code}] ${e.message}`).join('; ') : responseText;
		throw new Error(`CF API Error: ${errorDetails}`);
	}

	return responseJson;
}

// ============================================================================
// DNS Operations
// ============================================================================

/**
 * Finds a DNS CNAME record by full domain name
 * @param {string} fullDnsName - Complete domain name (e.g., "test.nport.link")
 * @param {object} env - Environment variables
 * @returns {Promise<object|null>} DNS record object or null if not found
 */
async function findDnsRecord(fullDnsName, env) {
	const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?type=CNAME&name=${fullDnsName}`;
	const response = await callCloudflareAPI(url, 'GET', null, env);
	return response.result.find((r) => r.name === fullDnsName) || null;
}

/**
 * Creates a DNS CNAME record
 * @param {string} fullDnsName - Complete domain name
 * @param {string} target - CNAME target (e.g., "{tunnelId}.cfargotunnel.com")
 * @param {object} env - Environment variables
 * @returns {Promise<object>} Created DNS record
 */
async function createDnsRecord(fullDnsName, target, env) {
	const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;
	const payload = {
		type: 'CNAME',
		name: fullDnsName,
		content: target,
		proxied: true,
		ttl: 1,
	};

	try {
		return await callCloudflareAPI(url, 'POST', payload, env);
	} catch (error) {
		// Ignore duplicate record errors
		if (JSON.stringify(error).includes('already exists')) {
			console.log(`[DNS] Record already exists: ${fullDnsName}`);
			return null;
		}
		throw error;
	}
}

/**
 * Deletes a DNS record by full domain name
 * @param {string} fullDnsName - Complete domain name
 * @param {object} env - Environment variables
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
async function deleteDnsRecord(fullDnsName, env) {
	const record = await findDnsRecord(fullDnsName, env);

	if (!record) {
		console.log(`[DNS] Record not found: ${fullDnsName}`);
		return false;
	}

	const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`;
	await callCloudflareAPI(url, 'DELETE', null, env);
	console.log(`[DNS] Deleted record: ${record.id} (${record.name})`);
	return true;
}

// ============================================================================
// Tunnel Operations
// ============================================================================

/**
 * Creates a new Cloudflare Tunnel
 * @param {string} name - Tunnel name (typically the subdomain)
 * @param {object} env - Environment variables
 * @returns {Promise<object>} Tunnel data with id, token, and CNAME target
 */
async function createTunnel(name, env) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels`;
	const payload = { name, config_src: 'cloudflare' };

	const response = await callCloudflareAPI(url, 'POST', payload, env);
	const { id, token } = response.result;

	return {
		id,
		token,
		cnameTarget: `${id}.cfargotunnel.com`,
	};
}

/**
 * Deletes a Cloudflare Tunnel by ID
 * @param {string} tunnelId - The tunnel ID to delete
 * @param {object} env - Environment variables
 * @returns {Promise<void>}
 */
async function deleteTunnel(tunnelId, env) {
	if (!tunnelId) {
		console.log('[Tunnel] No tunnel ID provided, skipping deletion');
		return;
	}

	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels/${tunnelId}`;
	await callCloudflareAPI(url, 'DELETE', null, env);
	console.log(`[Tunnel] Deleted: ${tunnelId}`);
}

/**
 * Lists all tunnels with given name
 * @param {string} name - Tunnel name to search for
 * @param {object} env - Environment variables
 * @returns {Promise<Array>} List of tunnel objects with that name
 */
async function findTunnelByName(name, env) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels?name=${name}&is_deleted=false`;
	const response = await callCloudflareAPI(url, 'GET', null, env);
	return response.result;
}

/**
 * Lists all tunnels with given status
 * @param {string} status - Tunnel status filter (e.g., 'down')
 * @param {object} env - Environment variables
 * @returns {Promise<Array>} List of tunnel objects
 */
async function listTunnels(status, env) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels?is_deleted=false&status=${status}`;
	const response = await callCloudflareAPI(url, 'GET', null, env);
	return response.result;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validates that all required environment variables are present
 * @param {object} env - Environment variables
 * @returns {string|null} Error message if validation fails, null otherwise
 */
function validateEnvironment(env) {
	const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);

	if (missing.length > 0) {
		return `Missing Secrets: ${missing.join(', ')}`;
	}

	return null;
}

/**
 * Constructs full DNS name from subdomain and base domain
 * @param {string} subdomain - The subdomain part
 * @param {string} baseDomain - The base domain (from CF_DOMAIN)
 * @returns {string} Full domain name (e.g., "test.nport.link")
 */
function buildFullDnsName(subdomain, baseDomain) {
	return `${subdomain}.${baseDomain}`;
}

/**
 * Checks if a tunnel name should be cleaned up
 * @param {string} tunnelName - The tunnel name to check
 * @returns {boolean} True if tunnel should be cleaned up
 */
function shouldCleanupTunnel(tunnelName) {
	// If CLEANUP_PREFIXES is empty, clean up all tunnels
	if (CLEANUP_PREFIXES.length === 0) {
		return true;
	}
	// Otherwise, only clean up tunnels matching specific prefixes
	return CLEANUP_PREFIXES.some((prefix) => tunnelName.startsWith(prefix));
}

/**
 * Creates standardized JSON response
 * @param {object} data - Response data
 * @param {number} status - HTTP status code
 * @returns {Response} Cloudflare Worker Response object
 */
function jsonResponse(data, status = 200) {
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
 * @param {object} body - Request body with optional subdomain
 * @param {object} env - Environment variables
 * @returns {Promise<Response>} JSON response with tunnel details
 */
async function handleCreateTunnel(body, env) {
	const subdomain = body.subdomain || `tun-${Date.now()}`;
	const fullDnsName = buildFullDnsName(subdomain, env.CF_DOMAIN);

	console.log(`[Worker] Creating tunnel: ${subdomain}`);

	// Step 1: Check if tunnel with this name already exists
	try {
		const existingTunnels = await findTunnelByName(subdomain, env);

		if (existingTunnels && existingTunnels.length > 0) {
			const existingTunnel = existingTunnels[0];
			console.log(`[Worker] Found existing tunnel: ${existingTunnel.id} (status: ${existingTunnel.status})`);

			// Check if tunnel is inactive (down, degraded, or not healthy)
			const isInactive = existingTunnel.status === 'down' || existingTunnel.status === 'degraded' || existingTunnel.status === 'inactive';

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
				throw new Error(
					`SUBDOMAIN_IN_USE: Subdomain "${subdomain}" is currently in use by an active tunnel.`
				);
			}
		}
	} catch (error) {
		// If it's our custom error about active tunnel, rethrow it
		if (error.message.includes('SUBDOMAIN_IN_USE:')) {
			throw error;
		}
		// Otherwise, log and continue (tunnel lookup failed, but we can try to create anyway)
		console.log(`[Worker] Warning: Could not check for existing tunnel: ${error.message}`);
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
 * @param {object} body - Request body with subdomain and tunnelId
 * @param {object} env - Environment variables
 * @returns {Promise<Response>} JSON response confirming deletion
 */
async function handleDeleteTunnel(body, env) {
	const { subdomain, tunnelId } = body;
	const fullDnsName = buildFullDnsName(subdomain || `tun-${Date.now()}`, env.CF_DOMAIN);

	console.log(`[Worker] Deleting: ${fullDnsName} (Tunnel: ${tunnelId})`);

	// Step 1: Delete DNS record
	await deleteDnsRecord(fullDnsName, env);

	// Step 2: Delete tunnel
	await deleteTunnel(tunnelId, env);

	return jsonResponse({ success: true });
}

// ============================================================================
// Worker Entry Points
// ============================================================================

export default {
	/**
	 * Handles HTTP requests to create/delete tunnels
	 */
	async fetch(request, env) {
		// Validate environment
		const envError = validateEnvironment(env);
		if (envError) {
			return jsonResponse({ success: false, error: envError }, 400);
		}

		// Handle GET requests - redirect to landing page
		if (request.method === 'GET') {
			return Response.redirect('https://nport.link', 301);
		}

		// Only accept POST and DELETE for API operations
		if (request.method !== 'POST' && request.method !== 'DELETE') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		try {
			const body = await request.json();

			if (request.method === 'POST') {
				return await handleCreateTunnel(body, env);
			} else {
				return await handleDeleteTunnel(body, env);
			}
		} catch (err) {
			console.error('[Worker Error]', err);
			return jsonResponse({ success: false, error: err.message }, 500);
		}
	},

	/**
	 * Scheduled job to clean up inactive tunnels
	 */
	async scheduled(event, env, ctx) {
		console.log('[Cron] Starting cleanup job...');

		try {
			const downunnels = await listTunnels('down', env);
			const inactiveTunnels = await listTunnels('inactive', env);
			const degradedTunnels = await listTunnels('degraded', env);
			const deadTunnels = [...downunnels, ...inactiveTunnels, ...degradedTunnels];
			console.log(`[Cron] Found ${deadTunnels.length} dead tunnels`);

			for (const tunnel of deadTunnels) {
				// Check if tunnel should be cleaned up (based on CLEANUP_PREFIXES config)
				if (!shouldCleanupTunnel(tunnel.name)) {
					console.log(`[Cron] Skipping: ${tunnel.name} (doesn't match cleanup criteria)`);
					continue;
				}

				console.log(`[Cron] Cleaning up: ${tunnel.name} (${tunnel.id})`);

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
	},
};
