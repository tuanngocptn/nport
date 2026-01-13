# Changelog

All notable changes to NPort will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

