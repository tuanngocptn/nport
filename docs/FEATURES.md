# NPort Desktop — Feature Backlog

Everything the design implies, grouped by area. Checkboxes are unbuilt unless noted.
Design source: `docs/mockup/NPort Desktop.dc.html`. Marketing site: `docs/mockup/NPort Site.dc.html`.

**This is an inventory, not a plan.** `docs/ROADMAP.md` assigns every area below to a phase, and says which are blocked and why. Nothing here is scheduled by being listed here.

---

## 1. Core tunnel engine

- [ ] Start a tunnel: bind `host:port` → request subdomain → open Cloudflare tunnel
- [ ] Stop a tunnel, release the subdomain, tear down the connection
- [ ] Enforce the 3-concurrent cap; block Start with "All 3 slots in use"
- [ ] 4-hour lifetime per tunnel; auto-cleanup on expiry
- [ ] Countdown timer per tunnel, persisted so restarts don't lose the clock
- [ ] Reconnect on network change / laptop wake without dropping the subdomain
- [ ] Detect the local target being down; surface a clear error, don't fail silently
- [ ] Subdomain availability check before Start (the green "is available" line)
- [ ] Random subdomain generator when the field is left blank
- [ ] Forward to any reachable host, not just localhost — `127.0.0.1`, LAN IPs, container names
- [ ] Validate host: reject unreachable, warn on public IPs
- [ ] WebSocket and SSE pass-through
- [ ] Basic auth option (username/password prompt at the edge) — **deferred**: this is `docs/ARCHITECTURE.md` §9's "tunnel password protection", out of scope for 3.0 until an ADR promotes it

## 2. Request inspector

- [ ] Capture every request/response through the tunnel
- [ ] Live stream into the list; Pause/Live toggle
- [x] Ring buffer with a cap so memory doesn't grow unbounded — settled: **1000 exchanges, 32 KiB body preview** (`core::inspector`)
- [ ] Filters: All / API / Errors / Mutations
- [ ] Detail tabs: Request headers, Response headers, Timing breakdown
- [ ] Body rendering with JSON pretty-print; skip bodies for static assets
- [ ] Body size limit before truncation
- [ ] **Replay** — re-issue a captured request against the local target. **Deferred**, and already listed as such in `docs/ROADMAP.md`
- [ ] Copy as cURL (not yet in the design — worth adding)
- [ ] Search/filter by path (not yet in the design — needed once traffic is real)
- [ ] Clear the log
- [ ] Redact sensitive headers (`authorization`, `cookie`) in any export

## 3. Tunnels screen

- [ ] Live list with status dot, URL, target, request count, time remaining
- [ ] Copy URL to clipboard with confirmation
- [ ] Per-tunnel Stop
- [ ] Inspect jumps to that tunnel's traffic (currently one shared inspector — needs per-tunnel scoping)
- [ ] Expiry progress bar
- [ ] Stats: requests today, median latency, edge region — all need real data sources
- [ ] QR code for the URL (from your original screen list, not yet designed)

## 4. New tunnel

- [ ] Forward-to field: host + port, with presets
- [ ] Detect ports already listening on the machine and offer them
- [ ] Subdomain field with live availability
- [ ] Options: open inspector on start, basic auth, copy URL on start
- [ ] Four-step connection sequence with real progress, not a timer
- [ ] Failure states for each step (auth failed, subdomain taken, DNS error)
- [ ] CLI mirror string — **confirm the real flag for host** (design assumes `-h`)

## 5. History & presets

- [ ] Persist every tunnel session to local storage
- [ ] Reopen from history with the same settings
- [ ] Pin a session as a named preset
- [ ] Rename / delete presets
- [ ] Clear history

## 6. Menu bar & window lifecycle

- [ ] Menu bar icon with live tunnel count
- [ ] Popover: tunnel list, copy URL, New tunnel, Open inspector
- [ ] Close window → "Keep your tunnels running?" sheet
- [ ] "Don't ask me again" preference
- [ ] Quit stops all tunnels cleanly
- [ ] Launch at login
- [ ] Native notification 10 min before auto-cleanup
- [ ] Notification on tunnel failure/reconnect

## 7. Settings

- [ ] Custom backend URL (own Cloudflare Worker)
- [ ] Validate the backend before saving
- [ ] Read/write `~/.nport/config.toml` — the CLI's actual format is TOML, not JSON (`crates/cli/src/config.rs`)
- [ ] Preferences: launch at login, keep menu bar icon, cleanup warning. **No analytics** — ADR-0015 and `apps/desktop/CLAUDE.md` rule 5 forbid telemetry in this app
- [ ] Language: English / Tiếng Việt / Español — the CLI already ships three, so two would be a regression
- [ ] Light / dark / follow system (design has light and dark; **"follow system" is missing** and macOS users expect it)

