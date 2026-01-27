# AI Context for NPort

> This file provides context for AI assistants working on the NPort codebase.

## Project Overview

**NPort** is a free, open-source alternative to ngrok that tunnels localhost to the internet using Cloudflare's infrastructure.

- **Language**: TypeScript (ES Modules)
- **Runtime**: Node.js >= 20
- **License**: MIT

## Quick Summary

Users run `nport 3000 -s myapp` to expose their local port 3000 at `https://myapp.nport.link`.

## Architecture

```
User's Machine                    Cloud Infrastructure
┌────────────────┐               ┌──────────────────────────────┐
│  nport CLI     │──── API ─────►│  NPort Backend (CF Worker)   │
│  (TypeScript)  │               │  api.nport.link              │
│       │        │               └──────────────────────────────┘
│       ▼        │                            │
│  cloudflared   │◄─── Tunnel ───── Cloudflare Edge Network
│  (binary)      │                            │
│       │        │               ┌──────────────────────────────┐
│       ▼        │               │  Public URL                  │
│  localhost:3000│◄──────────────│  https://myapp.nport.link    │
└────────────────┘               └──────────────────────────────┘
```

## Project Structure

```
nport/
├── src/                         # TypeScript source files
│   ├── index.ts                 # Entry point
│   ├── tunnel.ts                # Tunnel orchestration
│   ├── api.ts                   # Backend API client
│   ├── args.ts                  # Argument parser
│   ├── binary.ts                # Cloudflared process manager
│   ├── bin-manager.ts           # Binary download/installation
│   ├── config.ts                # Configuration
│   ├── config-manager.ts        # Persistent config storage
│   ├── state.ts                 # State manager
│   ├── ui.ts                    # Console output
│   ├── lang.ts                  # i18n translations
│   ├── analytics.ts             # Usage analytics
│   ├── version.ts               # Version checking
│   ├── constants.ts             # Shared constants
│   └── types/                   # TypeScript type definitions
│       ├── index.ts             # Type exports
│       ├── tunnel.ts            # Tunnel types
│       ├── config.ts            # Config types
│       ├── analytics.ts         # Analytics types
│       ├── version.ts           # Version types
│       └── i18n.ts              # i18n types
│
├── tests/                       # Unit tests (vitest)
│   ├── args.test.ts
│   ├── state.test.ts
│   └── version.test.ts
│
├── dist/                        # Compiled JavaScript output
├── bin/                         # cloudflared binary (downloaded)
│
├── server/                      # Backend (Cloudflare Worker)
│   ├── src/index.ts
│   ├── test/index.spec.ts
│   └── wrangler.jsonc
│
├── website/                     # Static landing page
├── docs/                        # Documentation
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── CONTRIBUTING.md
│
├── .ai/                         # AI context files
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript config
└── vitest.config.ts             # Test config
```

## Key Files

| File | Purpose |
|------|---------|
| `src/tunnel.ts` | **Core orchestrator** - manages tunnel lifecycle |
| `src/api.ts` | HTTP client for backend communication |
| `src/args.ts` | CLI argument parser |
| `src/binary.ts` | Spawns and manages cloudflared process |
| `src/types/` | All TypeScript type definitions |
| `server/src/index.ts` | Cloudflare Worker backend |

## Common Tasks

### Adding a New CLI Flag

1. Edit `src/args.ts` - add parsing logic
2. Update types in `src/types/config.ts`
3. Edit `src/index.ts` - handle the flag
4. Update `README.md` with documentation
5. Add tests in `tests/args.test.ts`

### Modifying Tunnel Creation

1. Main logic: `src/tunnel.ts` → `TunnelOrchestrator.start()`
2. API calls: `src/api.ts` → `APIClient.createTunnel()`
3. Binary: `src/binary.ts` → `BinaryManager.spawn()`

### Modifying the Backend Worker

1. Main logic: `server/src/index.ts`
2. Key types: `Env`, `Tunnel`, `ApiResponse`
3. Key functions: `handleCreateTunnel()`, `handleDeleteTunnel()`

### Adding New Types

1. Create/edit files in `src/types/`
2. Export from `src/types/index.ts`

### Adding a New Language

1. Edit `src/lang.ts`
2. Add language code to `AVAILABLE_LANGUAGES` in `src/constants.ts`
3. Add translation object to `TRANSLATIONS`

## Coding Conventions

```typescript
// ✅ Do: Use TypeScript with types
import type { TunnelConfig } from './types/index.js';

// ✅ Do: Use .js extension in imports (ESM)
import { state } from './state.js';

// ✅ Do: Use async/await
async function createTunnel(): Promise<void> {
  const result = await APIClient.createTunnel(subdomain);
}

// ✅ Do: Use chalk for console colors
console.log(chalk.green('Success!'));

// ✅ Do: Use lang.t() for user-facing strings
console.log(lang.t('tunnelCreated'));

// ❌ Don't: Use CommonJS
const something = require('./module');

// ❌ Don't: Use `any` type
function process(data: any) { ... }
```

## Configuration Priority

1. CLI flags (highest) → `--backend https://...`
2. Saved config → `~/.nport/config.json`
3. Environment variables → `NPORT_BACKEND_URL`
4. Defaults (lowest) → `https://api.nport.link`

## Helpful Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run CLI in development
node dist/index.js 3000

# Check types
npm run lint

# Server development
cd server && npm run dev

# Deploy server
cd server && npm run deploy
```

## Links

- [Architecture Docs](../docs/ARCHITECTURE.md)
- [API Docs](../docs/API.md)
- [Contributing Guide](../docs/CONTRIBUTING.md)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
