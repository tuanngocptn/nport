# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also `.claude/rules/` for detailed per-topic rules (TypeScript style, patterns, common tasks, project overview).

## Project Overview

NPort is a free, open-source ngrok alternative that creates secure HTTP/HTTPS tunnels from localhost to public URLs using Cloudflare's global edge network. It has three components:

1. **CLI** (`src/`) — TypeScript command-line tool bundled via esbuild
2. **Backend** (`server/`) — Cloudflare Worker that manages tunnel lifecycle (creates/deletes tunnels + DNS via Cloudflare APIs)
3. **cloudflared binary** (`bin/`) — Downloaded at install/first-run; handles the actual tunnel connection

Traffic flow: Browser → `myapp.nport.link` → Cloudflare Edge → cloudflared → `localhost:port`

---

## Commands

### CLI (root directory)

```bash
npm install        # Installs deps + downloads cloudflared (postinstall hook)
npm run build      # esbuild → dist/index.js
npm run dev        # esbuild --watch (fast, no minification)
npm start          # node dist/index.js
npm test           # vitest run (tests/**/*.test.ts)
npm run test:watch # vitest --watch
npm run lint       # tsc --noEmit
```

### Server (server/ directory)

```bash
cd server
npm install
npm run dev        # wrangler dev (local CF Workers preview)
npm run deploy     # wrangler deploy
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

---

## TypeScript Conventions

- **ESM throughout**: Always use `.js` extension in relative imports (this is required, not optional)
- **Type imports**: Always use `import type { ... }` for type-only imports
- **Import order**: external packages → internal modules → types
- **`strict: true`** — full type safety; avoid `any`
- Prefer `interface` for object shapes, `type` for unions/aliases

```typescript
// ✅ Correct
import axios from 'axios';
import { CONFIG } from './config.js';
import type { TunnelConfig } from './types/index.js';

// ❌ Wrong — no .js extension, uses `any`
import { something } from './module';
function process(data: any) { ... }
```

---

## Key Modules

| File | Responsibility |
|------|----------------|
| `src/tunnel.ts` | `TunnelOrchestrator.start()` / `cleanup()` — orchestrates entire tunnel lifecycle |
| `src/api.ts` | `APIClient` — POST create / DELETE delete against backend |
| `src/binary.ts` | `BinaryManager` — validates, spawns, and handles cloudflared stdout/stderr |
| `src/bin-manager.ts` | `ensureCloudflared()` — downloads cloudflared from GitHub (platform-specific) |
| `src/state.ts` | `TunnelState` singleton — runtime state (tunnelId, subdomain, port, process) |
| `src/config-manager.ts` | `ConfigManager` singleton — persists `~/.nport/config.json` |
| `src/analytics.ts` | `AnalyticsManager` singleton — GA4 Measurement Protocol |
| `server/src/index.ts` | CF Worker fetch handler + scheduled cleanup (every 30 min) |

---

## Configuration Priority (Backend URL)

1. CLI flag `--backend` / `-b`
2. Saved config `~/.nport/config.json` via `--set-backend`
3. Environment variable `NPORT_BACKEND_URL`
4. Default `https://api.nport.link`

## Environment Variables

| Variable | Effect |
|----------|--------|
| `NPORT_BACKEND_URL` | Override backend URL |
| `NPORT_ANALYTICS=false` | Disable GA4 tracking |
| `NPORT_DEBUG=true` | Enable analytics debug logs |

---

## CI Pipelines

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | push/PR to main | Type-check + test CLI; type-check + test server |
| `deploy-server.yml` | push to `server/**` | Deploy CF Worker via wrangler-action |
| `deploy-website.yml` | push to `website/**` | Deploy to Cloudflare Pages |
| `release-npm.yml` | GitHub release | Build + npm publish |

CI uses `npm ci --ignore-scripts` for the CLI to skip cloudflared download.

---

## Adding a New Language

1. `src/constants.ts` → `AVAILABLE_LANGUAGES` — add language code
2. `src/types/i18n.ts` → `LanguageCode` — add union type
3. `src/lang.ts` → `TRANSLATIONS` — add translation object
4. `npm run build`

---

## Adding a CLI Flag

1. `src/args.ts` → `ArgumentParser` — add parsing method
2. `src/types/config.ts` → `ParsedArguments` — add field
3. `src/index.ts` → `main()` — handle the flag
4. `tests/` → add unit tests
