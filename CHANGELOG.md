# Changelog

All notable changes to NPort will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.7] - 2026-01-14

### Added
- 🌐 **Smart Network Warning System**: Intelligent handling of QUIC/network connectivity issues
  - Automatic detection and filtering of QUIC protocol errors
  - User-friendly warning messages instead of scary red error spam
  - Bilingual support (English & Vietnamese)
  - Smart throttling: Shows warning only after 5 errors, max once per 30 seconds
  - Clear explanations of what's happening and how to fix it
  - Automatic reset when connection is restored

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

### Technical Details
- **Network Error Patterns**: Added detection for 7 common QUIC/network error patterns
- **State Management**: New network issue tracking in application state
  - `networkIssueCount`: Counter for network errors
  - `lastNetworkWarningTime`: Timestamp tracking for cooldown
  - `shouldShowNetworkWarning()`: Smart decision logic
- **Configuration**: New `NETWORK_CONFIG` with threshold and cooldown settings
- **Bilingual Messages**: Complete translations for all network warning messages

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

