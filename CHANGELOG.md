# Changelog

All notable changes to NPort will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

