# Changelog

All notable changes to the NPort Server (Cloudflare Worker) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
