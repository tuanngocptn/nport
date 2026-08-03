# @nport/design-tokens

Brand tokens as plain CSS: `tokens.css` (a Tailwind v4 `@theme` block) and `fonts.css`.

Consumed by **both** `apps/web` and `apps/desktop`. Each imports this file and runs its own Tailwind v4 build over it, so the palette is defined once as plain CSS with no JS config object shared across a workspace boundary and no build-order dependency between this package and its consumers ([ADR-0014](../../docs/DECISIONS.md)).

This is the *only* thing the two React targets share. There is deliberately no `packages/ui`: a marketing site rendered server-side and a WebView SPA with a virtualized request table have almost no genuine component overlap, and a shared library would impose a lowest-common-denominator API to share perhaps three primitives ([ADR-0010](../../docs/DECISIONS.md)). The desktop app gets its components from vendored shadcn/ui source instead ([ADR-0021](../../docs/DECISIONS.md)).

The palette carries over from v2 unchanged — accent `#22C55E`, surface `#0F172A`, with IBM Plex Sans, JetBrains Mono, and Cookie. Do not introduce a raw hex value in a component; add a token here instead.

**Not implemented.** Phase 2c in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).
