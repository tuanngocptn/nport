# Changelog

All notable changes to NPort will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.3] - 2026-01-29

### Fixed
- 🪟 **Windows Spawn Error**: Fixed "spawn UNKNOWN" error on Windows
  - Added Windows-specific spawn options (`windowsHide`, `shell`, `stdio`)
  - Process now spawns correctly with proper path resolution on Windows
  - Added helpful troubleshooting tips for Windows users when spawn fails

### Improved
- 🔧 **Better Windows Error Guidance**: Enhanced error messages for Windows users
  - Detects common spawn errors (UNKNOWN, ENOENT)
  - Provides actionable troubleshooting steps:
    - Check Windows Defender/antivirus blocking
    - Try running as Administrator
    - Reinstall nport if needed

## [2.1.2] - 2026-01-28

### Fixed
- 📊 **Analytics Integration**: Fixed GA4 Measurement Protocol implementation
  - Created dedicated CLI analytics stream (`G-JJHG4DP1K9`) separate from website
  - Fixed `session_id` format (now uses numeric timestamp as required by GA4)
  - Fixed `engagement_time_msec` to use actual number instead of string
  - Added `timestamp_micros` for accurate event timing
  - Removed debug endpoint that was preventing events from being recorded
  - Added proper debug logging when `NPORT_DEBUG=true`

### Changed
- 📦 **Optimized Bundle Size**: Switched from `tsc` to `esbuild` for significantly smaller package
  - New `scripts/build.js` bundles and minifies CLI into single file
  - Tree-shaking removes unused code
  - Disabled TypeScript declaration and source map generation
  - Reduced files in npm package (only `postinstall.js` script included)
- ⚡ **Faster Development**: Improved watch mode with esbuild
  - Minification disabled during development for faster rebuilds
  - Concurrent watching for main CLI and bin-manager entry points
  - Better console output showing active file monitoring

### Improved
- 🧪 **Enhanced Smoke Tests**: Better npm package validation in CI
  - Tests now simulate full npm pack/install flow
  - Installation tested from generated tarball
  - More accurate pre-publish validation

### Technical Details
- **esbuild Configuration**: 
  - Target: Node.js 20
  - Format: ESM
  - External dependencies: `axios`, `chalk`, `ora` (avoids CJS/ESM issues)
  - Shebang added via esbuild banner instead of source file
- **tsconfig.json**: Updated with `noEmit: true`, esbuild handles output
- **Package Size**: Significantly reduced dist folder size
- **Analytics Events**: `cli_start`, `tunnel_created`, `tunnel_error`, `tunnel_shutdown`, `update_available`

## [2.1.1] - 2026-01-27

### Fixed
- 🐛 **NPM Package Build**: Fixed missing `dist/` folder in published package
  - Added build step to npm-publish workflow before publishing
  - Package now includes compiled JavaScript files correctly

### Added
- 🚀 **CI/CD Workflows**: Added GitHub Actions for automated deployments
  - `ci.yml`: Runs tests on push to main and pull requests
  - `deploy-server.yml`: Auto-deploys Cloudflare Worker on server changes
  - `deploy-website.yml`: Auto-deploys website to Cloudflare Pages on changes
- 🧪 **Server Test Configuration**: Fixed Vitest config for CI environment
  - Added miniflare bindings for test environment variables
  - Tests now pass in CI without `.dev.vars` file
- ⚙️ **Wrangler Configuration**: Added `preview_urls` setting to suppress warnings

## [2.1.0] - 2026-01-27

### Added
- 🔷 **Full TypeScript Migration**: Complete rewrite of CLI and Server in TypeScript
  - Strict type checking enabled across the entire codebase
  - All modules converted from JavaScript to TypeScript
  - Type-safe interfaces for configuration, tunnels, analytics, and i18n
  - Better IDE support with IntelliSense and autocompletion
- 📚 **Comprehensive Documentation**: New docs folder with detailed guides
  - `docs/ARCHITECTURE.md`: System overview, component diagrams, and data flow
  - `docs/API.md`: Complete API reference with endpoints and examples
  - `docs/CONTRIBUTING.md`: Contribution guidelines and development setup
