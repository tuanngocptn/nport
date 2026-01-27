# NPort Client Setup Guide

This guide will help you set up and use the NPort CLI client to create tunnels to your local development server.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20.0.0
- npm >= 10.0.0
- A running NPort backend server (see [Server Setup](./server/README.md))

## Installation

Install NPort from npm:

```bash
npm install -g nport
```

That's it! NPort will automatically download the required binary on first use.

## Backend Configuration

### Option 1: Set Backend Permanently (Recommended)

Save your backend URL once, and it will be used for all future sessions:

```bash
# Set your backend URL
nport --set-backend https://api.nport.link

# Now use nport normally
nport 3000
nport 3000 -s myapp
```

To clear the saved backend:
```bash
nport --set-backend
```

### Option 2: Use Backend Temporarily

Specify backend for just one session:

```bash
# Using --backend flag
nport 3000 --backend https://api.nport.link

# Using -b shorthand
nport 3000 -b https://api.nport.link
```

### Option 3: Use Environment Variable

Set the backend via environment variable:

```bash
# Linux/macOS
export NPORT_BACKEND_URL=https://api.nport.link
nport 3000

# Windows (PowerShell)
$env:NPORT_BACKEND_URL="https://api.nport.link"
nport 3000

# Windows (CMD)
set NPORT_BACKEND_URL=https://api.nport.link
nport 3000
```

**Priority Order:**
1. CLI flag (`--backend` / `-b`) - Highest priority
2. Saved config (`--set-backend`)
3. Environment variable (`NPORT_BACKEND_URL`)
4. Default (`https://api.nport.link`) - Lowest priority

## Quick Start

### 1. Start Your Local Server

First, make sure you have a local development server running:

```bash
# Example: A Next.js app
cd my-app
npm run dev  # Runs on http://localhost:3000

# Or any other server on any port
python -m http.server 8080
```

### 2. Create a Tunnel

#### With Default Random Subdomain:
```bash
nport 3000
```

Output:
```
─────────────────────────────────────────────────────────────────
NPort - ngrok who? (Free & Open Source from Vietnam)
─────────────────────────────────────────────────────────────────
⚡ Built different: No cap, actually free forever
🌐 Website:       https://nport.link
📦 NPM:           npm i -g nport
💻 GitHub:        https://github.com/tuanngocptn/nport
👤 Made by:       @tuanngocptn (https://github.com/tuanngocptn)
☕ Buy me coffee: https://buymeacoffee.com/tuanngocptn
─────────────────────────────────────────────────────────────────
💭 No paywalls. No BS. Just vibes. ✨
─────────────────────────────────────────────────────────────────

🚀 Starting Tunnel for port 3000...
✔ Tunnel created!
🌍 Public URL: https://user-1234.nport.link
   (Using bundled binary)
   Auto-cleanup in 4 hours
Connecting to global network...
✔ Connection established [1/4] - Establishing redundancy...
✔ Connection established [2/4] - Building tunnel network...
✔ Connection established [3/4] - Almost there...
✔ Connection established [4/4] - Tunnel is fully active! 🚀
```

#### With Custom Subdomain:
```bash
# Using --subdomain flag
nport 3000 --subdomain my-app

# Using -s shorthand
nport 3000 -s my-app
```

Your app will be available at: `https://my-app.nport.link`

### 3. Stop the Tunnel

Press `Ctrl+C` in the terminal where nport is running. The tunnel will be automatically cleaned up.

## Usage Examples

### Example 1: Expose a React Development Server
```bash
# Start React app (usually runs on port 3000)
npm start

# In another terminal, create tunnel
nport 3000 -s my-react-app
# Access at: https://my-react-app.nport.link
```

### Example 2: Expose a Next.js App
```bash
# Start Next.js app (usually runs on port 3000)
npm run dev

# Create tunnel with custom subdomain
nport 3000 -s my-next-app
# Access at: https://my-next-app.nport.link
```

### Example 3: Expose a Backend API
```bash
# Start your API server (e.g., Express on port 8080)
node server.js

# Create tunnel
nport 8080 -s my-api
# Access at: https://my-api.nport.link
```

### Example 4: Test Webhooks Locally
```bash
# Start your webhook receiver (e.g., port 4000)
npm run webhook-server

# Create tunnel
nport 4000 -s webhook-test
# Use https://webhook-test.nport.link as your webhook URL
```

### Example 5: Share a Static Site
```bash
# Start a simple HTTP server
python -m http.server 8000

# Create tunnel
nport 8000 -s demo
# Share: https://demo.nport.link
```

## Configuration

### View Current Configuration

```bash
# Check saved backend URL
cat ~/.nport/config.json
```

### Backend Examples

```bash
# Official backend (default)
nport --set-backend https://api.nport.link

# Self-hosted backend
nport --set-backend https://your-backend.example.com

# Local development backend
nport --set-backend http://localhost:8787

# Cloudflare Worker
nport --set-backend https://your-worker.your-account.workers.dev
```

## Command-Line Options

```bash
nport [port] [options]
```

### Arguments

- `port` - The local port to tunnel (default: 8080)

### Options

| Option | Short | Description | Example |
|--------|-------|-------------|---------|
| `--subdomain <name>` | `-s` | Custom subdomain | `nport 3000 -s myapp` |
| `--backend <url>` | `-b` | Backend URL (temporary) | `nport 3000 -b https://api.nport.link` |
| `--set-backend <url>` | - | Save backend URL permanently | `nport --set-backend https://api.nport.link` |
| `--language <lang>` | `-l` | Set language (en/vi) | `nport -l en` |
| `--version` | `-v` | Show version | `nport -v` |

