# NPort Desktop — Feature Backlog

Everything the design implies, grouped by area. Checkboxes are unbuilt unless noted.
Design source: `docs/mockup/NPort Desktop.dc.html`. Marketing site: `docs/mockup/NPort Site.dc.html`.

**This is an inventory, not a plan.** `docs/ROADMAP.md` assigns every area below to a phase and says
which are blocked and why. Nothing here is scheduled by being listed here.

**Architecture:** a **registry** holds the list of **nodes**. Each node is an independent Cloudflare
account with its own domain and its own quota. The registry never carries traffic — it health-checks
nodes, collects their quotas, and serves the list to the desktop app and CLI, which pick the best
node with a free slot. ADR-0031.

> **Naming.** The design calls these "control plane" and "relay node"; the repo calls them
> **registry** and **node** (ADR-0031). The rename is not cosmetic: `control plane` already means
> `apps/api` everywhere in this repo — `docs/API.md` is literally titled "Control-plane API" — so
> reusing it for the registry would break every existing reference. `relay` is also misleading:
> a node provisions tunnels, it does not relay their traffic.

---

## 1. Registry (the design's "control plane")

- [ ] Node registry: register, deregister, authenticate a node
- [ ] Node self-registration — a new node announces its API domain and credentials
- [ ] Health checks on an interval; mark up / degraded / down
- [ ] Collect per-node quota (plan tier, capacity, current usage)
- [ ] Serve the node list to clients, sorted and filterable
- [ ] Latency hints — either client-measured or edge-region derived
- [ ] Node selection policy: fastest with free capacity, with a documented tie-break
- [ ] Failover when the chosen node dies mid-session
- [ ] Private nodes — visible only to their owner
- [ ] ~~Prevent a rogue node from registering and intercepting traffic (signed registration)~~ — **conflicts with ADR-0031**, which chose open anonymous enrolment and decided to *document* the interception exposure rather than defend against it. Open question 6 reopens it. One of the two has to give; see below
- [ ] Never proxy tunnel traffic, and keep the registry cheap. Note it cannot be *stateless*: the node list is mutable shared state and therefore a Durable Object (`apps/api/CLAUDE.md` rule 4)
- [ ] Public status page fed by the same health data

## 2. Node (the design's "relay node")

- [x] Runs against one Cloudflare account — **`apps/api` already is this**, unchanged
- [ ] Reads its own plan and quota
- [ ] Registers with the registry on boot, heartbeats thereafter
- [ ] Reports capacity, usage, version, region
- [x] Provisions and tears down tunnels on request — **built in 2a**
- [x] Owns its subdomain registry and enforces its own cap — **built in 2a**, `Registry` DO
- [ ] Graceful drain — refuse new tunnels, keep existing ones alive
- [x] Self-host packaging, documented — **`docs/SELF_HOSTING.md`**; one-command deploy is Deferred
- [ ] Node operator dashboard or CLI (usage, logs, health)

## 3. Node selection in the client

- [x] Nodes screen: registry with region, latency, plan tier, usage, health — **designed**
- [x] Node picker on New Tunnel with Automatic + manual pin — **designed**
- [x] Full and offline nodes disabled, not hidden — **designed**
- [x] Aggregate network capacity meter in the sidebar — **designed**
- [x] Tunnel cards name their node — **designed**
- [ ] Real latency measurement from the client, not a static number
- [ ] Re-check all — actually ping each node
- [ ] Remember the last-used node across launches
- [ ] Handle the list changing while New Tunnel is open
- [ ] Empty state: no nodes reachable at all
- [ ] **Decide the URL scheme.** Both options in the design may be unbuildable — see Open questions

## 4. Core tunnel engine

- [x] Start a tunnel: bind `host:port` → request subdomain → open the tunnel — **built in 2b**
- [x] Stop a tunnel, release the subdomain, tear down the connection — **built in 2b**
- [ ] Enforce the node's quota; block Start when it is full
- [x] Duplicate-subdomain guard, with the label and the action agreeing — **designed**
- [x] 4-hour lifetime, server-owned; auto-cleanup on expiry — **built in 2a**, alarm-driven
- [ ] Countdown timer, persisted so restarts don't lose the clock. Display only — the server owns the clock (invariant 3)
- [x] Reconnect on network change / laptop wake without dropping the subdomain — **built in 2b**
- [x] Detect the local target being down — **built in 2b**, `LOCAL_PORT_CLOSED`, probed *before* provisioning
- [x] Subdomain availability checked against the server, not local state — **built in 2a**
- [x] Random subdomain generator when the field is blank — **built in 2a**, server-side
- [ ] Forward to any reachable host — `127.0.0.1`, LAN IPs, container names — **designed**. Cheaper than it looks: the target never reaches the API, so it reopens nothing frozen at 1.5
- [ ] Validate host: reject unreachable, warn on public IPs
- [x] WebSocket pass-through — **built in 2b**, and SSE works because `core::exchange` streams
- [ ] Basic auth option (username/password at the edge) — **deferred**: `docs/ARCHITECTURE.md` §9's "tunnel password protection", out of scope for 3.0 until an ADR promotes it

