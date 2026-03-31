# Project Overview

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

## Key Files

| File | Purpose |
|------|---------|
| `src/tunnel.ts` | **Core orchestrator** - manages tunnel lifecycle |
| `src/api.ts` | HTTP client for backend communication |
| `src/args.ts` | CLI argument parser |
| `src/binary.ts` | Spawns and manages cloudflared process |
| `src/types/` | All TypeScript type definitions |
| `server/src/index.ts` | Cloudflare Worker backend |

## Don't

- Don't use CommonJS (`require`/`module.exports`)
- Don't use `any` type unless absolutely necessary
- Don't hardcode URLs or magic numbers — use constants
- Don't `console.log` in production code — use `ui.ts` helpers or `chalk`/`ora`
