# Changelog

All notable changes to the NPort Server (Cloudflare Worker) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-01-30

### Fixed
- 🔧 **Tunnel Deletion with Active Connections**: Fixed Cloudflare API error #1022 when deleting tunnels
  - Added `cleanupTunnelConnections()` function to remove stale connections before deletion
  - Automatically cleans up tunnel connections before attempting to delete
  - Prevents "Cannot delete tunnel because it has active connections" error
  - Gracefully handles cases where connections are already cleaned up

### Added
- ⏰ **Configurable Tunnel Max Age**: Added automatic cleanup of healthy tunnels that exceed a configurable age
  - New `TUNNEL_MAX_AGE_HOURS` environment variable to set maximum tunnel lifetime
  - Default value: 4 hours (configurable via wrangler.jsonc or environment)
  - Healthy tunnels older than the configured age are automatically cleaned up
  - Supports decimal values (e.g., `0.5` for 30 minutes)
- 🧪 **New Test Cases**: Added comprehensive test coverage for tunnel expiration logic
  - Tests for `getTunnelMaxAgeMs()` function with various inputs
  - Tests for `isTunnelExpired()` function with edge cases
  - Tests for invalid/zero/negative environment variable values

### Improved
- 🧹 **Enhanced Cleanup Job**: Scheduled cleanup now also removes stale healthy tunnels
  - Fetches healthy tunnels and filters by age
  - Logs include tunnel age information for better debugging
  - Respects protected subdomains and prefix filtering

### Technical Details
- **New Environment Variable**: `TUNNEL_MAX_AGE_HOURS` (optional, defaults to 4)
- **New Constant**: `DEFAULT_TUNNEL_MAX_AGE_HOURS = 4`
- **Updated Tunnel Interface**: Added `created_at` field from Cloudflare API
- **New Functions**:
  - `getTunnelMaxAgeMs(env)`: Parses env var and returns max age in milliseconds
  - `isTunnelExpired(tunnel, maxAgeMs)`: Checks if tunnel exceeds max age
  - `cleanupTunnelConnections(tunnelId, env)`: Cleans up stale tunnel connections
- **Exported for Testing**: `Tunnel`, `Env` types and utility functions

### Configuration
Set the tunnel max age in `wrangler.jsonc`:
```json
"vars": {
  "TUNNEL_MAX_AGE_HOURS": "4"
}
```

Or via environment variable / Cloudflare dashboard.

## [1.1.0] - 2026-01-27

### Added
- 🔷 **TypeScript Migration**: Complete rewrite in TypeScript
  - Type-safe Cloudflare Worker handlers
  - Properly typed API responses and requests
  - Full type coverage for Cloudflare API interactions
  - Better IDE support and IntelliSense
- 🔒 **Protected Subdomains**: Infrastructure to protect critical subdomains from deletion or overwriting
  - New `PROTECTED_SUBDOMAINS` constant array for easy management of reserved subdomains
  - Default protected subdomain: `api` (reserved for NPort backend service)
  - Easy to add more protected subdomains by updating the array
  - Protected subdomains are blocked at both creation and cleanup stages
- 🔧 **Manual Cleanup Endpoint**: Added `GET /scheduled` endpoint
  - Manually trigger the scheduled cleanup job on-demand
  - Useful for testing and debugging
  - Returns JSON response with cleanup results
  - Respects protected subdomains configuration

### Security
- 🛡️ **Backend Service Protection**: Prevents accidental deletion or overwriting of production services
  - `api` subdomain is now protected from user creation attempts
  - Scheduled cleanup job skips protected subdomains
  - Returns clear error message when users try to use protected names
  - Error format: `SUBDOMAIN_PROTECTED: Subdomain "{name}" is reserved and cannot be used. Record already exists.`

### Improved
- ✅ **Enhanced Tunnel Creation Validation**: Added subdomain protection check before tunnel creation
  - Step 0: Check if subdomain is in protected list (NEW)
  - Returns `SUBDOMAIN_PROTECTED` error with user-friendly message
  - Error message clearly states "Record already exists" for better UX
- 🧹 **Smarter Cleanup Job**: Enhanced scheduled cleanup to respect protected subdomains
  - Updated `shouldCleanupTunnel()` function to check protected list first
  - Protected subdomains are never cleaned up regardless of status
  - Logged messages clearly indicate when subdomains are skipped for protection

### Changed
- 🏗️ **Project Structure**: Updated for TypeScript
  - Source files now use `.ts` extension
  - Type definitions throughout the codebase
  - Compiled output for deployment
- 🧪 **Test Suite**: Migrated to TypeScript
  - Vitest with Cloudflare Workers pool
  - Tests for all API endpoints
  - Scheduled task testing
  - Type-safe test assertions

### Technical Details
- **Type System**:
  - `Env` interface for environment variables
  - Typed request/response objects
  - Cloudflare API response types
- **New Constant**: `PROTECTED_SUBDOMAINS = ['api']`
- **Updated Functions**:
  - `shouldCleanupTunnel()`: Added protection check before cleanup logic
  - `handleCreateTunnel()`: Added protection validation before tunnel creation
  - All functions now properly typed with TypeScript
