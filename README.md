# NPort

> Free & open source ngrok alternative — tunnel localhost to the internet via Cloudflare's edge

[![NPM](https://img.shields.io/npm/v/nport?color=red&logo=npm)](https://www.npmjs.com/package/nport)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fnport.link&up_message=nport.link&up_color=blue)](https://nport.link)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

```bash
npm i -g nport
nport 3000 -s myapp     # → https://myapp.nport.link
```

No account. No config. No paywall.

---

## ⚠️ This branch is a rewrite in progress

You are on `v3-new-architect`, a from-scratch rewrite. **It does not tunnel anything yet** — it currently contains architecture documentation, the workspace and CI setup, and stub crates.

**For the working version, use `main`**, which is what `npm i -g nport` installs today.

| | v2 (`main`, shipping) | v3 (this branch) |
| --- | --- | --- |
| CLI | Node + TypeScript, wraps the `cloudflared` binary | native Rust, single binary |
| Data plane | downloads and supervises `cloudflared` | native Rust connector implementation |
| Backend | one Cloudflare Worker | Hono on Workers + Durable Objects |
| Website | hand-written HTML | Next.js on Workers |
| Desktop app | — | Tauri v2, with a traffic inspector |

Progress and phases: [`docs/ROADMAP.md`](docs/ROADMAP.md). The v3 CLI will still install with `npm i -g nport`, and additionally via Cargo, Homebrew, Scoop, and GitHub Releases.

## What NPort does

Exposes a local port at a public HTTPS URL, routed over Cloudflare's global network. Useful for sharing work in progress, receiving webhooks from GitHub or Stripe, testing on real mobile devices, and demoing to clients without deploying.

Tunnel traffic goes from Cloudflare's edge straight to your machine — **it never passes through NPort's own servers.** The backend only creates and cleans up tunnels.

## Documentation

User documentation lives at [nport.link](https://nport.link). This repository's `docs/` is for contributors:

| | |
| --- | --- |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | components, request paths, state, failure modes |
| [PROTOCOL](docs/PROTOCOL.md) | the connector wire specification |
| [API](docs/API.md) · [ERRORS](docs/ERRORS.md) | control-plane contract and error registry |
| [DECISIONS](docs/DECISIONS.md) | why it is built this way |
| [ROADMAP](docs/ROADMAP.md) | phases and gates |
| [CONTRIBUTING](docs/CONTRIBUTING.md) · [TESTING](docs/TESTING.md) | how to help |
| [SELF_HOSTING](docs/SELF_HOSTING.md) | run your own control plane on your own domain |
| [OPERATIONS](docs/OPERATIONS.md) · [RELEASE](docs/RELEASE.md) | running and shipping it |

## Development

Node 24 and [rustup](https://rustup.rs) — full prerequisites and dev loop in [CONTRIBUTING](docs/CONTRIBUTING.md).

```bash
corepack enable && pnpm install    # dependencies and the git hooks
```

Most of these currently run against stubs; the phase in brackets is when each becomes meaningful.

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome over the whole repo — the linter and the formatter check |
| `pnpm lint:fix` | the same, applying every safe fix |
| `pnpm format` | formatting only, no lint rules |
| `pnpm typecheck` | `tsc` in every package that has TypeScript |
| `pnpm test` | Vitest, including the API's real-`workerd` tests [2a] |
| `pnpm build` | Next.js + OpenNext, and any package that builds [2c] |
| `pnpm codegen` | regenerate the OpenAPI document and everything downstream of it [1.5] |
| `pnpm dev:api` | `wrangler dev` with local Durable Objects [2a] |
| `pnpm dev:web` | `next dev` with Worker bindings [2c] |
| `pnpm dev:desktop` | `tauri dev` [4] |
| `cargo run -p nport -- 3000 -s test` | the CLI [2b] |
| `cargo test` | all Rust, hermetic — add `-- --ignored` for the live-edge tests [1] |
| `cargo clippy --all-targets -- -D warnings` | Rust lint, as CI runs it |
| `cargo fmt` | Rust formatting |
| `cargo deny check all` | licence allowlist and RUSTSEC advisories |
| `cargo xtask codegen` | the Rust half of codegen; must leave the tree clean [1.5] |
| `cargo xtask fixtures` | capture golden protocol byte fixtures [1] |
| `cargo xtask verify-docs` | check repo-map paths, error codes, and markdown links |
| `cargo xtask npm-packages` | generate the nine npm manifests from the Cargo version [3] |

`pnpm install` installs the git hooks, so committing runs Biome and `cargo fmt` on what you staged and checks the commit subject. Full script list: root [`package.json`](package.json).

## A note on the native connector

v3 implements Cloudflare's tunnel connector protocol directly in Rust rather than shipping the `cloudflared` binary. That is what makes NPort a single static binary with no runtime dependency, no download at install time, and a traffic inspector that comes almost for free.

Two things contributors should know up front:

- **`cloudflared` is Apache-2.0**, which permits reimplementation and reuse of its Cap'n Proto schema with attribution. The *edge service*, however, is governed by [Cloudflare's terms](https://www.cloudflare.com/terms/), and that licence does not by itself authorize connecting a non-Cloudflare client to Cloudflare's network. This is a knowingly accepted risk, recorded in [ADR-0002](docs/DECISIONS.md).
- **The protocol is undocumented and can change without notice.** If it does, every installed client breaks at once. Mitigations — a 6-hourly canary, an HTTP/2 fallback transport, and a `cloudflared` escape hatch — are in [ADR-0017](docs/DECISIONS.md).

If either is a dealbreaker for your use case, `main` will keep working for the foreseeable future.

## Built with

[Cloudflare](https://www.cloudflare.com) (Tunnels, DNS, Workers, Durable Objects) · [Rust](https://www.rust-lang.org) · [Tauri](https://tauri.app) · [Hono](https://hono.dev) · [Next.js](https://nextjs.org) · [quinn](https://github.com/quinn-rs/quinn) · [Cap'n Proto](https://capnproto.org)

Prior art and reference: [`cloudflare/cloudflared`](https://github.com/cloudflare/cloudflared), Apache-2.0.

## Security

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).

## License

MIT © [Nick Pham](https://github.com/tuanngocptn) · Made with ❤️ in Vietnam

If NPort is useful to you, a ⭐ helps, and [a coffee](https://www.buymeacoffee.com/tuanngocptn) is always welcome.
