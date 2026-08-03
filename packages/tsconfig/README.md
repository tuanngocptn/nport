# @nport/tsconfig

Shared TypeScript configuration bases, extended by each app and package.

| File | For |
| --- | --- |
| `base.json` | strict defaults every target inherits |
| `worker.json` | Cloudflare Workers (`apps/api`) |
| `next.json` | Next.js (`apps/web`) |
| `vite.json` | Vite + React (`apps/desktop`) |

`base.json` sets `strict: true` and `noUncheckedIndexedAccess`. Both are deliberate and neither should be relaxed in a downstream config — see [`docs/conventions/typescript.md`](../../docs/conventions/typescript.md).

**Not implemented.** Phase 0 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).
