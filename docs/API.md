# NPort API Documentation

> API reference for the NPort backend service

## Table of Contents

- [Overview](#overview)
- [Base URL](#base-url)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [Create Tunnel](#create-tunnel)
  - [Delete Tunnel](#delete-tunnel)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Self-Hosting](#self-hosting)

---

## Overview

The NPort Backend API is a REST-like API that manages Cloudflare Tunnel creation and deletion. It runs as a Cloudflare Worker and communicates with Cloudflare's Tunnel and DNS APIs.

---

## Base URL

| Environment | URL |
|-------------|-----|
| Production | `https://api.nport.link` |
| Custom | Set via `--backend` flag or `NPORT_BACKEND_URL` env var |

---

## Authentication

The public NPort API (`api.nport.link`) does **not** require authentication for creating tunnels. However, if you self-host, you may add your own authentication layer.

---

## Endpoints

### Create Tunnel

Creates a new Cloudflare Tunnel and associated DNS record.

#### Request

```http
POST /
Content-Type: application/json

{
  "subdomain": "myapp"
}
```

#### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subdomain` | string | No | Custom subdomain. If not provided, generates `tun-{timestamp}` |

#### Response (Success)

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "tunnelId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "tunnelToken": "eyJhIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoiLCJ0IjoiYTFiMmMzZDQtZTVmNi03ODkwLWFiY2QtZWYxMjM0NTY3ODkwIiwicyI6Ik5nPT0ifQ==",
  "url": "https://myapp.nport.link"
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` on success |
| `tunnelId` | string | UUID of the created tunnel |
| `tunnelToken` | string | Base64-encoded token for cloudflared |
| `url` | string | Full HTTPS URL of the tunnel |

#### Error Responses

**Subdomain Already In Use (Active Tunnel)**

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "success": false,
  "error": "SUBDOMAIN_IN_USE: Subdomain \"myapp\" is currently in use by an active tunnel."
}
```

**Protected Subdomain**

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "success": false,
  "error": "SUBDOMAIN_PROTECTED: Subdomain \"api\" is reserved and cannot be used. Record already exists."
}
```

---

### Delete Tunnel

Deletes an existing tunnel and its associated DNS record.

#### Request

```http
DELETE /
Content-Type: application/json

{
  "subdomain": "myapp",
  "tunnelId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

#### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subdomain` | string | Yes | Subdomain to delete DNS record for |
| `tunnelId` | string | Yes | Tunnel ID to delete |

#### Response (Success)

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true
}
```

---

## Error Handling

### Error Response Format

All errors follow this structure:

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

### Common Error Codes

| Error Pattern | HTTP Status | Description |
|--------------|-------------|-------------|
| `SUBDOMAIN_IN_USE:` | 500 | Subdomain is being used by an active tunnel |
| `SUBDOMAIN_PROTECTED:` | 500 | Subdomain is reserved (e.g., `api`) |
| `CF API Error:` | 500 | Cloudflare API returned an error |
| `Missing Secrets:` | 400 | Backend misconfiguration |

### Client Error Handling Example

```javascript
try {
  const response = await axios.post(backendUrl, { subdomain });
  
  if (!response.data.success) {
    throw new Error(response.data.error);
  }
  
  return response.data;
} catch (error) {
  if (error.response?.data?.error) {
    const errorMsg = error.response.data.error;
    
    if (errorMsg.includes('SUBDOMAIN_IN_USE:')) {
      // Handle: subdomain is taken by active tunnel
    } else if (errorMsg.includes('SUBDOMAIN_PROTECTED:')) {
      // Handle: subdomain is reserved
    }
  }
  throw error;
}
```

---

## Rate Limiting

The public API (`api.nport.link`) currently has no strict rate limiting, but excessive requests may be throttled by Cloudflare's built-in protections.

**Recommended practices:**
- Don't create more than 10 tunnels per minute
- Always clean up tunnels when done
- Use unique subdomains to avoid conflicts

---

## Self-Hosting

You can deploy your own NPort backend to use a custom domain.

### Prerequisites

1. Cloudflare account with a domain
2. Cloudflare API Token with permissions:
   - Account: Cloudflare Tunnel: Edit
   - Zone: DNS: Edit

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/tuanngocptn/nport.git
   cd nport/server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure secrets:
   ```bash
   wrangler secret put CF_ACCOUNT_ID
   wrangler secret put CF_ZONE_ID
   wrangler secret put CF_DOMAIN
   wrangler secret put CF_API_TOKEN
   ```

4. Deploy:
   ```bash
   npm run deploy
   ```

5. Use your custom backend:
   ```bash
   # One-time use
   nport 3000 -s myapp --backend https://your-worker.workers.dev
   
   # Save permanently
   nport --set-backend https://your-worker.workers.dev
   ```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CF_ACCOUNT_ID` | Yes | Your Cloudflare Account ID |
| `CF_ZONE_ID` | Yes | Zone ID for your domain |
| `CF_DOMAIN` | Yes | Your base domain (e.g., `example.com`) |
| `CF_API_TOKEN` | Yes* | API Token with Tunnel + DNS permissions |
| `CF_EMAIL` | Alt* | Email for API Key auth (alternative) |
| `CF_API_KEY` | Alt* | Global API Key (alternative) |

*Either `CF_API_TOKEN` or (`CF_EMAIL` + `CF_API_KEY`) is required.

---

## Cloudflare API Reference

The backend uses these Cloudflare APIs internally:

- [Cloudflare Tunnels API](https://developers.cloudflare.com/api/operations/cloudflare-tunnel-create-a-cloudflare-tunnel)
- [DNS Records API](https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-create-dns-record)

---

## See Also

- [Architecture Overview](./ARCHITECTURE.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Main README](../README.md)