## 8. Supporter account & monetisation

> **Blocked. Cannot be built as written.** Email entry, OTP verification, a persisted session and a
> server-side supporter lookup are an account system — auth, a user database, a login. Invariant 1
> says "no accounts, no auth, no signup — **ever**"; ADR-0007 rejected even *optional* accounts;
> `docs/ARCHITECTURE.md` §9 lists accounts as out of scope. Promoting any of this needs an ADR that
> supersedes ADR-0007, which is a product decision. See `docs/ROADMAP.md`.

- [ ] Email entry → send OTP
- [ ] 6-digit code verification, 10-minute expiry, resend
- [ ] Persist the supporter session locally
- [ ] Sign out
- [ ] Hide all sponsored cards for verified supporters
- [ ] **Server-side: verify the email against the Buy Me a Coffee supporter list before sending an OTP.** As designed this is possession-of-email only — anyone who guesses a donor's address gets ad-free.
- [ ] Sponsored card slot: fetch, render, dismiss, click-through
- [ ] Sponsor rotation and a frequency cap
- [ ] Live GitHub star count with caching (avoid rate limits)

## 9. Onboarding

- [ ] First-run: shared backend vs own Cloudflare
- [ ] Own-Cloudflare path — **entirely undesigned.** Needs API token entry, zone selection, permission checks, and a validation step. This is the biggest gap in the flow.
- [ ] Skip and configure later

## 10. Backend

- [ ] Tunnel provisioning API
- [ ] Subdomain registry with reservation and release
- [ ] 4-hour cleanup job
- [ ] OTP issue + verify endpoints
- [ ] Supporter lookup against Buy Me a Coffee
- [ ] Sponsored-card delivery endpoint
- [ ] Rate limiting and abuse handling
- [ ] Self-host documentation for the Worker

## 11. Packaging & distribution

- [ ] macOS build, signed and notarised, `.dmg`
- [ ] Windows build, code-signed, `.msi`/`.exe`
- [ ] Linux: `.deb`, `.rpm`, AppImage
- [ ] Homebrew cask, winget manifest, apt repo — the site advertises all three
- [ ] Auto-update with a release channel
- [ ] Crash reporting

## 12. Cross-platform design work not yet done

The design is macOS Tahoe only. Before shipping Windows and Linux:

- [ ] Windows shell: title bar, min/max/close on the right, Fluent-appropriate materials
- [ ] Linux shell: no vibrancy, solid surfaces
- [ ] System tray equivalents on both
- [ ] Keyboard shortcuts and focus rings for keyboard-only navigation

---

## Open questions

1. ~~What is the real CLI flag for a non-localhost target? The design assumes `-h`.~~ **`-h` is unavailable** — it is `--help`, asserted by a test, and taking it would break the rule that help answers immediately (`crates/CLAUDE.md`, CLI rule 2). There is no host flag yet at all; the CLI takes a port and probes `127.0.0.1`. Use `--host`, or fold it into the positional as `host:port`. Worth knowing before designing it: the target **never reaches the API** — `createTunnelRequestSchema` carries a subdomain and nothing else — so this is a client-side change that reopens nothing frozen at Phase 1.5.
2. Is the inspector per-tunnel or global? The sidebar count implies global; the Inspect button implies per-tunnel. `core::inspector` is currently one ring per `Tunnel`, so per-tunnel is the cheaper answer; a global view is a merge in the UI.
3. Sponsored cards: self-served, or an ad network? Moot while §8 is blocked, and an ad network would need its own ADR against ADR-0015.
4. Does the 3-tunnel cap still apply when a user connects their own Cloudflare account? The sidebar copy says the cap is a Cloudflare quota, which implies it should lift. **It is not a quota** — `SourceQuota` in `apps/api` enforces it per source, deliberately, as an abuse control (`docs/ARCHITECTURE.md` §7). A user on their own backend runs their own copy of that Worker and sets their own limit, so the cap lifts by self-hosting rather than by a setting.

Two more, not yet listed, both from the design:

5. Where does the site's `#compare` section go? The section order in `apps/web/CLAUDE.md` is fixed and has no slot for it.
6. What does the desktop app look like where `backdrop-filter` is unsupported or too slow? Every surface in the token sheet is a glass layer, and WebKitGTK is the oldest engine we ship against.
