# Releasing

Three independently versioned artifacts on three different clocks. That is not self-evident, so it is written down.

| Artifact | Version | Tag | Trigger |
| --- | --- | --- | --- |
| CLI (`nport`) | `3.x.y` from `crates/cli/Cargo.toml` | `cli-v3.x.y` | tag push |
| Desktop app | `3.x.y` from `apps/desktop/src-tauri/tauri.conf.json` | `desktop-v3.x.y` | tag push |
| API + website | none — continuous | — | push to `main` |

The CLI version is the one users mean by "NPort version". npm `nport`, the eight `@nport/cli-*` packages, and the crates.io `nport` crate all carry the same number.

The desktop app versions independently: it ships on a slower clock and its releases are gated on manual per-platform verification.

`apps/gateway`, `apps/node`, `apps/registry` and `apps/web` deploy on every merge to `main` that touches them. They have no version because there is only ever one live copy, and the API's compatibility surface is `/v1` (`docs/API.md`).

## CLI release

### Pre-flight

- [ ] `main` is green, including the nightly smoke run
- [ ] `protocol-canary.yml` green for the last 24 h *(Phase 3; the workflow does not exist yet)*
- [ ] `CHANGELOG.md` regenerated and read for accuracy
- [ ] `docs/PROTOCOL.md` "last verified" date refreshed if the protocol changed
- [ ] version bumped in `crates/cli/Cargo.toml`, `Cargo.lock` updated
- [ ] `MIN_CLIENT_VERSION` considered — raising it breaks old clients deliberately, so it needs its own note

### Run

Push `cli-v3.x.y`. `release-cli.yml` (Phase 3, not yet written) then:

1. Builds 8 targets — `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`. Native runners throughout; `cross` only for the two musl targets, because cross-linking `ring`/`quinn` is where this breaks.
2. Generates SHA-256 checksums and `actions/attest-build-provenance` attestations.
3. Creates the GitHub Release with binaries, checksums, and attestations.
4. `cargo xtask npm-packages` generates the nine `package.json` files from the single Cargo version.
5. **Publishes the 8 platform packages first, then `nport`.** Order is load-bearing: if the shim goes first, `npm i -g nport` resolves optional dependencies that do not exist yet and users get a broken install in that window.
6. `cargo publish` for `nport-protocol`, `nport-core`, `nport` in dependency order.
7. Bumps the Homebrew formula and the Scoop manifest.

### Verify

On a clean machine per platform: `npm i -g nport@3.x.y` then `nport --version`, and one real tunnel. Also `npm i -g nport --ignore-scripts` — it must work, since that was v2's failure mode.

Confirm the platform package count on npm is 8, and that `nport`'s `optionalDependencies` all resolve.

### First-release-only checks

The npm shim is the highest-risk piece the first time. Verify: it resolves the right platform package; `stdio: "inherit"` passes TTY through so colours and spinners work; the exit code propagates; SIGINT and SIGTERM forward to the child so Ctrl+C tears the tunnel down; and the no-platform-package fallback prints a clear message and downloads **on first invocation, not at install** (ADR-0012).

### Rollback

npm packages cannot be unpublished after 72 h — plan on `npm deprecate` plus a fixed patch, not removal.

| Channel | Action |
| --- | --- |
| npm | `npm dist-tag add nport@<previous> latest`, then `npm deprecate nport@<bad> "<reason>, use X"` |
| crates.io | `cargo yank --version <bad>` (does not break existing lockfiles) |
| GitHub Release | mark as pre-release, edit the notes |
| Homebrew / Scoop | revert the formula/manifest commit |

Retagging `latest` on npm is the fastest and highest-impact step. Do it first.

## Desktop release

Slower clock, and every release needs manual verification because WebView behaviour differs per platform.

### Pre-flight

- [ ] CLI at the version the desktop app links, released and verified
- [ ] manual pass on macOS, Windows, and one Linux desktop: create a tunnel, inspect traffic, tray behaviour, quit while a tunnel is live
- [ ] auto-update tested **from the previous version**, not from a fresh install
- [ ] signing certificates not near expiry

### Run

Push `desktop-v3.x.y`. `release-desktop.yml` (Phase 4, not yet written) builds via `tauri-action` on `macos-14` (universal, signed, notarized, stapled), `ubuntu-24.04` (`.deb` + `.AppImage`), and `windows-latest` (`.msi`, signed), then publishes the release and uploads the updater `latest.json` to R2.

### Verify

Install each artifact fresh and confirm no Gatekeeper or SmartScreen warning — an unsigned or un-notarized build is a support-load event. Then confirm a previous-version install actually offers and applies the update.

### Rollback

Remove or revert `latest.json` in R2 **first** — that stops the update rolling out further, and it is the only step that helps users who have not updated yet. Then mark the release as pre-release. Users who already updated need a new version; there is no downgrade path.

## API and website

Merging to `main` deploys. Verification is CI plus `GET /v1/health`.

To roll back: revert the commit and let CI deploy, or `wrangler rollback` for an immediate revert to the previous deployment.

**Rolling back one of three Workers needs the deploy order in reverse** (ADR-0049). A deploy goes node and registry first, then the gateway, because Cloudflare rejects a `services` binding naming a script that does not exist. A rollback that removes a binding's target while the gateway still names it leaves the gateway answering `INTERNAL` on every forwarded path while `/v1/health` stays green — so roll the **gateway back first**, then the services behind it. Rolling back only the gateway is always safe.

**Durable Object migrations do not roll back.** A `wrangler rollback` reverts code, not schema. Any migration must be forward-compatible with the previous code, deployed in two steps: first a release that tolerates both shapes, then the one that requires the new shape. Removing a DO class is effectively irreversible — think before adding a migration tag.

## Changelog

Generated by `git-cliff` from conventional commits into a single root `CHANGELOG.md`, sectioned by artifact using the commit scope (`cli`, `desktop`, `api`, `web`, `protocol`). v2 kept a root changelog and a second one in `server/` that drifted apart.

`protocol` scope entries deserve prose, not just a commit subject — they are the ones users need to understand.

## v2 sunset

v2 clients hit the legacy shim (`docs/API.md`). Retiring it is a sequence, not an event:

1. **3.0.0 ships.** Shim stays. `npm deprecate nport@"<3"` pointing at a migration note.
2. **+1 month.** Site banner and README note the sunset date, at least 3 months out.
3. **Sunset date.** The shim returns `426 CLIENT_TOO_OLD` with an upgrade URL. v2 clients stop working, having been warned.
4. **+1 month.** Remove the shim.

Publish the date once and do not move it — a sunset date that slips teaches people to ignore the next one. Watch the client-version distribution (`docs/OPERATIONS.md`) to choose the date; if a large fraction is still on 2.x, extend *before* announcing, not after.
