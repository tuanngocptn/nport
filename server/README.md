# NPort Server (Cloudflare Worker)

Backend API server for NPort tunnel management, deployed as a Cloudflare Worker.

## What's New in v1.0.1

🎉 **Major Improvements:**
- ✅ Added support for **API Token authentication** (recommended over API Key)
- ✅ Fixed DNS record conflict error `[#81053]` - now automatically detects and cleans up orphaned DNS records
- ✅ Enhanced DNS record detection to check for A, AAAA, and CNAME records (not just CNAME)
- ✅ Improved error handling for Cloudflare API authentication issues
- ✅ Better validation of environment variables and credentials

See [CHANGELOG.md](./CHANGELOG.md) for full details.

## Features

- 🚀 Creates and manages Cloudflare Tunnels via API
- 🌐 Automatically configures DNS records (supports A, AAAA, and CNAME records)
- 🧹 Auto-cleanup of inactive tunnels via cron job (every 30 minutes)
- 🔒 Secure authentication using Cloudflare credentials (API Token or API Key)
- 🛠️ Automatic orphaned DNS record cleanup
- ✅ Smart conflict resolution for existing tunnels and DNS records

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0
- [Cloudflare Account](https://dash.cloudflare.com/sign-up)
- A domain managed by Cloudflare

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

**Example with API Token:**
```bash
CF_API_TOKEN=abc123def456ghi789jkl012mno345pqr678stu
CF_ACCOUNT_ID=40f40ad7644468d2f786a6674319dc50
CF_ZONE_ID=f693c43670e6992ffb63cefe86c87135
CF_DOMAIN=nport.link
```

### Step 4: Test Locally

Start the development server:
```bash
npm run dev
# or
wrangler dev
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
# or
wrangler deploy
```

You should see output like:
```
Total Upload: xx.xx KiB / gzip: xx.xx KiB
Uploaded nport (x.xx sec)
Published nport (x.xx sec)
  https://nport.your-account.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 6: Set Production Secrets

After deploying, set the secrets in production.

**Option A: Using API Token (Recommended):**

```bash
# Set API Token
wrangler secret put CF_API_TOKEN
# When prompted, paste your API Token

# Set Account ID
wrangler secret put CF_ACCOUNT_ID
# When prompted, paste your Account ID

# Set Zone ID
wrangler secret put CF_ZONE_ID
# When prompted, paste your Zone ID

# Set Domain
wrangler secret put CF_DOMAIN
# When prompted, paste your domain (e.g., nport.link)
```

**Option B: Using Global API Key (Legacy):**

```bash
# Set Email
wrangler secret put CF_EMAIL
# When prompted, paste: your-cloudflare-email@example.com

# Set API Key
wrangler secret put CF_API_KEY
# When prompted, paste your Global API Key

# Set Account ID
wrangler secret put CF_ACCOUNT_ID
# When prompted, paste your Account ID

# Set Zone ID
wrangler secret put CF_ZONE_ID
# When prompted, paste your Zone ID

# Set Domain
wrangler secret put CF_DOMAIN
# When prompted, paste your domain (e.g., nport.link)
```

Verify secrets are set:
```bash
wrangler secret list
```

**With API Token:**
```json
[
  {"name": "CF_ACCOUNT_ID", "type": "secret_text"},
  {"name": "CF_API_TOKEN", "type": "secret_text"},
  {"name": "CF_DOMAIN", "type": "secret_text"},
  {"name": "CF_ZONE_ID", "type": "secret_text"}
]
```

**With API Key:**
```json
[
  {"name": "CF_ACCOUNT_ID", "type": "secret_text"},
  {"name": "CF_API_KEY", "type": "secret_text"},
  {"name": "CF_DOMAIN", "type": "secret_text"},
  {"name": "CF_EMAIL", "type": "secret_text"},
  {"name": "CF_ZONE_ID", "type": "secret_text"}
]
```

### Step 7: Configure Custom Domain (Optional)

If you want to use a custom domain like `api.nport.link`:

1. Go to your [Cloudflare Workers Dashboard](https://dash.cloudflare.com)
2. Click on your **nport** worker
3. Go to **Settings** → **Triggers**
4. Click **Add Custom Domain**
5. Enter your subdomain (e.g., `api.nport.link`)
6. Click **Add Custom Domain**

Your API will now be available at `https://api.nport.link`

## API Endpoints

### `POST /`
Creates a new tunnel with optional custom subdomain.

**Request:**
```bash
curl -X POST https://nport.your-account.workers.dev \
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
curl -X DELETE https://nport.your-account.workers.dev \
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
    "crons": ["0/30 0 * * *"]
  }
}
```

### How it works:
1. Finds all tunnels with status `down`
2. Deletes associated DNS records
3. Removes the tunnels

### Customizing cleanup:
Edit the `CLEANUP_PREFIXES` constant in `src/index.js`:

```javascript
// Clean up all tunnels
const CLEANUP_PREFIXES = [];

// Or clean up only specific prefixes
const CLEANUP_PREFIXES = ['user-', 'temp-', 'test-'];
```

## Development Commands

```bash
# Install dependencies
npm install

# Run local development server
npm run dev
# or
wrangler dev

# Deploy to production
npm run deploy
# or
wrangler deploy

# View live logs
wrangler tail

# List secrets
wrangler secret list

# Run tests
npm test
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
  - If using API Token, ensure it has the correct permissions (Cloudflare Tunnel Edit + DNS Edit)
  - Try re-creating your API Token with proper permissions
  - Switch from API Key to API Token (recommended)

#### "[81053] An A, AAAA, or CNAME record with that host already exists"
- **Problem**: DNS record already exists (usually orphaned from previous tunnel)
- **Solution**: The worker now automatically detects and cleans up orphaned DNS records (v1.0.1+)
- **Manual Fix**: Delete the DNS record from Cloudflare Dashboard → DNS → Records

#### Tunnel Creation Fails with "SUBDOMAIN_IN_USE"
- **Problem**: A tunnel with the same name is currently active
- **Solution**: Choose a different subdomain or wait for the existing tunnel to disconnect

#### DNS Record Not Created
- **Problem**: API credentials don't have DNS edit permissions
- **Solutions**:
  - Using API Token: Ensure it has **Zone → DNS → Edit** permission
  - Using API Key: Make sure you're using the Global API Key (not a scoped API token)

#### 401 Unauthorized
- **Problem**: Invalid email or API key
- **Solution**: Double-check your credentials are correct

## Project Structure

```
server/
├── src/
│   └── index.js          # Main worker code
├── test/
│   └── index.spec.js     # Tests
├── .dev.vars             # Local environment variables (DO NOT COMMIT)
├── .dev.vars.example     # Example environment variables
├── wrangler.jsonc        # Cloudflare Worker configuration
├── vitest.config.js      # Test configuration
└── package.json          # Dependencies
```

## Security Notes

⚠️ **Important Security Practices:**

1. **Never commit** `.dev.vars` to git (it's in `.gitignore`)
2. **Use API Tokens** instead of Global API Key when possible (more secure, granular permissions)
3. **Global API Key** has full access to your account - keep it extremely secure
4. **Use secrets** for production (via `wrangler secret put`)
5. **Rotate keys** regularly if you suspect they've been compromised
6. **Limit access** - only share credentials with trusted team members
7. **Monitor usage** - Regularly check Cloudflare audit logs for suspicious activity

## Updating the Worker

When you make changes to the code:

```bash
# 1. Test locally
wrangler dev

# 2. Deploy to production
wrangler deploy

# 3. Monitor logs to ensure everything works
wrangler tail
```

## Support & Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Tunnels Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/)
- [NPort GitHub](https://github.com/tuanngocptn/nport)

## License

MIT