## 5. Request inspector

- [x] Capture every request/response through the tunnel — **built in 2b**, `core::inspector`
- [ ] Live stream into the list; Pause/Live toggle
- [x] Ring buffer with a cap — **settled: 1000 exchanges, 32 KiB body preview**
- [ ] Filters: All / API / Errors / Mutations
- [ ] Detail tabs: Request headers, Response headers, Timing
- [ ] Body rendering with JSON pretty-print; skip bodies for static assets
- [x] Body size limit before truncation — **32 KiB**, counted beyond that
- [ ] **Replay** — re-issue a captured request against the local target. **Deferred**, and listed as such in `docs/ROADMAP.md`
- [ ] Copy as cURL (not yet designed)
- [ ] Search by path (not yet designed — needed once traffic is real)
- [ ] Clear the log
- [ ] Redact `authorization` and `cookie` in any export
- [ ] **Decide: is the inspector per-tunnel or global?** `core::inspector` is currently one ring per `Tunnel`, so per-tunnel is the cheaper answer and a global view is a merge in the UI. Multi-node makes this more pressing

## 6. Tunnels screen

- [x] Live list with status, URL, target, node, request count, time remaining — **designed**
- [x] Copy URL with confirmation, per-tunnel Stop, expiry bar — **designed**
- [ ] Inspect scopes the inspector to that tunnel
- [ ] Stats: requests today, median latency, edge region — need real data sources
- [ ] QR code for the URL (from the original screen list, not yet designed)

## 7. New tunnel

- [x] Forward-to field with presets, subdomain field, options, node picker — **designed**
- [x] CLI mirror including `--node` — **designed**, but see the flag note below
- [ ] Detect ports already listening and offer them
- [ ] Four-step connection sequence driven by real progress, not a timer
- [ ] Failure states per step (auth failed, subdomain taken, node unreachable, DNS error)
- [ ] **The design's `-h <host>` is unavailable.** `-h` is `--help`, asserted by a test, and taking it would break the rule that help answers immediately (`crates/CLAUDE.md` CLI rule 2). Use `--host`, or fold it into the positional as `host:port`. `--node` is free

## 8. History & presets

- [x] Pinned presets and recent list — **designed**
- [ ] Persist sessions locally, including which node they used
- [ ] Reopen with the same settings; fall back if that node is gone
- [ ] Pin, rename, delete presets
- [ ] Clear history

## 9. Menu bar & window lifecycle

- [x] Menu bar popover with tunnel list and quick actions — **designed**
- [x] Close → "Keep your tunnels running?" sheet with "Don't ask me again" — **designed**
- [ ] Menu bar icon with live tunnel count
- [ ] Quit stops all tunnels cleanly
- [ ] Launch at login
- [ ] Notification 10 min before auto-cleanup
- [ ] Notification on tunnel failure, node failover, or reconnect

## 10. Settings

- [x] Registry URL, preferences, language, supporter account, support block — **designed**
- [ ] Validate the registry before saving
- [ ] Read/write **`~/.nport/config.toml`** — the CLI's format is TOML, not JSON (`crates/cli/src/config.rs`)
- [x] Custom backend URL — **built**, CLI `--backend` and the config file
- [ ] i18n framework + string extraction. **Three languages, not two**: the CLI already ships `en`/`vi`/`es`, so English + Tiếng Việt alone would be a regression
- [ ] **Light / dark / follow system.** Only light and dark exist; macOS users expect the third and it is usually the default
- [ ] Register a private node from the app (Settings copy promises this; no screen exists)
- [ ] **No analytics** — ADR-0015 and `apps/desktop/CLAUDE.md` rule 5 forbid telemetry in this app

## 11. Supporter account & monetisation