- 🤖 **AI Context Support**: Added `.ai/context.md` for AI-assisted development
  - Project structure and key patterns documented
  - Coding conventions and architecture decisions
  - Makes AI pair programming more effective
- 🧪 **Unit Testing with Vitest**: Comprehensive test suite for CLI
  - Tests for argument parsing (`tests/args.test.ts`)
  - Tests for version comparison (`tests/version.test.ts`)
  - Tests for state management (`tests/state.test.ts`)
  - Easy to run with `npm test`
- 📋 **Code Ownership**: Added `.github/CODEOWNERS` file
  - Clear ownership for code review assignments
  - Faster PR reviews with automatic reviewer assignment
- 📝 **Cursor Rules**: Added `.cursorrules` for consistent AI assistance
  - Project-specific coding conventions
  - TypeScript and naming guidelines
  - Common patterns and anti-patterns
- 🔄 **Auto-download Cloudflared**: Binary downloads automatically on first run
  - No need to run separate install commands
  - Seamless first-time user experience
  - Progress indicator during download
- 🔒 **Protected Subdomain Support**: Enhanced error handling for reserved subdomains
  - User-friendly error message when trying to create protected subdomains (like `api`)
  - Formatted error output matching existing error style
  - Helpful suggestions to use alternative subdomain names
  - Prevents accidental use of backend service subdomains
- 📋 **TODO Management**: Added `TODO.md` for tracking planned features
  - Move time limit enforcement to backend
  - Update README powered-by section
  - Track terminal link clicks

### Changed
- 🏗️ **Project Structure**: Reorganized for better maintainability
  - All source code in `src/` directory
  - Type definitions in `src/types/`
  - Shared constants in `src/constants.ts`
  - Tests in `tests/` directory
- 📦 **Build System**: Updated to TypeScript compilation
  - Uses `tsc` for compilation
  - Output to `dist/` directory
  - Source maps for debugging
- 🔧 **Development Workflow**: Improved developer experience
  - `npm run dev` for watch mode
  - `npm run build` for production
  - `npm test` for running tests
  - `npm run lint` for type checking
- ⚙️ **System Requirements**: Updated to Node.js 20+
  - Minimum Node.js version: 20.0.0
  - Minimum npm version: 10.0.0
  - Better security and performance with latest LTS

### Improved
- ✨ **Better Error Messages**: Enhanced user feedback for protected subdomains
  - Catches `SUBDOMAIN_PROTECTED` errors from backend
  - Formats error messages consistently with other error types
  - Shows actionable options when subdomain is reserved

### Fixed
- 🐛 **Intel Mac Binary Download**: Fixed cloudflared binary download on Intel Macs
  - Node.js reports architecture as `x64`, not `amd64` - now correctly mapped
  - Fixed ARM64 Macs to download the correct `cloudflared-darwin-arm64.tgz` binary
  - Previously ARM64 Macs were incorrectly downloading the AMD64 binary

### Server (v1.1.0)
- 🔷 **TypeScript Migration**: Server fully converted to TypeScript
  - Type-safe Cloudflare Worker handlers
  - Properly typed API responses
  - Full type coverage for Cloudflare API interactions
- 🧪 **Server Tests**: Updated test suite for TypeScript
  - Vitest with Cloudflare Workers pool
  - Tests for all API endpoints
  - Scheduled task testing
- 🔒 **Protected Subdomains**: Infrastructure to protect critical subdomains from deletion or overwriting
  - New `PROTECTED_SUBDOMAINS` constant array for easy management of reserved subdomains
  - Default protected subdomain: `api` (reserved for NPort backend service)
  - Easy to add more protected subdomains by updating the array
  - Protected subdomains are blocked at both creation and cleanup stages
- 🛡️ **Backend Service Protection**: Prevents accidental deletion or overwriting of production services
  - `api` subdomain is now protected from user creation attempts
  - Scheduled cleanup job skips protected subdomains
  - Returns clear error message when users try to use protected names
