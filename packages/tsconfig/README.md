# @nport/tsconfig

Shared TypeScript configuration bases, extended by each app and package.

| File | For |
| --- | --- |
| `base.json` | strict defaults every target inherits |
| `worker.json` | Cloudflare Workers (`apps/node`) |
| `next.json` | Next.js (`apps/web`) |
| `vite.json` | Vite + React (`apps/desktop`) |

`base.json` sets `strict: true` and `noUncheckedIndexedAccess`. Both are deliberate and neither should be relaxed in a downstream config — see [`docs/conventions/typescript.md`](../../docs/conventions/typescript.md).

Two things about `base.json` that are easier to state here than to infer:

- It sets `noEmit: true`, because most consumers are type-checked and bundled by something else. A package that genuinely needs to emit overrides it and says why.
- The three target configs differ only in `lib`, `jsx`, and `types`. If you find yourself adding a strictness flag to one of them, it belongs in `base.json` instead.

No comments in these files: they are plain `.json` to Biome, and it will not parse comments in a file that is not named `tsconfig.json`.
