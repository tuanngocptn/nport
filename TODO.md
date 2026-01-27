# NPort TODO List

This document tracks planned features, improvements, and known issues for NPort.

## 🎯 High Priority

### Move Time Limit Check to Backend
**Status:** 📋 Planned

**Current Implementation:**
- Time limit (4 hours) is currently managed on the client side
- Client tracks tunnel duration and displays time remaining
- No server-side enforcement of the time limit

**Proposed Implementation:**
- Backend should validate and enforce tunnel time limits
- Store tunnel creation timestamp in Cloudflare (tunnel metadata or KV)
- Backend checks tunnel age during:
  - New tunnel requests (prevent old inactive tunnels from blocking subdomains)
  - Scheduled cleanup job (delete tunnels older than limit)
- Client can still display remaining time, but backend is source of truth

**Benefits:**
- ✅ Centralized time limit enforcement
- ✅ Prevents clients from bypassing time restrictions
- ✅ More reliable cleanup of expired tunnels
- ✅ Easier to modify time limits globally
- ✅ Better resource management

**Technical Details:**
- Add timestamp field when creating tunnel
- Update `handleCreateTunnel()` to check age of existing tunnels
- Update `shouldCleanupTunnel()` to consider tunnel age
- Consider using Cloudflare KV or tunnel metadata for storage

**Files to Modify:**
- `server/src/index.js` - Backend tunnel management
- `packages/cli/src/tunnel.ts` - Client-side time display (optional)

---

## 📝 Documentation

### Update README "Powered by" Section
**Status:** 📋 Planned

**Current Implementation:**
- README only highlights Cloudflare in the powered by section
- Other key technologies and dependencies are not prominently featured

**Proposed Implementation:**
- Add comprehensive "Powered by" section that includes:
  - Cloudflare (Tunnels, DNS, Workers)
  - Node.js runtime
  - npm packages (axios, chalk, ora)
  - Cloudflared binary
  - Any other key dependencies

**Benefits:**
- ✅ Proper attribution to all technologies used
- ✅ Transparency about project dependencies
- ✅ Helps users understand the technology stack
- ✅ Shows appreciation to all projects that make NPort possible

**Files to Modify:**
- `README.md` - Add/update "Powered by" or "Built With" section

**Example Structure:**
```markdown
## 🛠️ Built With

- **[Cloudflare](https://www.cloudflare.com)** - Tunnels, DNS, and Workers
- **[Node.js](https://nodejs.org)** - JavaScript runtime
- **[TypeScript](https://www.typescriptlang.org)** - Type-safe JavaScript
- **[Cloudflared](https://github.com/cloudflare/cloudflared)** - Tunnel client
- **[Axios](https://axios-http.com)** - HTTP client
- **[Chalk](https://github.com/chalk/chalk)** - Terminal styling
- **[Ora](https://github.com/sindresorhus/ora)** - Terminal spinners
```

---

## 🚀 Future Enhancements

### Track Terminal Link Clicks
**Status:** 💡 Idea

**Current Implementation:**
- Links are displayed in terminal (tunnel URL, GitHub, Buy Me a Coffee)
- No tracking when users click on these links
- No visibility into user engagement with displayed links

**Proposed Implementation:**
- Add click tracking for links displayed in terminal output
- Track clicks on:
  - Generated tunnel URL (`https://subdomain.nport.link`)
  - GitHub repository link
  - Buy Me a Coffee link
  - Any other clickable links in terminal
- Options to consider:
  - Use UTM parameters for link tracking
  - Create short redirect URLs through analytics service
  - Add optional telemetry with user consent
  - Track via existing analytics system

**Benefits:**
- ✅ Understand which links users interact with
- ✅ Measure tunnel URL usage and sharing
- ✅ Track conversion to GitHub stars and donations
- ✅ Better insight into user behavior
- ✅ Help prioritize features based on engagement

**Technical Details:**
- Modern terminals support clickable links (OSC 8 hyperlinks)
- Could wrap URLs with tracking parameters
- Respect user privacy - make tracking opt-in/opt-out
- Consider GDPR and privacy implications
- Update analytics configuration

**Privacy Considerations:**
- Make tracking optional and transparent
- Include in existing analytics opt-out system
- Don't track sensitive information
- Document what is tracked in privacy policy

**Files to Modify:**
- `packages/cli/src/ui.ts` - Terminal output and link formatting
- `packages/cli/src/analytics.ts` - Analytics tracking system
- `README.md` - Document privacy policy

---

### Coming Soon
- [ ] Rate limiting per IP/subdomain
- [ ] Tunnel analytics and metrics
- [ ] Custom domain support
- [ ] Tunnel password protection
- [ ] API key authentication

### Ideas Under Consideration
- [ ] WebUI for tunnel management
- [ ] Multiple port forwarding
- [ ] Traffic inspection and logging
- [ ] Subdomain reservation system
- [ ] Premium tier with longer tunnel duration

---

## 🐛 Known Issues

### Minor Issues
- None currently reported

---

## ✅ Completed

### v2.1.0 (TypeScript Migration)
- ✅ Migrated CLI from JavaScript to TypeScript
- ✅ Created monorepo structure with npm workspaces
- ✅ Added shared types package (@nport/shared)
- ✅ Added unit tests with Vitest
- ✅ Updated documentation for new structure
- ✅ Added AI context files (.ai/context.md, .cursorrules)

### v2.0.7
- ✅ Protected subdomains (prevent deletion of critical services)
- ✅ Smart network warning system
- ✅ QUIC error filtering
- ✅ Multilingual support (EN/VI)

### v2.0.6
- ✅ Backend URL configuration
- ✅ Unified configuration system
- ✅ Environment variable support

---

## 📝 Notes

- Keep this file updated as tasks are completed
- Link related GitHub issues when applicable
- Break down large features into smaller tasks
- Prioritize based on user feedback and impact

---

Last updated: 2026-01-20