- 🔧 **Manual Cleanup Endpoint**: Added `GET /scheduled` endpoint to manually trigger cleanup
  - Useful for testing and on-demand cleanup
  - Respects protected subdomains configuration
  - Returns JSON response with cleanup results

### Technical Details
- **Type System**: 
  - `TunnelConfig`, `TunnelState`, `ConnectionInfo` interfaces
  - `AnalyticsParams`, `VersionInfo`, `I18nStrings` types
  - `LogPatterns` with readonly arrays for constants
- **ESM Compliance**: All imports use `.js` extensions as required
- **Constants**: Centralized in `src/constants.ts` with `as const` assertions
- **Error Handling**: Type-safe error boundaries throughout

### Migration
- Automatic migration - no manual steps required
- Existing configuration in `~/.nport/config.json` remains compatible
- All CLI flags and options unchanged

### Breaking Changes
- None - fully backward compatible!

## [2.0.7] - 2026-01-14

### Added
- 🌐 **Smart Network Warning System**: Intelligent handling of QUIC/network connectivity issues
  - Automatic detection and filtering of QUIC protocol errors
  - User-friendly warning messages instead of scary red error spam
  - Bilingual support (English & Vietnamese)
  - Smart throttling: Shows warning only after 5 errors, max once per 30 seconds
  - Clear explanations of what's happening and how to fix it
  - Automatic reset when connection is restored
- 🔒 **Protected Subdomain Support**: Enhanced error handling for reserved subdomains
  - User-friendly error message when trying to create protected subdomains (like `api`)
  - Formatted error output matching existing error style
  - Helpful suggestions to use alternative subdomain names
  - Prevents accidental use of backend service subdomains

### Improved
- 🔇 **Cleaner Terminal Output**: No more error spam from cloudflared
  - QUIC timeout errors are now silently tracked instead of displayed
  - Network warnings filtered: "failed to accept QUIC stream", "timeout: no recent network activity", etc.
  - Only shows meaningful warnings when there's an actual persistent issue
  - Terminal stays clean and readable during normal operation
- 📡 **Better User Communication**: Context-aware network issue reporting
  - Explains that QUIC failures are usually not critical
  - Tunnel continues working via HTTP/2 fallback
  - Provides actionable troubleshooting steps
  - Reassures users that the tunnel is still functional
- ✨ **Better Error Messages**: Enhanced user feedback for protected subdomains
  - Catches `SUBDOMAIN_PROTECTED` errors from backend
  - Formats error messages consistently with other error types
  - Shows actionable options when subdomain is reserved

### Technical Details
- **Network Error Patterns**: Added detection for 7 common QUIC/network error patterns
- **State Management**: New network issue tracking in application state
  - `networkIssueCount`: Counter for network errors
  - `lastNetworkWarningTime`: Timestamp tracking for cooldown
  - `shouldShowNetworkWarning()`: Smart decision logic
- **Configuration**: New `NETWORK_CONFIG` with threshold and cooldown settings
- **Bilingual Messages**: Complete translations for all network warning messages
- **Protected Subdomain Handling**: Enhanced error handling in `src/api.js`
  - Added check for `SUBDOMAIN_PROTECTED` error type
  - Consistent formatting with existing error messages
  - Clear user guidance for alternative subdomain choices

### User Experience
**Before:**
```
[Cloudflared] 2026-01-14T04:33:02Z ERR failed to accept QUIC stream...
[Cloudflared] 2026-01-14T04:33:03Z ERR failed to accept QUIC stream...
[Cloudflared] 2026-01-14T04:33:04Z ERR failed to accept QUIC stream...
[Cloudflared] 2026-01-14T04:33:05Z ERR failed to accept QUIC stream...
```

**After:**
```
✔ [1/2] Connection established...
✔ [2/2] Compression enabled...

⚠️  NETWORK CONNECTIVITY ISSUE DETECTED
   Cloudflared is having trouble maintaining a stable connection...
   📡 Your tunnel is still working, but connection quality may be affected.
   
   💡 Possible reasons:
      • Unstable internet connection or high packet loss
      • Firewall/Router blocking UDP traffic (QUIC protocol)
      • ISP throttling or network congestion
      
   🔧 What to try:
      • Check your internet connection stability
      • Try connecting from a different network
      • Disable VPN/Proxy if you're using one
      
   ℹ️  This is usually not critical - your tunnel should continue working normally.
```

