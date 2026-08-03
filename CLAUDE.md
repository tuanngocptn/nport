# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NPort — a free, open-source ngrok alternative that tunnels HTTP/HTTPS from localhost to a public `*.nport.link` URL over Cloudflare's edge network. Published to npm as `nport`; site at https://nport.link.

## Status

This branch (`v3-new-architech`) is a from-scratch rewrite. The only tracked file is `README.md` — there is no source, build tooling, or test setup yet. Empty `bin/`, `dist/`, `server/`, `website/`, and `.vscode/` directories are leftovers from the previous tree and carry no meaning.

There are no build, test, or lint commands to document yet. Add them here as they land.

## Prior implementation

v2 is on `main` and is not part of this branch. Consult it for reference without checking it out:

```bash
git ls-tree -r main --name-only      # v2 file listing
git show main:docs/ARCHITECTURE.md   # v2 architecture notes
git show main:CLAUDE.md              # v2 conventions and commands
```

v2 was a TypeScript CLI (`src/`, esbuild-bundled), a Cloudflare Worker backend (`server/`), and a static Tailwind site (`website/`), driving the `cloudflared` binary to establish tunnels. Treat those choices as history, not constraints.

## Maintaining this file

Keep it describing what exists on this branch. As the v3 architecture takes shape, document the parts that require reading several files to understand — the component boundaries, the request/lifecycle flow between them, and any convention that isn't evident from a single file.
