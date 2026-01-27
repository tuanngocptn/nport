# NPort Server (Cloudflare Worker)

Backend API server for NPort tunnel management, deployed as a Cloudflare Worker.

## What's New in v1.1.0

🎉 **TypeScript Migration:**
- ✅ Migrated entire codebase to TypeScript for better type safety
- ✅ Added comprehensive type definitions for all API responses
- ✅ Improved error handling with typed exceptions
- ✅ Updated tests to TypeScript
- ✅ Added TypeScript compiler checks in CI

See [CHANGELOG.md](./CHANGELOG.md) for full details.

## Features

- 🚀 Creates and manages Cloudflare Tunnels via API
- 🌐 Automatically configures DNS records (supports A, AAAA, and CNAME records)
- 🧹 Auto-cleanup of inactive tunnels via cron job (every 30 minutes)
- 🔒 Secure authentication using Cloudflare credentials (API Token or API Key)
- 🛠️ Automatic orphaned DNS record cleanup
- ✅ Smart conflict resolution for existing tunnels and DNS records
- 📝 Full TypeScript support with type definitions

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20.0.0
- [Cloudflare Account](https://dash.cloudflare.com/sign-up)
- A domain managed by Cloudflare

## Project Structure

```
server/
├── src/
│   └── index.ts          # Main worker code (TypeScript)
├── test/
│   └── index.spec.ts     # Tests (TypeScript)
├── .dev.vars             # Local environment variables (DO NOT COMMIT)
├── .dev.vars.example     # Example environment variables
├── wrangler.jsonc        # Cloudflare Worker configuration
├── tsconfig.json         # TypeScript configuration
├── vitest.config.ts      # Test configuration
└── package.json          # Dependencies
```

## Setup Guide

### Step 1: Get Your Cloudflare Credentials

#### 1.1 Account ID
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select any website/domain
3. Scroll down on the **Overview** page
4. Copy **Account ID** from the right sidebar

#### 1.2 Zone ID
1. Go to your domain's dashboard in Cloudflare
2. Click on your domain (e.g., `nport.link`)
3. Scroll down on the **Overview** page
4. Copy **Zone ID** from the right sidebar

#### 1.3 Authentication Credentials (Choose ONE method)

**Option A: API Token (Recommended)** 🌟

API Tokens are more secure and have granular permissions.

1. Go to [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Choose **Edit Cloudflare Workers** template (or create custom token)
4. Add the following permissions:
   - **Account** → **Cloudflare Tunnel** → **Edit**
   - **Zone** → **DNS** → **Edit**
5. Set **Zone Resources** to include your domain
6. Click **Continue to summary** → **Create Token**
7. Copy the token (you won't see it again!)

**Option B: Global API Key (Legacy)**

1. Go to [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Scroll down to **API Keys** section
3. Click **View** next to "Global API Key"
4. Enter your password to reveal the key
5. Copy the API Key
6. You'll also need your Cloudflare account email address

⚠️ **Important**: Keep your credentials secure. Never commit them to git.

### Step 2: Install Dependencies

```bash
cd server
npm install
```

### Step 3: Configure Environment Variables

#### For Local Development:

Copy the example file:
```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your values:

**Option A: Using API Token (Recommended):**
```bash
CF_API_TOKEN=your_api_token_here
CF_ACCOUNT_ID=your_account_id_here
CF_ZONE_ID=your_zone_id_here
CF_DOMAIN=your_domain_here
```

**Option B: Using Global API Key (Legacy):**
```bash
CF_EMAIL=your-cloudflare-email@example.com
CF_API_KEY=your_global_api_key_here
CF_ACCOUNT_ID=your_account_id_here
CF_ZONE_ID=your_zone_id_here
CF_DOMAIN=your_domain_here
```

### Step 4: Test Locally

Start the development server:
```bash
npm run dev
```

The server will be available at `http://localhost:8787`

Test the API:
```bash
# Create a tunnel
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"test-123"}'

# Delete a tunnel
curl -X DELETE http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"test-123","tunnelId":"your-tunnel-id"}'
```

### Step 5: Deploy to Cloudflare Workers

```bash
npm run deploy
```

### Step 6: Set Production Secrets

After deploying, set the secrets in production:

```bash
# Set API Token
wrangler secret put CF_API_TOKEN

# Set Account ID
wrangler secret put CF_ACCOUNT_ID

# Set Zone ID
wrangler secret put CF_ZONE_ID

# Set Domain
wrangler secret put CF_DOMAIN
```

Verify secrets are set:
```bash
wrangler secret list
```

### Step 7: Configure Custom Domain (Optional)

If you want to use a custom domain like `api.nport.link`:

1. Go to your [Cloudflare Workers Dashboard](https://dash.cloudflare.com)
2. Click on your **nport** worker
3. Go to **Settings** → **Triggers**
4. Click **Add Custom Domain**
5. Enter your subdomain (e.g., `api.nport.link`)
6. Click **Add Custom Domain**

## API Endpoints

### `POST /`
Creates a new tunnel with optional custom subdomain.

**Request:**
```bash
curl -X POST https://api.nport.link \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"my-app"}'
```

**Response:**
```json
{
  "success": true,
  "tunnelId": "abc123-def456-...",
  "tunnelToken": "eyJh...",
  "url": "https://my-app.nport.link"
}
```

### `DELETE /`
Deletes an existing tunnel and its DNS record.

**Request:**
```bash
curl -X DELETE https://api.nport.link \
  -H "Content-Type: application/json" \
  -d '{
    "subdomain": "my-app",
    "tunnelId": "abc123-def456-..."
  }'
```

**Response:**
```json
{
  "success": true
}
```

### `GET /`
Redirects to `https://nport.link`

## Cron Job (Auto-Cleanup)

The worker includes a scheduled job that runs **every 30 minutes** to clean up inactive tunnels.

Configuration in `wrangler.jsonc`:
```json
{
  "triggers": {
    "crons": ["*/30 * * * *"]
  }
}
```

### How it works:
1. Finds all tunnels with status `down`, `inactive`, or `degraded`
2. Deletes associated DNS records
3. Removes the tunnels

### Customizing cleanup:
Edit the `CLEANUP_PREFIXES` constant in `src/index.ts`:

```typescript
// Clean up all tunnels (except protected ones)
const CLEANUP_PREFIXES: string[] = [];

// Or clean up only specific prefixes
const CLEANUP_PREFIXES: string[] = ['user-', 'temp-', 'test-'];
```

### Protected Subdomains:
Edit the `PROTECTED_SUBDOMAINS` constant to prevent certain subdomains from being created or cleaned up:

```typescript
const PROTECTED_SUBDOMAINS: string[] = ['api', 'www', 'admin'];
```

## Development Commands

```bash
# Install dependencies
npm install

# Run local development server
npm run dev

# Run TypeScript type checking
npm run typecheck

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Deploy to production
npm run deploy

# View live logs
wrangler tail

# List secrets
wrangler secret list
```

## Type Definitions

The server includes comprehensive TypeScript types:

```typescript
// Environment variables
interface Env {
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_DOMAIN: string;
  CF_API_TOKEN?: string;
  CF_EMAIL?: string;
  CF_API_KEY?: string;
}

// API responses
interface ApiResponse {
  success: boolean;
  error?: string;
  tunnelId?: string;
  tunnelToken?: string;
  url?: string;
}

// Tunnel status
interface Tunnel {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'inactive';
  token?: string;
}
```

## Monitoring & Debugging

### View Live Logs
```bash
wrangler tail
```

### View Logs in Dashboard
1. Go to [Cloudflare Workers Dashboard](https://dash.cloudflare.com)
2. Click on your **nport** worker
3. Go to **Logs** tab
4. Enable **Real-time logs**

### Common Issues

#### "Missing Secrets" Error
- **Problem**: Environment variables not set in production
- **Solution**: Run `wrangler secret put` for each required variable

#### "[10001] Unable to authenticate request"
- **Problem**: Invalid or missing authentication credentials
- **Solutions**:
  - Verify your API Token or API Key is correct
  - Check that all required secrets are set: `wrangler secret list`
  - If using API Token, ensure it has the correct permissions

#### Tunnel Creation Fails with "SUBDOMAIN_IN_USE"
- **Problem**: A tunnel with the same name is currently active
- **Solution**: Choose a different subdomain or wait for the existing tunnel to disconnect

#### Tunnel Creation Fails with "SUBDOMAIN_PROTECTED"
- **Problem**: The subdomain is in the protected list
- **Solution**: Choose a different subdomain

## Security Notes

⚠️ **Important Security Practices:**

1. **Never commit** `.dev.vars` to git (it's in `.gitignore`)
2. **Use API Tokens** instead of Global API Key when possible
3. **Use secrets** for production (via `wrangler secret put`)
4. **Rotate keys** regularly if you suspect they've been compromised
5. **Monitor usage** - Regularly check Cloudflare audit logs

## Support & Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Tunnels Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/)
- [NPort GitHub](https://github.com/tuanngocptn/nport)

## License

MIT