## [2.0.6] - 2026-01-13

### Added
- 🔧 **Backend URL Configuration**: Full control over backend server
  - `--backend` / `-b` flag for temporary backend override
  - `--set-backend` command to save backend URL permanently
  - `NPORT_BACKEND_URL` environment variable support
  - Saved backend configuration persists across sessions
  - Priority system: CLI flag > Saved config > Env var > Default
- 🗂️ **Unified Configuration System**: All settings in one place
  - New centralized `config-manager.js` module
  - All preferences stored in `~/.nport/config.json`
  - Automatic migration from old format (v2.0.5)
  - Easy to read and manually edit JSON format
- 🌐 **New Default Backend**: Updated to `api.nport.link`
  - Professional domain structure
  - Better branding alignment
  - Shorter and easier to remember

### Changed
- 📝 **Language Configuration**: Now uses unified config system
  - Language setting moved from `~/.nport/lang` to `~/.nport/config.json`
  - Automatic migration from old file format
  - Consistent configuration approach across all settings
- 📚 **Documentation Updates**: Complete overhaul
  - Updated `README.md` with backend configuration options
  - New `CLIENT_SETUP.md` focused on npm installation and backend setup
  - Comprehensive backend URL documentation
  - Clear priority order explanation

### Improved
- 🎯 **Consistency**: Unified approach to all configuration
  - Backend URL and language now use same storage system
  - Single config file for all preferences
  - Cleaner architecture and code organization
- 💾 **Configuration File Structure**:
  ```json
  {
    "backendUrl": "https://api.nport.link",
    "language": "en"
  }
  ```

### Migration
- Automatic migration from v2.0.5 configuration files
- Old `~/.nport/lang` file automatically migrated to `config.json`
- No manual steps required
- Old files removed after successful migration

## [2.0.5] - 2026-01-13

### Added
- 🌍 **Multilingual Support**: Full internationalization with English and Vietnamese
  - Interactive language selection on first run
  - `--language` / `-l` flag to change language anytime
  - Language preference saved to `~/.nport/lang`
- 🎨 **Enhanced UI**: Complete redesign with better visual hierarchy
  - New header design with Vietnamese pride
  - Improved connection status messages
  - Better formatted output with consistent spacing
  - Language change hint in goodbye message
- 📂 **Modular Architecture**: Refactored codebase into organized modules
  - Split code into `/src` directory with clear separation of concerns
  - Better maintainability and testability
  - Modules: config, state, args, binary, api, version, ui, tunnel, lang, analytics
- ✅ **Version Command**: Added `-v` / `--version` flag
  - Shows current version
  - Checks for updates automatically
  - Displays update instructions if available
- 📝 **Configuration Directory**: Organized config files under `~/.nport/`
  - Language preference: `~/.nport/lang`
  - Analytics ID: `~/.nport/analytics-id`

### Changed
- 🎯 **Improved Console Output**: Better formatting and spacing throughout
  - Connection messages now properly indented
  - Time remaining display updated
  - Footer redesigned with clearer calls-to-action
- 🔧 **Better Argument Parsing**: Enhanced CLI argument handling
  - Support for multiple language flag formats
  - Interactive prompt when using `--language` without value
- 📚 **Updated Documentation**: Complete README overhaul
  - Added multilingual feature documentation
  - New CLI options table
  - Project structure documentation
  - Cleaner examples and better organization

### Fixed
- 🐛 **Terminal Compatibility**: Removed problematic emoji flags
  - Vietnamese flag emoji replaced with text
  - Better compatibility across different terminals

## [2.0.4] - Previous Release

### Features
- Basic tunnel functionality
- Custom subdomain support
- Cloudflare integration
- Auto-cleanup on exit
- 4-hour tunnel timeout

---

## Version Upgrade Guide

### From 2.1.2 to 2.1.3

```bash
npm install -g nport@latest
```

**What's New:**

