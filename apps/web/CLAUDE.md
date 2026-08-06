# apps/web

## Scope

The public site at `nport.link`: marketing page, user documentation, and generated error-code pages. Next.js deployed to a Cloudflare Worker via OpenNext.

**Not responsible for:** any runtime API calls, any dashboard, any authenticated surface. There are no accounts (ADR-0007), so this is a static-ish content site and should stay one.

**This is the only place user-facing documentation lives** — `apps/web/src/content/docs/*.mdx`. `docs/` at the repo root is contributor-only.

**The approved design is `docs/mockup/NPort Site.dc.html`.** Read `docs/mockup/README.md` before building or changing anything visual — that file is what UI, UX, and behaviour are checked against. It is reference only: never imported, never hand-edited, excluded from every check.

**Status: 2c in progress.** `/errors/[code]` is live (33 pages generated from `@nport/contract`) and the marketing page renders all seven sections plus `#compare`. Still ahead: the four JSON-LD blocks, `sitemap.ts`/`robots.ts`, the OpenGraph image, the MDX user docs, and the Playwright tier.

**The design's copy is not shippable as written, and that is recorded rather than worked around.** `docs/mockup` was drawn for the finished product, so its hero and four of its eight features advertise a desktop app (Phase 4), a request inspector (Phase 4), and request replay (**Deferred**). `src/content/site.ts` keeps every one of those claims with a `ships` tag and the reason it is held back; the page renders only what is true, and `site.test.ts` fails if it ever renders more. Phase 4 is a status flip. The mockup's own README rule 4 is what licenses this — the design is not the authority on behaviour.

## Layout

```
src/app/layout.tsx page.tsx globals.css
src/components/sections/              navbar, hero, how-it-works, features, powered-by, compare, download, footer
src/content/site.ts                   the copy as data + which claims are true yet
src/app/errors/page.tsx               the index: every code, grouped by origin
src/app/errors/[code]/page.tsx        one page per code; the CLI and API deep-link here
src/lib/error-codes.ts                slug ↔ code, in a lib so it is testable without a route
src/lib/inline-markdown.tsx           the two markdown constructs the registry's prose uses
open-next.config.ts next.config.ts postcss.config.mjs wrangler.jsonc

# Planned for 2c and not yet written — parenthesised so the block cannot be read as
# a description of the tree as it stands:
(src/app/docs/[[...slug]]/page.tsx    MDX from src/content/docs)
(src/app/sitemap.ts robots.ts opengraph-image.tsx)
(src/content/docs/*.mdx               USER docs — the only home for them)
(src/lib/seo.ts                       JSON-LD builders)
(e2e/                                 Playwright: behaviour + visual baselines, ADR-0023)
(public/.well-known/security.txt)
```

The parenthesised entries are what 2c still owes (`docs/ROADMAP.md`). `cargo xtask verify-docs` checks the unparenthesised ones exist, so a rename that misses this block fails CI — and un-parenthesising an entry as you build it is what keeps that check meaningful.

## Commands

```bash
pnpm dev:web                          # next dev with Worker bindings
pnpm --filter @nport/web build        # next build only — .next/, no Worker
pnpm --filter @nport/web build:worker # the above, then opennext -> .open-next/worker.js
pnpm --filter @nport/web preview      # run the built Worker locally
pnpm --filter @nport/web deploy       # normally CI does this
```

## Rules

1. **Section order is fixed**, carried from v2 because it converts: navbar → hero → how-it-works → features → powered-by → CTA → footer. Reordering needs a reason beyond taste. **`#compare` is settled**: it sits between `powered-by` and the CTA, which is where the mockup puts it relative to features and download, keeps the v2 sequence intact, and is the strongest position for it — a reader who has just seen what NPort does and where it runs is the one asking how it differs. A build-order assertion is not automated; `sections/compare.tsx` carries the reasoning.
2. **Never claim something NPort does not do yet.** Marketing copy lives in `src/content/site.ts` with a `ships` tag per claim, and only `"3.0"` renders. Anything else needs a `because` saying where the deferral is decided. `site.test.ts` enforces both, because the design over-promises by construction and a reviewer's memory is not a check.
3. **All four JSON-LD blocks are required** and built in `src/lib/seo.ts`: `WebSite`, `SoftwareApplication`, `HowTo`, `FAQPage`. This was v2's most deliberate SEO investment and the site's discovery depends on it.
4. **No raw hex colours in components.** Everything comes from `packages/design-tokens` via Tailwind utilities (ADR-0014).
5. **Server-first.** `"use client"` needs a justification in review — the page's job is fast delivery, and v2 shipped its entire interaction budget in ~40 lines of vanilla JS.
6. **Exactly one GA4 property** (ADR-0015). v2 double-tracked with two.
7. **No secret, key, or token in client code.** v2 committed a Firebase web API key into its HTML.
8. **No version numbers or dates hardcoded anywhere.** Derive them from the workspace or a build-time constant.
9. **User docs are MDX in `src/content/docs`** — never in `README.md`, never in `docs/`.
10. Every external link gets `target="_blank" rel="noopener noreferrer"`; every icon-only control gets an `aria-label`; every image gets explicit `width`/`height`.

## Common tasks

**Add a docs page** — `src/content/docs/<slug>.mdx` with front-matter → it routes automatically → add it to the nav → check it appears in `sitemap.ts`.

**Change marketing copy** — the section component in `src/components/sections/`. If the claim changes (features, supported platforms, pricing), update the `SoftwareApplication` and `FAQPage` JSON-LD in `src/lib/seo.ts` to match, or structured data starts lying.

**Add a design token** — `packages/design-tokens/tokens.css` `@theme` block. It becomes a Tailwind utility automatically and is simultaneously available to `apps/desktop`.

**Add an error page** — you don't. `/errors/[code]` is generated from `@nport/contract`: add the code there and the page exists, because `generateStaticParams` walks the registry. A test asserts one page per code and that every `docsUrl` round-trips, so a code with no page fails rather than 404ing at whoever needed it.

**The mockup does not design the error pages.** It specifies the marketing site's five sections; these follow `packages/design-tokens` and nothing else. Anything the mockup *does* cover is checked against it (`docs/mockup/README.md`).

**Update the CLI flag reference** — also generated. Change the CLI, run `pnpm codegen`.

## Gotchas

- **`nodejs_compat` is required** in `wrangler.jsonc`, and `next dev` needs `initOpenNextCloudflareForDev()` in `next.config.ts` or local bindings are missing.
- **OpenNext output paths matter**: `main` is `.open-next/worker.js` and assets are `.open-next/assets`. Getting these wrong deploys an empty site that returns 200.
- **Nothing is committed from a build.** v2 committed a minified `index.html` and its CI re-inlined a CSS file that was gitignored — deploys silently depended on a local build. Do not recreate that.
- **Tailwind v4 has no `tailwind.config.js`.** Tokens are CSS `@theme`; dark mode is `@custom-variant dark (&:where(.dark, .dark *))`. v3 idioms and config objects will not work.
- **Dark mode needs the anti-FOUC inline script** in `<head>` reading `localStorage["nport-theme"]` before first paint, or the page flashes on load.
- **`sitemap.xml` should not be fragment URLs.** v2 listed `/#features` and similar, which Google treats as one page.
- The apex is currently served by Cloudflare Pages. Going live is a DNS cutover with a rollback path — `docs/OPERATIONS.md`.
