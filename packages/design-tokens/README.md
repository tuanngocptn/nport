# @nport/design-tokens

Brand tokens as plain CSS: `tokens.css` (a Tailwind v4 `@theme` block) and `fonts.css`.

Consumed by **both** `apps/web` and `apps/desktop`. Each imports this file and runs its own Tailwind v4 build over it, so the palette is defined once as plain CSS with no JS config object shared across a workspace boundary and no build-order dependency between this package and its consumers ([ADR-0014](../../docs/DECISIONS.md)).

This is the *only* thing the two React targets share. There is deliberately no `packages/ui`: a marketing site rendered server-side and a WebView SPA with a virtualized request table have almost no genuine component overlap, and a shared library would impose a lowest-common-denominator API to share perhaps three primitives ([ADR-0010](../../docs/DECISIONS.md)). The desktop app gets its components from vendored shadcn/ui source instead ([ADR-0021](../../docs/DECISIONS.md)).

**The palette no longer carries over from v2.** It was accent `#22C55E` on surface `#0F172A` with IBM Plex Sans and JetBrains Mono; the approved design in [`docs/mockup`](../../docs/mockup/README.md) replaces all of it with a macOS 26 "Tahoe" / Liquid Glass treatment — accent `#30D158`, translucent glass surfaces, and SF Pro falling through to Geist. `tokens.css` here is transcribed from `docs/mockup/handoff/shared/tokens.css`. Do not introduce a raw hex value in a component; add a token here instead.

Two halves, for a reason worth knowing before editing: the glass surfaces are ordinary custom properties under `:root` and `[data-theme="light"]` because they switch at **runtime**, and Tailwind v4's `@theme` values are static. The `@theme` block then points Tailwind's scales at those properties, which is what makes `bg-card` follow the theme.

**Scaffolded.** The tokens are real and both apps import them; the components that use them are Phase 2c and Phase 4 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).