## Features

### ✅ Free & Open Source
- 100% free to use
- No registration required
- No credit card needed
- Open source on GitHub

### ✅ Custom Subdomains
- Choose your own subdomain
- Easy to remember and share
- Perfect for demos and testing

### ✅ Auto-Cleanup
- Tunnels automatically close after 4 hours
- Clean up on `Ctrl+C`
- No orphaned resources

### ✅ Binary Management
- Cloudflared binary downloads automatically on first run
- Platform-specific binaries (Windows, macOS, Linux)
- Stored locally, no repeated downloads

### ✅ Version Notifications
- Automatic check for updates
- Non-intrusive notifications
- Easy upgrade process

## Troubleshooting

### Binary Not Found Error
```
❌ Error: Cloudflared binary not found at: /path/to/bin/cloudflared
👉 Please run 'npm install' again to download the binary.
```

**Solution:**
```bash
# If installed globally
npm uninstall -g nport
npm install -g nport

# If running from source
cd nport
rm -rf packages/cli/bin/
npm install
```

### Subdomain Already Taken
```
Subdomain "my-app" is already taken or in use.
```

**Solutions:**
1. Choose a different subdomain: `nport 3000 -s my-app-v2`
2. Use a random subdomain: `nport 3000`
3. Wait a few minutes if you just stopped a tunnel with this name

### Connection Failed
```
✖ Failed to connect to server.
```

**Possible causes:**
1. **No local server running** - Make sure your app is running on the specified port
2. **Wrong port** - Check which port your app is actually using
3. **Backend server down** - Check if the NPort backend is accessible
4. **Firewall blocking connection** - Check your firewall settings

**Test your local server:**
```bash
# Test if your server is responding
curl http://localhost:3000

# Or open in browser
open http://localhost:3000
```

### Spawn ENOEXEC Error
```
spawn ENOEXEC
```

**Solution:** The binary doesn't have execute permissions
```bash
# Fix permissions
chmod +x packages/cli/bin/cloudflared

# Or reinstall
npm uninstall -g nport
npm install -g nport
```

### 522 Connection Timeout
If you see a 522 error in your browser but the tunnel shows as active:

1. **Wait 1-2 minutes** - DNS propagation takes time
2. **Clear DNS cache:**
   ```bash
   # macOS
   sudo dscacheutil -flushcache
   sudo killall -HUP mDNSResponder
   
   # Windows
   ipconfig /flushdns
   
   # Linux
   sudo systemd-resolve --flush-caches
   ```
3. **Hard refresh browser:** `Ctrl+Shift+R` or `Cmd+Shift+R`
4. **Try incognito mode** - Opens a fresh session
5. **Try a different device** - Test from your phone

## Development Setup

If you're contributing to NPort:

```bash
# Clone the repository
git clone https://github.com/tuanngocptn/nport.git
cd nport

# Install dependencies (all packages)
npm install

# Build all packages
npm run build

# Run CLI locally
node packages/cli/dist/index.js 3000 -s test

# Run tests
npm test
```

## Project Structure

```
nport/
├── packages/
│   ├── cli/                 # Main CLI package (TypeScript)
│   │   ├── src/             # Source files
│   │   ├── tests/           # Unit tests
│   │   └── dist/            # Compiled output
│   └── shared/              # Shared types and constants
├── server/                  # Backend (Cloudflare Worker)
└── docs/                    # Documentation
```

## Advanced Usage

### Migrating from ngrok

If you're coming from ngrok, nport works similarly:

```bash
# ngrok
ngrok http 3000

# nport equivalent
nport 3000 --backend https://api.nport.link


# ngrok with custom subdomain
ngrok http 3000 --subdomain my-app

# nport equivalent  
nport 3000 -s my-app --backend https://api.nport.link
```

### Multiple Environments

```bash
# Development
nport --set-backend http://localhost:8787
nport 3000

# Staging
nport --set-backend https://staging-api.nport.link
nport 3000

# Production
nport --set-backend https://api.nport.link
nport 3000
```

### Team Setup

Share the backend configuration command with your team:

```bash
# Everyone runs this once
nport --set-backend https://company-backend.example.com

# Then everyone can use nport normally
nport 3000
```

## Best Practices

### 1. Use Custom Subdomains for Important Demos
```bash
nport 3000 -s client-demo-2026
```
Makes it easier to remember and share.

### 2. Test Locally First
```bash
# Always verify your local server works first
curl http://localhost:3000
```

### 3. Use Descriptive Subdomains
```bash
# Good
nport 3000 -s stripe-webhook-test
nport 3000 -s mobile-app-api

# Avoid
nport 3000 -s test
nport 3000 -s a
```

### 4. Monitor Your Tunnel
Watch the console output for connection status and any errors.

### 5. Clean Up When Done
Always `Ctrl+C` to properly close tunnels and clean up resources.

## Update NPort

Check for updates:
```bash
npm outdated -g nport
```

Update to latest version:
```bash
npm update -g nport
# or
npm install -g nport@latest
```

## Uninstall

```bash
npm uninstall -g nport
```

## Support

- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/tuanngocptn/nport/issues)
- 💬 **Questions**: [GitHub Discussions](https://github.com/tuanngocptn/nport/discussions)
- 🌐 **Website**: https://nport.link
- ☕ **Support Development**: https://buymeacoffee.com/tuanngocptn

## License

MIT License - See [LICENSE](./LICENSE) for details.

---

Made with ❤️ by [@tuanngocptn](https://github.com/tuanngocptn)
