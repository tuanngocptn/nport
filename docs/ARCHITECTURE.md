# NPort Architecture

> Technical documentation for NPort - A free & open-source ngrok alternative

## Table of Contents

- [System Overview](#system-overview)
- [Architecture Diagram](#architecture-diagram)
- [Project Structure](#project-structure)
- [Data Flow](#data-flow)
- [Key Modules](#key-modules)
- [Configuration](#configuration)
- [Security](#security)

---

## System Overview

NPort is a tunnel solution that exposes local development servers to the internet using Cloudflare's global edge network. It consists of three main components:

1. **CLI Client** (`src/`) - TypeScript command-line tool users install via npm
2. **Backend Server** (`server/`) - Cloudflare Worker that manages tunnel lifecycle
3. **Cloudflared Binary** - Cloudflare's tunnel client that handles the actual connection

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INTERNET                                        │
│                                                                             │
│   ┌─────────────┐                                    ┌──────────────────┐   │
│   │   Browser   │──────── HTTPS Request ────────────►│   Cloudflare     │   │
│   │   / Client  │                                    │   Edge Network   │   │
│   └─────────────┘                                    └────────┬─────────┘   │
│                                                               │             │
└───────────────────────────────────────────────────────────────┼─────────────┘
                                                                │
                                                    Cloudflare Tunnel
                                                    (Encrypted Connection)
                                                                │
┌───────────────────────────────────────────────────────────────┼─────────────┐
│                         DEVELOPER MACHINE                     │             │
│                                                               ▼             │
│   ┌─────────────┐       ┌─────────────────┐       ┌──────────────────┐     │
│   │   NPort     │──────►│   cloudflared   │◄──────│   Local Server   │     │
│   │   CLI       │       │   binary        │       │   (localhost)    │     │
│   └──────┬──────┘       └─────────────────┘       └──────────────────┘     │
│          │                                                                  │
└──────────┼──────────────────────────────────────────────────────────────────┘
           │
           │ API Request (Create/Delete Tunnel)
           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE INFRASTRUCTURE                            │
│                                                                              │
│   ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐   │
│   │  NPort Backend  │──────►│   Cloudflare    │──────►│   Cloudflare    │   │
│   │  (CF Worker)    │       │   Tunnel API    │       │   DNS API       │   │
│   │  api.nport.link │       │                 │       │                 │   │
│   └─────────────────┘       └─────────────────┘       └─────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
nport/
├── src/                         # CLI source (TypeScript)
│   ├── index.ts                 # Entry point
│   ├── tunnel.ts                # Tunnel orchestration
│   ├── api.ts                   # Backend API client
│   ├── args.ts                  # CLI argument parser
│   ├── binary.ts                # Cloudflared process manager
│   ├── bin-manager.ts           # Binary download/installation
│   ├── config.ts                # Configuration constants
│   ├── config-manager.ts        # Persistent config storage
│   ├── state.ts                 # Application state
│   ├── ui.ts                    # Console UI components
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
├── dist/                        # Compiled JavaScript output
├── bin/                         # cloudflared binary (downloaded)
│
├── server/                      # Backend (Cloudflare Worker)
│   ├── src/index.ts             # Worker entry point
│   ├── test/index.spec.ts       # Worker tests
│   ├── wrangler.jsonc           # Wrangler configuration
│   └── tsconfig.json            # TypeScript config
│
├── website/                     # Static landing page
├── docs/                        # Documentation
│   ├── ARCHITECTURE.md          # This file
│   ├── API.md                   # API reference
│   └── CONTRIBUTING.md          # Contribution guide
│
├── .ai/                         # AI context files
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript config
└── vitest.config.ts             # Test config
```

---

## Data Flow

### Creating a Tunnel

```
1. User runs: nport 3000 -s myapp

2. CLI parses arguments:
   - port: 3000
   - subdomain: "myapp"

3. CLI sends POST to backend:
   POST https://api.nport.link
   { "subdomain": "myapp" }

4. Backend creates resources:
   a. Creates Cloudflare Tunnel named "myapp"
   b. Creates DNS CNAME: myapp.nport.link → {tunnelId}.cfargotunnel.com
   c. Returns tunnel token

5. CLI receives response:
   {
     "tunnelId": "abc123",
     "tunnelToken": "eyJ...",
     "url": "https://myapp.nport.link"
   }

6. CLI spawns cloudflared:
   cloudflared tunnel run --token eyJ... --url http://localhost:3000

7. Cloudflared establishes connection:
   - Connects to Cloudflare Edge
   - Registers 4 connections (connection pooling)
   - Ready to proxy traffic

8. Traffic flows:
   Browser → myapp.nport.link → Cloudflare Edge → cloudflared → localhost:3000
```

### Deleting a Tunnel (Cleanup)

```
1. User presses Ctrl+C

2. CLI catches SIGINT signal

3. CLI kills cloudflared process

4. CLI sends DELETE to backend:
   DELETE https://api.nport.link
   { "subdomain": "myapp", "tunnelId": "abc123" }

5. Backend cleans up:
   a. Deletes DNS record for myapp.nport.link
   b. Deletes Cloudflare Tunnel abc123

6. CLI exits gracefully
```

---

## Key Modules

### `tunnel.ts` - TunnelOrchestrator

The main controller that orchestrates the entire tunnel lifecycle.

```typescript
TunnelOrchestrator.start(config)  // Initialize and create tunnel
TunnelOrchestrator.cleanup()      // Graceful shutdown
```

### `api.ts` - APIClient

Handles all communication with the backend server.

```typescript
APIClient.createTunnel(subdomain, backendUrl)  // POST to create tunnel
APIClient.deleteTunnel(subdomain, tunnelId)    // DELETE to remove tunnel
```

### `binary.ts` - BinaryManager

Manages the cloudflared binary process.

```typescript
BinaryManager.validate(path)      // Check if binary exists
BinaryManager.spawn(path, token)  // Start cloudflared process
BinaryManager.attachHandlers()    // Handle stdout/stderr
```

### `state.ts` - TunnelState

Singleton that holds all runtime state.

```typescript
state.setTunnel(id, subdomain, port)  // Store tunnel info
state.setProcess(process)              // Store child process
state.hasTunnel()                      // Check if active
state.getDurationSeconds()             // Get uptime
```

### `config.ts` - CONFIG

Application constants and environment configuration.

```typescript
CONFIG.BACKEND_URL      // API endpoint
CONFIG.DEFAULT_PORT     // Default port (8080)
CONFIG.CURRENT_VERSION  // Package version
```

---

## Configuration

### User Configuration

Stored in `~/.nport/config.json`:

```json
{
  "language": "en",
  "backendUrl": "https://custom-backend.com"
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NPORT_BACKEND_URL` | Custom backend URL | `https://api.nport.link` |
| `NPORT_ANALYTICS` | Enable/disable analytics | `true` |
| `NPORT_DEBUG` | Enable debug logging | `false` |

### Backend Configuration (Cloudflare Worker)

Required secrets in `wrangler.jsonc`:

| Secret | Description |
|--------|-------------|
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_ZONE_ID` | DNS Zone ID for nport.link |
| `CF_DOMAIN` | Base domain (nport.link) |
| `CF_API_TOKEN` | API token with Tunnel + DNS permissions |

---

## Security

### Network Security

- **TLS Encryption**: All traffic uses HTTPS via Cloudflare
- **No Direct Access**: Tunnels don't expose local IP addresses
- **Automatic Cleanup**: Tunnels are deleted after 4 hours or on exit

### Privacy

- **Anonymous Analytics**: Optional, machine-ID based (no personal data)
- **No Traffic Logging**: NPort doesn't log or inspect tunnel traffic
- **Local Binary**: Cloudflared runs locally, traffic goes direct to Cloudflare

### Protected Resources

- Reserved subdomains (e.g., `api`) cannot be claimed by users
- Backend validates subdomain availability before creation

---

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

---

## See Also

- [API Documentation](./API.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