> **Blocked. Cannot be built as written.** Email entry, OTP verification, a persisted session and a
> server-side supporter lookup are an account system — auth, a user database, a login. Invariant 1
> says "no accounts, no auth, no signup — **ever**"; ADR-0007 rejected even *optional* accounts;
> `docs/ARCHITECTURE.md` §9 lists accounts as out of scope. Promoting any of this needs an ADR that
> supersedes ADR-0007, which is a product decision. Being designed does not schedule it.

- [x] Email → OTP → verified state, three screens — **designed**
- [x] Sponsored card slot with dismiss and "Already a supporter?" — **designed**
- [x] Star count in the toolbar and Settings — **designed**
- [x] All monetisation hidden in the site preview via the `embed` prop — **designed**
- [ ] Send and verify OTP; persist the supporter session; sign out
- [ ] **Server-side: check the email against the Buy Me a Coffee supporter list before sending an OTP.** As designed this is possession-of-email only — anyone who guesses a donor's address gets ad-free
- [ ] Sponsor fetch, rotation, frequency cap, click-through
- [ ] Live GitHub star count with caching to avoid rate limits

## 12. Onboarding

- [x] First run: shared backend vs own Cloudflare — **designed**
- [ ] **Own-Cloudflare path is entirely undesigned.** Needs API token entry, zone selection, permission checks, validation. With the new architecture this doubles as "become a node" — worth designing as one flow, and `docs/SELF_HOSTING.md` already documents the non-GUI half
- [ ] Skip and configure later

## 13. Packaging & distribution

- [ ] macOS build, signed and notarised, `.dmg`
- [ ] Windows build, code-signed, `.msi`/`.exe`
- [ ] Linux: `.deb`, `.rpm`, AppImage
- [ ] Homebrew cask, winget manifest, apt repo — the site advertises all three
- [ ] Auto-update with a release channel
- [ ] Crash reporting

## 14. Cross-platform design work not yet done

The design is macOS Tahoe only. Before shipping Windows and Linux:

- [ ] Windows shell: title bar, controls on the right, Fluent-appropriate materials
- [ ] Linux shell: no vibrancy, solid surfaces
- [ ] Tray equivalents on both
- [ ] Keyboard shortcuts and visible focus rings
- [ ] Decide what the app looks like where `backdrop-filter` is unsupported or slow. Every surface in the token sheet is a glass layer, and WebKitGTK is the oldest engine we ship against

---

## Open questions

1. **URL scheme — and both options in the design may be unbuildable.** A Cloudflare zone lives in
   exactly one account, and a `<tunnel-id>.cfargotunnel.com` CNAME only routes when the record and
   the tunnel are in the same account (ADR-0031). So flat `sub.nport.link` across nodes **cannot
   route**, and per-node `sub.fra.nport.link` requires `fra.nport.link` to be its own zone in that
   node's account — Cloudflare's subdomain setup has historically been Enterprise-gated, and
   universal SSL does not cover a third label. The scheme ADR-0031 chose is **one domain per node**:
   `sub.nport.link`, `sub.nport.dev`, `sub.nport.sh`. **The mockup's preview strings need revisiting.**
2. ~~**CLI flags**~~ — answered in §7. `-h` is taken by `--help`; use `--host`. `--node` is free.
3. ~~**Inspector scope**~~ — answered in §5. Per-tunnel is what `core::inspector` already does.
4. **Own Cloudflare = own node?** If a user connects their account, do they become a public node, a
   private node, or neither? ADR-0031 implies a private node — one with no `REGISTRY_URL`, which is
   exactly today's self-hosted deployment. Worth confirming, because it decides whether their own
   quota replaces the shared one.
5. **Sponsored cards** — moot while §11 is blocked, and an ad network would need its own ADR against
   ADR-0015.
6. **Node trust — reopened, and it contradicts §1 and ADR-0031.** ADR-0031 currently says: anyone may
   run a node, enrolment is open and anonymous, and the interception exposure is *documented* in
   `README.md` and `docs/ARCHITECTURE.md` §1 rather than defended against. §1 of this file asks for
   signed registration, which is the opposite. **This needs one decision, not two.** Note the two
   halves are separable: disclosing the exposure in the UI is cheap and is not the same as
   preventing it.
7. **Is the 3 / 25 quota a Cloudflare limit or ours?** The architecture note reads "Free = 3,
   Pro = 25". `MAX_CONCURRENT_PER_SOURCE: 3` in `apps/api/wrangler.jsonc` is **NPort's own
   per-source abuse cap**, not a Cloudflare account limit — and if the 3 is that, adding accounts
   does not lift it, because it is enforced per caller rather than per account. The capacity
   argument for federation rests on this, so it is worth confirming which ceiling is meant before
   building against it.
