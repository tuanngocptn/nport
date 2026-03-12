# <img src="https://nport.link/assets/imgs/nport-logo.png" height="30" style="vertical-align: middle;"> NPort

> 🚀 Free & open source ngrok alternative - Tunnel localhost to the internet via Cloudflare Edge

[![GitHub](https://img.shields.io/github/stars/tuanngocptn/nport?style=social)](https://github.com/tuanngocptn/nport)
[![NPM](https://img.shields.io/npm/v/nport?color=red&logo=npm)](https://www.npmjs.com/package/nport)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fnport.link&up_message=nport.link&up_color=blue&down_color=lightgrey&down_message=offline)](https://nport.link)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

## What is NPort?

[![nport](https://github.com/user-attachments/assets/809634a9-5396-46da-919d-b642ddf48fd1)](https://nport.link)

NPort is a powerful, lightweight **ngrok alternative** that creates secure HTTP/HTTPS tunnels from your localhost to public URLs using **Cloudflare's global edge network**. No configuration, no accounts, just instant tunnels with custom subdomains!

Perfect for:
- 🚀 **Development environments** - Share your local work instantly
- 🔒 **Testing webhooks** - Receive webhooks from GitHub, Stripe, PayPal, etc.
- 📱 **Mobile testing** - Test your web app on real devices
- 🛠️ **API development** - Debug integrations with external services
- 👥 **Demo to clients** - Show your progress without deployment

## ✨ Features

- ⚡ **Instant Setup**: One command to expose your localhost
- 🌐 **Custom Subdomains**: Choose your own URL (e.g., `myapp.nport.link`)
- 🔒 **Automatic HTTPS**: SSL/TLS encryption via Cloudflare
- 🌍 **Global Edge Network**: Fast connections worldwide via Cloudflare
- 📡 **WebSocket Support**: Full WebSocket and Server-Sent Events support
- 🎯 **No Configuration**: Works out of the box
- 💻 **Cross-Platform**: Windows, macOS, and Linux support
- 🗣️ **Multilingual**: English and Vietnamese UI support
- 🆓 **100% Free**: No accounts, no limits, no paywalls
- 🔓 **Open Source**: MIT licensed

## 📦 Installation

### Requirements

- **Node.js** >= 20.0.0
- **npm** >= 10.0.0

Check your versions:
```bash
node --version
npm --version
```

### NPM (Recommended)

```bash
# Global installation
npm install -g nport

# Or use npx without installation
npx nport 3000 -s myapp
```

### From GitHub

```bash
npm install -g git+https://github.com/tuanngocptn/nport.git
```

## 🚀 Quick Start

### Basic Usage

Expose port 3000 with a random subdomain:
```bash
nport 3000
```

Output:
```
 ╭────────────────────────────────────────────────────────╮
 │  N P O R T  ⚡️  Free & Open Source from Vietnam        │
 ╰────────────────────────────────────────────────────────╯

⠋ Creating tunnel for port 3000...
   🚀 WE LIVE BABY!
   
   👉  https://user-1234.nport.link  👈
   
   ───────────────────────────────────────────────────────
   
   ⏱️  Time:     4h remaining
   
   ✔ [1/2] Connection established...
   ✔ [2/2] Compression enabled...
   
   ───────────────────────────────────────────────────────
   
   🔥 KEEP THE VIBE ALIVE?
      (Made with ❤️ in Vietnam)

   ⭐️  Drop a Star:   https://github.com/tuanngocptn/nport
   ☕️  Buy Coffee:    https://buymeacoffee.com/tuanngocptn
```

### Custom Subdomain

Choose your own subdomain:
```bash
nport 3000 -s myapp
# Creates: https://myapp.nport.link
```

Or using long form:
```bash
nport 3000 --subdomain myapp
```

## 📖 Usage Examples

### Web Development

```bash
# Next.js
npm run dev
nport 3000 -s my-nextjs-app

# React (Create React App)
npm start
nport 3000 -s my-react-app

# Vue.js
npm run dev
nport 8080 -s my-vue-app

# Express.js
node server.js
nport 3000 -s my-api
```

### Webhook Testing

```bash
# Start your local webhook receiver
node webhook-receiver.js

# Expose it to the internet
nport 4000 -s my-webhooks

# Use in GitHub webhook settings:
# https://my-webhooks.nport.link/webhook
```

### Mobile Device Testing

```bash
# Start your local dev server
npm run dev

# Create tunnel
nport 3000 -s mobile-test

# Open on your phone:
# https://mobile-test.nport.link
```

## 🎯 CLI Options

```bash
nport <port> [options]
```

| Option | Short | Description | Example |
|--------|-------|-------------|---------|
| `<port>` | - | Local port to tunnel (default: 8080) | `nport 3000` |
| `--subdomain` | `-s` | Custom subdomain | `nport 3000 -s myapp` |
| `--backend` | `-b` | Custom backend URL (temporary) | `nport 3000 -b https://your-backend.com` |
| `--set-backend` | - | Save backend URL permanently | `nport --set-backend https://your-backend.com` |
| `--language` | `-l` | Set language (en/vi) or prompt | `nport 3000 -l vi` |
| `--version` | `-v` | Show version information | `nport -v` |

### Language Options

NPort supports multiple languages with automatic detection on first run.

```bash
# Set language directly
nport 3000 --language en    # English
nport 3000 -l vi            # Vietnamese

# Open language selection menu
nport --language            # Interactive prompt
nport -l                    # Interactive prompt
```

On first run or when using `--language` without a value, you'll see an interactive language picker. Your choice is automatically saved for future sessions.

### Backend URL Options

NPort uses a default backend at `https://api.nport.link`, but you can use your own backend server.

#### Temporary Backend (One-time Use)

Use a custom backend for just the current session:

```bash
# Use custom backend via CLI flag
nport 3000 --backend https://your-backend.com
nport 3000 -b https://your-backend.com

# Use custom backend via environment variable
export NPORT_BACKEND_URL=https://your-backend.com
nport 3000

# Combine with other options
nport 3000 -s myapp -b https://your-backend.com
```

#### Persistent Backend (Saved Configuration)

Save a backend URL to use automatically in all future sessions:

```bash
# Save backend URL permanently
nport --set-backend https://your-backend.com

# Now all future commands will use this backend
nport 3000              # Uses saved backend
nport 3000 -s myapp     # Uses saved backend

# Clear saved backend (return to default)
nport --set-backend

# Override saved backend temporarily
nport 3000 -b https://different-backend.com
```

**Configuration Priority:**
1. CLI flag (`--backend` or `-b`) - Highest priority
2. Saved config (`--set-backend`)
3. Environment variable (`NPORT_BACKEND_URL`)
4. Default (`https://api.nport.link`) - Lowest priority

**Configuration Storage:**
Your backend preference is saved in `~/.nport/config.json`

This is useful if you want to:
- **Self-host**: Run your own NPort backend (see [server/](server/) directory)
- **Development**: Test against a local backend
- **Custom domains**: Use your own domain for tunnel URLs
- **Enterprise**: Use a company-hosted backend server

### Version Information

```bash
# Check current version and updates
nport -v
nport --version
```

## 🔧 How It Works

1. **You run** `nport 3000 -s myapp`
2. **NPort creates** a Cloudflare Tunnel
3. **DNS record** is created: `myapp.nport.link` → Cloudflare Edge
4. **Cloudflared binary** connects your localhost:3000 to Cloudflare
5. **Traffic flows** through Cloudflare's global network to your machine
6. **On exit** (Ctrl+C), tunnel and DNS are automatically cleaned up

```
Internet → Cloudflare Edge → Cloudflare Tunnel → Your localhost:3000
         (https://myapp.nport.link)
```

## 🏗️ Project Structure

```
nport/
├── src/                         # TypeScript source files
│   ├── index.ts                 # Entry point
│   ├── tunnel.ts                # Tunnel orchestration
│   ├── api.ts                   # Backend API client
│   ├── args.ts                  # CLI argument parser
│   ├── binary.ts                # Cloudflared process manager
│   ├── ui.ts                    # Console UI components
│   ├── lang.ts                  # Multilingual support
│   ├── types/                   # TypeScript type definitions
│   └── ...
│
├── tests/                       # Unit tests (vitest)
├── dist/                        # Compiled output
├── bin/                         # cloudflared binary (downloaded)
│
├── server/                      # Backend (Cloudflare Worker)
├── website/                     # Static landing page
├── docs/                        # Documentation
│   ├── ARCHITECTURE.md          # Technical architecture
│   ├── API.md                   # API reference
│   └── CONTRIBUTING.md          # Contribution guide
└── .ai/                         # AI context files
```

## 🛡️ Security

- **HTTPS by default**: All tunnels use SSL/TLS encryption
- **Cloudflare protection**: DDoS protection and security features
- **Automatic cleanup**: Tunnels are removed when you stop the process
- **No data logging**: We don't store or log your traffic
- **Privacy**: Anonymous analytics (can be disabled with `NPORT_ANALYTICS=false`)

## 🆚 Comparison with ngrok

| Feature | NPort | ngrok |
|---------|-------|-------|
| Price | 100% Free | Free tier limited |
| Custom subdomains | ✅ Always | ❌ Paid only |
| HTTPS | ✅ Always | ✅ |
| Account required | ❌ No | ✅ Yes |
| Time limits | ❌ None (4h auto-cleanup) | ⚠️ Free tier limited |
| Open source | ✅ MIT | ❌ Proprietary |
| Global network | ✅ Cloudflare | ✅ ngrok Edge |
| Multilingual | ✅ EN/VI | ❌ English only |

## 🧹 Cleanup

NPort automatically cleans up resources when you:
- Press **Ctrl+C** to exit
- Kill the process
- Terminal closes

The cleanup process:
1. ✅ Deletes DNS record (`myapp.nport.link`)
2. ✅ Removes Cloudflare Tunnel
3. ✅ Stops cloudflared process

Tunnels also auto-cleanup after **4 hours** to prevent resource waste.

## 🐛 Troubleshooting

### Binary not found

If you see "Cloudflared binary not found":
```bash
npm install -g nport --force
```

### Port already in use

Make sure your local server is running on the specified port:
```bash
# Check if something is listening on port 3000
lsof -i :3000  # macOS/Linux
netstat -ano | findstr :3000  # Windows
```

### Subdomain already taken

Choose a different subdomain name:
```bash
nport 3000 -s myapp-v2
```

### Connection issues

The `ERR Cannot determine default origin certificate path` warning is harmless and can be ignored. It appears because cloudflared checks for certificate-based authentication (we use token-based instead).

### Change language

To change your language preference:
```bash
nport --language
# or
nport -l
```

Then select your preferred language from the menu.

## 🌍 Supported Languages

- 🇺🇸 **English** (`en`) - Default
- 🇻🇳 **Vietnamese** (`vi`) - Tiếng Việt

Want to add your language? Contributions are welcome! Check out the [Contributing Guide](docs/CONTRIBUTING.md).

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed guidelines.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/tuanngocptn/nport.git
cd nport

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run CLI locally
node dist/index.js 3000 -s test
```

## 💖 Support

If you find NPort useful, please consider supporting the project:

- ⭐ [Star on GitHub](https://github.com/tuanngocptn/nport)
- ☕ [Buy me a coffee](https://buymeacoffee.com/tuanngocptn)
- 💬 Share with your friends and colleagues
- 🐛 [Report bugs](https://github.com/tuanngocptn/nport/issues)
- 🌍 [Add translations](docs/CONTRIBUTING.md#adding-translations)

## 📄 License

[MIT License](LICENSE) - Feel free to use NPort in your projects!

## 🙏 Credits

- Created by [Nick Pham](https://github.com/tuanngocptn) from Vietnam
- Inspired by [ngrok](https://ngrok.com) and [localtunnel](https://github.com/localtunnel/localtunnel)
- Powered by [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)

   <a href="https://www.cloudflare.com" target="_blank">
      <img src="https://nport.link/assets/webp/cloudflare-logo-black.webp" alt="Cloudflare" height="60">
   </a>

## 🔗 Links

- 🌐 Website: [https://nport.link](https://nport.link)
- 📦 NPM: [https://www.npmjs.com/package/nport](https://www.npmjs.com/package/nport)
- 💻 GitHub: [https://github.com/tuanngocptn/nport](https://github.com/tuanngocptn/nport)
- 📧 Email: tuanngocptn@gmail.com

---

Made with ❤️ in Vietnam by [Nick Pham](https://github.com/tuanngocptn)
