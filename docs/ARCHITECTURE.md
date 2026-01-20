# NPort Architecture

> Technical documentation for NPort - A free & open-source ngrok alternative

## Table of Contents

- [System Overview](#system-overview)
- [Architecture Diagram](#architecture-diagram)
- [Components](#components)
- [Data Flow](#data-flow)
- [Project Structure](#project-structure)
- [Key Modules](#key-modules)
- [Configuration](#configuration)
- [Security](#security)

---

## System Overview

NPort is a tunnel solution that exposes local development servers to the internet using Cloudflare's global edge network. It consists of three main components:

1. **CLI Client** - Node.js command-line tool users install via npm
2. **Backend Server** - Cloudflare Worker that manages tunnel lifecycle
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

## Components

### 1. CLI Client (`/src/` + `index.js`)

The main npm package that users install globally. Responsible for:

- Parsing command-line arguments
- Communicating with the backend API
- Managing the cloudflared binary
- Displaying UI and status information
- Handling graceful shutdown and cleanup

**Technology:** Node.js (ES Modules), chalk, ora, axios

### 2. Backend Server (`/server/`)

A Cloudflare Worker that acts as the control plane. Responsible for:

- Creating and deleting Cloudflare Tunnels via API
- Managing DNS records (CNAME) for subdomains
- Scheduled cleanup of inactive tunnels
- Protecting reserved subdomains

**Technology:** Cloudflare Workers, Wrangler

### 3. Cloudflared Binary (`/bin/`)

Cloudflare's official tunnel client. Downloaded automatically on first run.

- Handles the actual tunnel connection to Cloudflare Edge
- Manages connection pooling and reconnection
- Supports QUIC and HTTP/2 protocols

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

## Project Structure

```
nport/
├── index.js                 # CLI entry point
├── src/
│   ├── analytics.js         # Usage analytics (Firebase/GA4)
│   ├── api.js               # Backend API client
│   ├── args.js              # CLI argument parser
│   ├── binary.js            # Cloudflared process manager
│   ├── bin-manager.js       # Binary download/installation
│   ├── config.js            # Application constants
│   ├── config-manager.js    # Persistent config storage
│   ├── lang.js              # i18n translations
│   ├── state.js             # Application state manager
│   ├── tunnel.js            # Tunnel orchestration
│   ├── ui.js                # Console UI components
│   └── version.js           # Version checking
├── bin/
│   └── cloudflared          # Downloaded binary (gitignored)
├── server/
│   ├── src/
│   │   └── index.js         # Cloudflare Worker
│   ├── test/
│   │   └── index.spec.js    # Worker tests
│   └── wrangler.jsonc       # Wrangler configuration
├── website/                 # Static landing page
├── docs/                    # Documentation
└── package.json
```

---

## Key Modules

### `tunnel.js` - TunnelOrchestrator

The main controller that orchestrates the entire tunnel lifecycle.

```javascript
TunnelOrchestrator.start(config)  // Initialize and create tunnel
TunnelOrchestrator.cleanup()      // Graceful shutdown
```

### `api.js` - APIClient

Handles all communication with the backend server.

```javascript
APIClient.createTunnel(subdomain, backendUrl)  // POST to create tunnel
APIClient.deleteTunnel(subdomain, tunnelId)    // DELETE to remove tunnel
```

### `binary.js` - BinaryManager

Manages the cloudflared binary process.

```javascript
BinaryManager.validate(path)      // Check if binary exists
BinaryManager.spawn(path, token)  // Start cloudflared process
BinaryManager.attachHandlers()    // Handle stdout/stderr
```

### `state.js` - TunnelState

Singleton that holds all runtime state.

```javascript
state.setTunnel(id, subdomain, port)  // Store tunnel info
state.setProcess(process)              // Store child process
state.hasTunnel()                      // Check if active
state.getDurationSeconds()             // Get uptime
```

### `config.js` - CONFIG

Application constants and environment configuration.

```javascript
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

## See Also

- [API Documentation](./API.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
