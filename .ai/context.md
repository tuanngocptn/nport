# AI Context for NPort

> This file provides context for AI assistants working on the NPort codebase.

## Project Overview

**NPort** is a free, open-source alternative to ngrok that tunnels localhost to the internet using Cloudflare's infrastructure.

- **Type**: CLI tool (npm package)
- **Language**: JavaScript (ES Modules)
- **Runtime**: Node.js >= 20
- **License**: MIT

## Quick Summary

Users run `nport 3000 -s myapp` to expose their local port 3000 at `https://myapp.nport.link`.

## Architecture

```
User's Machine                    Cloud Infrastructure
┌────────────────┐               ┌──────────────────────────────┐
│  nport CLI     │──── API ─────►│  NPort Backend (CF Worker)   │
│  (Node.js)     │               │  api.nport.link              │
│       │        │               └──────────────────────────────┘
│       ▼        │                            │
│  cloudflared   │◄─── Tunnel ───── Cloudflare Edge Network
│  (binary)      │                            │
│       │        │               ┌──────────────────────────────┐
│       ▼        │               │  Public URL                  │
│  localhost:3000│◄──────────────│  https://myapp.nport.link    │
└────────────────┘               └──────────────────────────────┘
```

## Key Components

### 1. CLI Client (`/src/` + `index.js`)

| File | Purpose |
|------|---------|
| `index.js` | Entry point, argument handling, main flow |
| `src/tunnel.js` | **Core orchestrator** - manages tunnel lifecycle |
| `src/api.js` | HTTP client for backend communication |
| `src/args.js` | CLI argument parser |
| `src/binary.js` | Spawns and manages cloudflared process |
| `src/bin-manager.js` | Downloads cloudflared on first run |
| `src/ui.js` | Console output formatting |
| `src/lang.js` | i18n translations (English, Vietnamese) |
| `src/state.js` | Singleton state manager |
| `src/config.js` | Constants and environment config |
| `src/config-manager.js` | Persistent user preferences |
| `src/analytics.js` | Optional usage tracking |
| `src/version.js` | npm version checking |

### 2. Backend Server (`/server/`)

Single file Cloudflare Worker that:
- Creates Cloudflare Tunnels via API
- Creates DNS CNAME records
- Handles cleanup (scheduled job)
- Protects reserved subdomains

### 3. Website (`/website/`)

Static HTML/CSS/JS landing page. Not critical for development.

## Common Tasks

### Adding a New CLI Flag

1. Edit `src/args.js` - add parsing logic in `ArgumentParser.parse()`
2. Edit `index.js` - handle the new flag in `main()`
3. Update `README.md` with documentation

### Modifying Tunnel Creation Flow

1. Main logic is in `src/tunnel.js` → `TunnelOrchestrator.start()`
2. API calls go through `src/api.js` → `APIClient.createTunnel()`
3. Binary spawning is in `src/binary.js` → `BinaryManager.spawn()`

### Adding a New Language

1. Edit `src/lang.js`
2. Add language code to `availableLanguages` array
3. Add translation object to `TRANSLATIONS`

### Modifying Console Output

1. Edit `src/ui.js` for display changes
2. Use `lang.t("key")` for translatable strings
3. Use `chalk` for colors

## Coding Conventions

```javascript
// ✅ Do: Use ES modules
import { something } from "./module.js";

// ✅ Do: Use async/await
async function doSomething() {
  const result = await fetchData();
  return result;
}

// ✅ Do: Add JSDoc comments
/**
 * Description of function
 * @param {string} param - Description
 * @returns {Promise<Object>} Description
 */

// ✅ Do: Use chalk for console colors
console.log(chalk.green("Success!"));

// ✅ Do: Use lang.t() for user-facing strings
console.log(lang.t("tunnelCreated"));

// ❌ Don't: Use CommonJS
const something = require("./module");

// ❌ Don't: Use var
var oldStyle = "bad";
```

## Important Patterns

### State Management

```javascript
import { state } from "./state.js";

// Store tunnel info
state.setTunnel(tunnelId, subdomain, port);

// Check if tunnel exists
if (state.hasTunnel()) { ... }

// Get duration
const seconds = state.getDurationSeconds();
```

### Error Handling

```javascript
// API errors have structured messages
if (error.message.includes("SUBDOMAIN_IN_USE:")) {
  // Subdomain is taken by active tunnel
}

if (error.message.includes("SUBDOMAIN_PROTECTED:")) {
  // Subdomain is reserved (e.g., "api")
}
```

### Configuration Priority

1. CLI flags (highest) → `--backend https://...`
2. Saved config → `~/.nport/config.json`
3. Environment variables → `NPORT_BACKEND_URL`
4. Defaults (lowest) → `https://api.nport.link`

## File Locations

| What | Where |
|------|-------|
| User config | `~/.nport/config.json` |
| Analytics ID | `~/.nport/analytics-id` |
| Binary | `./bin/cloudflared` (or `.exe` on Windows) |

## Testing

```bash
# CLI - manual testing
node index.js 3000 -s test

# Server - vitest
cd server && npm test
```

## Dependencies

**CLI**:
- `axios` - HTTP client
- `chalk` - Terminal colors
- `ora` - Spinners

**Server**:
- `wrangler` - Cloudflare Worker CLI
- `vitest` - Testing

## Helpful Commands

```bash
# Install and link for development
npm install && npm link

# Run without global install
node index.js 3000

# Check version
node index.js -v

# Change language
node index.js -l

# Use custom backend
node index.js 3000 -b https://localhost:8787
```

## Common Issues

1. **"Binary not found"** → Run `npm install` to trigger postinstall
2. **"Subdomain taken"** → Try a different subdomain or use random
3. **Network warnings** → Usually safe to ignore, QUIC fallback works

## Links

- [Architecture Docs](./docs/ARCHITECTURE.md)
- [API Docs](./docs/API.md)
- [Contributing Guide](./docs/CONTRIBUTING.md)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
