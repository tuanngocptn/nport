# 🌶️ NPort

> A Node.js tool for exposing local servers through Socket.IO tunnels

[![GitHub](https://img.shields.io/github/stars/tuanngocptn/nport?style=social)](https://github.com/tuanngocptn/nport)
[![NPM](https://img.shields.io/npm/v/nport?color=red&logo=npm)](https://www.npmjs.com/package/nport)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fnport.link&up_message=nport.link&up_color=blue&down_color=lightgrey&down_message=offline)](https://nport.link)

## What is NPort?

NPort allows you to expose your local HTTP servers to the internet using Socket.IO streams. Perfect for:
- Development environments
- Testing webhooks
- Sharing local projects

## ✨ Features

- 🔒 **Secure Tunneling**: Share your local server safely using Socket.IO
- 🚀 **Easy Setup**: Minimal configuration required
- 🌐 **Custom Domains**: Get readable URLs like `https://yourname.nport.link`
- 📡 **WebSocket Ready**: Full WebSocket connection support
- 💻 **Cross-Platform**: Runs on Windows, macOS, and Linux

## 📦 Installation

**NPM Package**
```bash
# Local installation
npm install nport

# Global installation
npm install -g nport
```

**From GitHub**
```bash
# Local installation
npm install git+https://github.com/tuanngocptn/nport.git

# Global installation
npm install -g git+https://github.com/tuanngocptn/nport.git
```

## 🚀 Quick Start

### Basic Usage
```bash
# Local installation
npx nport -s myapp -p 3000

# Global installation
nport -s myapp -p 3000
```
This will create a tunnel at `https://myapp.nport.link`

### Advanced Options
```bash
# Full configuration
npx nport --server https://server.nport.link \
         --subdomain myapp \
         --hostname 127.0.0.1 \
         --port 3000
```

## 📝 Credits
Inspired by [Socket Tunnel](https://github.com/ericbarch/socket-tunnel). Read more about the concept in this [blog post](https://ericbarch.com/post/sockettunnel/).
