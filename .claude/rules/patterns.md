# Key Patterns

## State Management

The `TunnelState` singleton holds all runtime state:

```typescript
import { state } from './state.js';
state.setTunnel(id, subdomain, port);
state.setProcess(process);
state.hasTunnel();
```

## Configuration Priority (Backend URL)

1. CLI flags (highest) — `--backend https://...`
2. Saved config — `~/.nport/config.json` via `--set-backend`
3. Environment variables — `NPORT_BACKEND_URL`
4. Defaults (lowest) — `https://api.nport.link`

## API Communication

```typescript
import { APIClient } from './api.js';
const tunnel = await APIClient.createTunnel(subdomain, backendUrl);
await APIClient.deleteTunnel(subdomain, tunnelId, backendUrl);
```

## Binary Management

```typescript
import { ensureCloudflared } from './bin-manager.js';
const binaryPath = await ensureCloudflared();
```

The `BinaryManager` in `binary.ts` handles spawning cloudflared and routing its stdout/stderr through log pattern filters (SUCCESS, ERROR, NETWORK_WARNING, IGNORE).