- **Cleanup Priority**: Protected subdomains > Prefix filtering > Status-based cleanup
- **Manual Cleanup**: `GET /scheduled` endpoint calls `scheduled()` function directly

### Configuration
To protect additional subdomains, simply add them to the constant:
```typescript
const PROTECTED_SUBDOMAINS = ['api', 'staging', 'prod', 'admin'] as const;
```

### Migration
- Automatic migration - no manual steps required
- All environment variables remain the same
- API endpoints unchanged
- Fully backward compatible

## [1.0.2] - 2026-01-14

### Added
- 🔒 **Protected Subdomains**: Infrastructure to protect critical subdomains from being overwritten or deleted
  - New `PROTECTED_SUBDOMAINS` constant array for easy management of reserved subdomains
  - Default protected subdomain: `api` (reserved for NPort backend service)
  - Easy to add more protected subdomains: just add to the array
  - Protected subdomains are blocked at both creation and cleanup stages

### Security
- 🛡️ **Backend Service Protection**: Prevents accidental deletion or overwriting of production services
  - `api` subdomain is now protected from user creation attempts
  - Scheduled cleanup job skips protected subdomains
  - Returns clear error message when users try to use protected names

### Improved
- ✅ **Enhanced Tunnel Creation Validation**: Added subdomain protection check before tunnel creation
  - Step 0: Check if subdomain is in protected list (NEW)
  - Returns `SUBDOMAIN_PROTECTED` error with user-friendly message
  - Error message clearly states "Record already exists" for better UX
- 🧹 **Smarter Cleanup Job**: Enhanced scheduled cleanup to respect protected subdomains
  - Updated `shouldCleanupTunnel()` function to check protected list first
  - Protected subdomains are never cleaned up regardless of status
  - Logged messages clearly indicate when subdomains are skipped for protection

### Technical Details
- **New Constant**: `PROTECTED_SUBDOMAINS = ['api']` (line 12)
- **Updated Functions**:
  - `shouldCleanupTunnel()`: Added protection check before cleanup logic
  - `handleCreateTunnel()`: Added protection validation before tunnel creation
- **Error Format**: `SUBDOMAIN_PROTECTED: Subdomain "{name}" is reserved and cannot be used. Record already exists.`
- **Cleanup Priority**: Protected subdomains > Prefix filtering > Status-based cleanup

### Configuration
To protect additional subdomains, simply add them to the constant:
```javascript
const PROTECTED_SUBDOMAINS = ['api', 'staging', 'prod', 'admin'];
```

## [1.0.1] - 2026-01-14

### Added
- **API Token Authentication**: Added support for modern Cloudflare API Token authentication (recommended over API Key)
  - Tokens provide more granular permissions and better security
  - Falls back to legacy API Key authentication if token not provided
  - Updated environment variable validation to support both methods

### Fixed
- **DNS Record Conflict Resolution**: Fixed error #81053 "An A, AAAA, or CNAME record with that host already exists"
  - Enhanced `findDnsRecord()` to search for all DNS record types (A, AAAA, CNAME) instead of only CNAME records
  - Improved error handling in `createDnsRecord()` to properly detect and ignore duplicate DNS record errors using multiple detection patterns (error message, error code #81053)
  - Added orphaned DNS record cleanup step in `handleCreateTunnel()` to automatically detect and remove DNS records that exist without corresponding tunnels
- **Authentication Error Handling**: Improved error handling for Cloudflare API authentication failures
  - Better error messages when authentication credentials are missing or invalid
  - Clearer validation of required environment variables
  
### Improved
- **Tunnel Creation Flow**: Enhanced the tunnel creation process to be more robust
  - Step 1: Check for existing tunnels with the same name
  - Step 1.5: **NEW** - Check for and clean up orphaned DNS records
  - Step 2: Create new tunnel
  - Step 3: Create DNS record with proper error handling
- **Environment Variable Configuration**: Simplified required environment variables
  - Now only requires: `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_DOMAIN`
  - Plus either `CF_API_TOKEN` OR (`CF_EMAIL` + `CF_API_KEY`)
  - More flexible authentication setup

### Documentation
- Updated README.md with comprehensive authentication setup guide
- Added troubleshooting section for common authentication errors
- Created detailed `.dev.vars.example` with both authentication options
- Added "What's New" section highlighting v1.0.1 improvements

### Technical Details
- The issue occurred when tunnels were deleted but DNS records remained in Cloudflare
- The original `findDnsRecord()` only searched for CNAME records, missing A/AAAA records that could cause conflicts
- Added comprehensive error detection for Cloudflare error code #81053
- Improved logging for better debugging of DNS and tunnel operations
- Authentication now uses `Authorization: Bearer` header for API Tokens

## [0.0.0] - Initial Release

### Added
- Initial Cloudflare Worker implementation
- Tunnel creation and deletion endpoints
- DNS record management (create/delete)
- Scheduled cleanup job for inactive tunnels
- Support for Cloudflare Tunnel API integration