1. **Windows Compatibility Fix**
   - Fixed "spawn UNKNOWN" error that prevented cloudflared from starting on Windows
   - Added proper spawn options for Windows path resolution
   - Better error handling with actionable troubleshooting tips

**For Windows Users:**
If you still experience issues after upgrading:
- Check if Windows Defender/antivirus is blocking `cloudflared.exe`
- Try running your terminal as Administrator
- Reinstall: `npm uninstall -g nport && npm install -g nport`

**Breaking Changes:** None - fully backward compatible!

### From 2.1.1 to 2.1.2

```bash
npm install -g nport@latest
```

**What's New:**

1. **Smaller Package Size**
   - Switched from `tsc` to `esbuild` for bundling
   - Minification and tree-shaking reduce CLI size
   - Fewer files included in npm package

2. **Faster Development**
   - Watch mode now uses esbuild for instant rebuilds
   - Better console output during development

3. **Better CI Testing**
   - Smoke tests now validate full npm pack/install flow
   - More reliable pre-publish checks

**For Contributors:**
```bash
npm run build  # Uses esbuild, outputs to dist/
npm run dev    # Fast watch mode with esbuild
```

**Breaking Changes:** None - fully backward compatible!

### From 2.0.7 to 2.1.0

```bash
npm install -g nport@latest
```

**What's New:**

1. **Full TypeScript Rewrite**
   - Both CLI and Server now fully typed
   - Better IDE support and autocompletion
   - Catches errors at compile time

2. **Comprehensive Documentation**
   - Architecture guide in `docs/ARCHITECTURE.md`
   - API reference in `docs/API.md`
   - Contributing guide in `docs/CONTRIBUTING.md`

3. **Unit Testing**
   - Run tests with `npm test`
   - Covers argument parsing, version checks, state management

4. **Auto-download Cloudflared**
   - Binary downloads automatically on first `nport` run
   - No separate install step needed

5. **AI-Friendly Codebase**
   - `.ai/context.md` for AI assistants
   - `.cursorrules` for consistent AI suggestions
   - JSDoc comments throughout

**For Contributors:**
```bash
git clone https://github.com/tuanngocptn/nport
cd nport
npm install
npm run build
npm run dev  # Watch mode
```

**Breaking Changes:** None - fully backward compatible!

### From 2.0.6 to 2.0.7

```bash
npm install -g nport@latest
```

**What's New:**

1. **Cleaner Terminal Experience**
   - No more scary red QUIC error spam
   - Smart network warnings when needed
   - Automatic fallback to HTTP/2 when QUIC fails

2. **Better Error Communication**
   - Understand what's happening with your connection
   - Clear explanations in your language (EN/VI)
   - Actionable troubleshooting steps

3. **When You'll See Warnings**
   - Only after multiple network issues (not just one)
   - Maximum once every 30 seconds (no spam)
   - Automatically disappears when connection improves

**Breaking Changes:** None - fully backward compatible!

### From 2.0.5 to 2.0.6

```bash
npm install -g nport@latest
```

**New Features to Try:**

1. **Set Your Backend Permanently**
   ```bash
   nport --set-backend https://api.nport.link
   ```

2. **Use Custom Backend Temporarily**
   ```bash
   nport 3000 -b https://your-backend.com
   ```

3. **Check Current Configuration**
   ```bash
   cat ~/.nport/config.json
   ```

4. **Use Environment Variable**
   ```bash
   export NPORT_BACKEND_URL=https://your-backend.com
   nport 3000
   ```

**Breaking Changes:** None - fully backward compatible!

**Migration:** Your language preference from v2.0.5 will be automatically migrated to the new unified config format.

### From 2.0.4 to 2.0.5

```bash
npm install -g nport@latest
```

**New Features to Try:**

1. **Change Language**
   ```bash
   nport --language
   ```

2. **Check Version**
   ```bash
   nport -v
   ```

3. **Direct Language Selection**
   ```bash
   nport 3000 -l vi  # Vietnamese
   nport 3000 -l en  # English
   ```

**Breaking Changes:** None - fully backward compatible!

---

Made with ❤️ in Vietnam by [Nick Pham](https://github.com/tuanngocptn)

