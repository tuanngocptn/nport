# The UI mockup

**This is the approved design for NPort's two visual surfaces.** It is the reference to check
UI, UX, and behaviour against when building `apps/web` (Phase 2c) and `apps/desktop` (Phase 4) —
and afterwards, when changing either of them.

Exported from the Claude Design project *Nport Desktop App Redesign*
([claude.ai/design/p/1d414f63-43aa-4fe6-b6ed-a9070c271a14](https://claude.ai/design/p/1d414f63-43aa-4fe6-b6ed-a9070c271a14)).

## What is here

| Path | What it is |
| --- | --- |
| `NPort Site.dc.html` | the marketing site — **the design for `apps/web`** |
| `NPort Desktop.dc.html` | the desktop app — **the design for `apps/desktop`** |
| `handoff/shared/tokens.css` | the token sheet: colour, radii, spacing, type, motion, glass, elevation |
| `handoff/desktop/index.html` | the desktop layout flattened to plain markup, screen by screen |
| `assets/` | the logo (dark and light) and the Buy Me a Coffee mark |
| `uploads/` | reference screenshots pasted during the design session |
| `support.js`, `.thumbnail` | the Claude Design runtime and preview image. Not ours, not read by anything here |

Open either `.dc.html` directly in a browser. They are self-contained apart from Google Fonts.

## What it specifies

**Aesthetic: macOS 26 "Tahoe" / Liquid Glass.** Dark is the default (`:root`); light is
`[data-theme="light"]`. Apple's system palette, with `--np-green: #30D158` as the primary accent
and the live-tunnel colour.

The **site** is five sections: hero (`#top`), `#features`, `#how`, `#compare` — an ngrok
comparison — and `#download`.

The **desktop app** is a sidebar plus five screens — *Tunnels*, *New tunnel*, *Inspector*,
*History*, *Settings* — with a first-run overlay and a menu-bar popover.

Two things in the file are scaffolding rather than product, and say so in their own comments: the
simulated wallpaper behind the window (the real Tauri app shows the OS wallpaper) and the demo-only
theme and language switches sitting outside the window chrome.

## Rules

1. **Never hand-edit anything in this directory.** It is a wholesale export. Change the design in
   Claude Design and re-export, or the next export silently reverts you.
2. **Nothing imports from here.** No build step reads it, and no artifact ships from it. When a
   token or a component becomes real it is *transcribed* into `packages/design-tokens` or the app
   that needs it — `handoff/shared/tokens.css` is the source for `packages/design-tokens/tokens.css`,
   not a file to symlink.
3. **It is excluded from every check**, deliberately — see below. Do not "fix" its lint errors.
4. **The design is not the authority on behaviour.** Where it disagrees with `docs/ARCHITECTURE.md`,
   `docs/API.md`, or an invariant in the root `CLAUDE.md`, those win and the design is wrong. It
   shows a two-language switch, for instance, while `crates/cli` ships three (`en`, `vi`, `es`).

## Why it is excluded from validation

`biome.jsonc` and `lefthook.yml` both skip `docs/mockup`, and `.gitattributes` marks it
`linguist-vendored`.

Biome found **160 errors and 16 warnings** across five files here — accessibility notes on a
mockup's markup, and formatting complaints about `support.js`, which is a generated bundle from
someone else's build. None of it is actionable: nothing here is source, and every finding would
return with the next export. A check that always fails is a check everyone learns to ignore, which
costs more than the one it was meant to catch.

`cargo xtask verify-docs` never looked at this directory and still does not.
