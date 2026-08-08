# NPort — Design System & Implementation Spec

Reference for building the NPort desktop app and marketing site.
Source of truth: `NPort Desktop.dc.html`, `NPort Site.dc.html`.

**Aesthetic:** macOS 26 "Tahoe" / Liquid Glass. Translucent layered surfaces over a
blurred backdrop, specular top edges, concentric radii, capsule controls, system accents.
Everything below is what those two files actually do — match it, don't approximate it.

---

## 1. Architecture context

A **control plane** holds the registry of **relay nodes**. Each node is an independent
Cloudflare account with its own subdomain quota (Free = 3 tunnels, Pro = 25). The control
plane never carries traffic — it health-checks nodes, collects quotas, and serves the list
to clients, which pick the fastest node with a free slot.

UI consequences: capacity is **per node**, never a global constant. Any string that names a
count must derive it from the registry.

---

## 2. Color

### Accents (Apple system palette)

| Token | Hex | Use |
|---|---|---|
| green | `#30D158` | primary accent, success, live, GET |
| green-hi / green-lo | `#3ADB63` / `#28B84C` | filled-button gradient stops |
| blue | `#0A84FF` | POST, Pro plan badge, links on light |
| orange | `#FF9F0A` | PUT, 4xx, at-capacity |
| red | `#FF453A` | DELETE, 5xx, destructive, offline |
| purple | `#BF5AF2` | PATCH, wallpaper bloom |
| yellow | `#FFDD00` | Buy Me a Coffee brand only |
| yellow-ink | `#E0B400` | readable yellow text on dark |
| star | `#FFD60A` | GitHub star glyph |
| cloudflare | `#F6821F` | Cloudflare mark only |

Traffic lights: `#FF5F57` `#FEBC2E` `#28C840`.

### Glass surfaces

Never use opaque panel fills. Every surface is an alpha over the blurred backdrop.

**Dark**
```
window   rgba(30,30,34,.62)      sidebar  rgba(255,255,255,.045)
content  rgba(20,20,24,.40)      detail   rgba(255,255,255,.035)
toolbar  rgba(255,255,255,.05)   card     rgba(255,255,255,.07)
field    rgba(0,0,0,.26)         chip     rgba(120,120,128,.22)
seg      rgba(0,0,0,.24)         hair     rgba(255,255,255,.11)
rim      rgba(255,255,255,.18)   spec     rgba(255,255,255,.22)
sheet    rgba(24,24,28,.88)      tray     rgba(34,34,38,.72)
text     rgba(255,255,255,.94)   muted    rgba(235,235,245,.54)
```

**Light**
```
window   rgba(250,250,252,.70)   sidebar  rgba(255,255,255,.34)
content  rgba(255,255,255,.55)   detail   rgba(255,255,255,.42)
toolbar  rgba(255,255,255,.50)   card     rgba(255,255,255,.72)
field    rgba(255,255,255,.90)   chip     rgba(120,120,128,.14)
seg      rgba(120,120,128,.14)   hair     rgba(0,0,0,.10)
rim      rgba(255,255,255,.65)   spec     rgba(255,255,255,.85)
sheet    rgba(248,248,250,.92)   tray     rgba(252,252,254,.80)
text     rgba(0,0,0,.88)         muted    rgba(60,60,67,.58)
```

### Blur recipes

```
window  blur(64px) saturate(190%)
panel   blur(50px) saturate(180%)
bar     blur(40px) saturate(180%)
chip    blur(30px) saturate(180%)
```

Always ship the `-webkit-` prefix alongside `backdrop-filter`.

---

## 3. Typography

```
UI      -apple-system, BlinkMacSystemFont, "SF Pro Text", "Geist", system-ui, sans-serif
Display -apple-system, BlinkMacSystemFont, "SF Pro Display", "Geist", system-ui, sans-serif
Mono    "SF Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace
Coffee  "Cookie", cursive   ← Buy Me a Coffee labels ONLY
```

Weights are **510** (medium) and **590** (semibold), not 500/600 — these hit SF Pro's true
optical weights. 400 for body, 700 only for logo marks.

Sizes: screen title 22/600, panel title 18/600, toolbar title 14/590, body 13/400,
label 12/590, caption 11.5/400, eyebrow 10.5/590 uppercase `letter-spacing:.07em`.
Negative tracking on display sizes: `-.02em` to `-.04em`.

Mono carries every technical value — URLs, ports, hosts, counts, latency, timers, headers.
Never set a URL in the UI face.

---

## 4. Geometry & motion

Concentric radii, outer to inner: **26 → 18 → 16 → 14 → 11 → 9 → 7**, plus `999px` capsules.
A child inside a 14px card gets 9 or 11, never 14.

Spacing on a 4px base: 4, 8, 12, 16, 20, 24, 32, 40, 52, 72, 104.

Borders are hairlines — `.5px solid var(hair)`, never 1px.

Motion: `cubic-bezier(.32,.72,0,1)` for anything that moves or scales; plain `ease` for
color and opacity. Durations 180ms (hover), 220ms (state), 350ms (theme).

Elevation
```
window   inset 0 1px 0 0 <spec>, 0 44px 100px -24px rgba(0,0,0,.72), 0 0 0 .5px rgba(0,0,0,.35)
popover  inset 0 .5px 0 <spec>, 0 30px 70px -18px rgba(0,0,0,.75)
card     inset 0 .5px 0 <spec>, 0 1px 3px rgba(0,0,0,.14)
inset    inset 0 1px 2px rgba(0,0,0,.10)
green    inset 0 1px 0 rgba(255,255,255,.32), 0 4px 14px -4px rgba(40,184,76,.7)
focus    0 0 0 3.5px rgba(48,209,88,.28)  + border-color green
```

Every raised glass surface carries a specular top edge (`inset 0 .5px 0 <spec>`). This is
the single most identity-defining detail — omit it and the surface reads flat.

---

## 5. Interaction states — read this before styling any control

**Hover is light, not color.** The fill brightens and a specular edge appears. Never draw a
green outline on hover.

```
--np-hover-fill        dark rgba(255,255,255,.18)   light rgba(120,120,128,.26)
--np-hover-strong      dark rgba(255,255,255,.20)   light rgba(120,120,128,.32)
--np-hover-row         dark rgba(255,255,255,.08)   light rgba(0,0,0,.05)
--np-hover-spec        dark inset 0 .5px 0 rgba(255,255,255,.32)
                       light inset 0 .5px 0 rgba(255,255,255,.60)
--np-hover-row-spec    dark inset 0 .5px 0 rgba(255,255,255,.20)   light none
--np-hover-text        dark rgba(255,255,255,.98)   light rgba(0,0,0,.92)
--np-hover-danger      dark rgba(255,69,58,.24)     light rgba(255,69,58,.16)
--np-hover-danger-text dark #FF9A90                 light #C8281C
```

Declare these under `:root, [data-theme="dark"]` and `[data-theme="light"]`.

**Selected is tinted glass, not a solid fill.**
```
background  rgba(48,209,88,.26)
box-shadow  inset 0 .5px 0 rgba(255,255,255,.32), inset 0 0 0 .5px rgba(48,209,88,.4)
color       unchanged — text keeps its normal color
```
Applies to sidebar nav, selected inspector rows, node radio rows. Semantic colors
(HTTP method, status) **survive selection** — do not flatten them to white.

Cards lift on hover: `translateY(-2px)` plus a deeper shadow. Buttons lift 1px.
Filled green buttons and the coffee pill stay solid — they are true accent buttons, not glass.

Honour `prefers-reduced-motion`.

---

## 6. Components

**Window** — 1200 × 756, radius 26. Traffic lights inline at the top of the sidebar (not a
separate title bar); the red light is the close control. Sidebar 224px, then content column.

**Sidebar** — New Tunnel (filled green, radius 11) → nav list → coffee card (`margin-top:auto`)
→ capacity meter → version row. Nav items: 16px glyph, label, right-aligned mono count.

**Toolbar** — 52px, hairline bottom, blurred. Title (590/14, `flex:none`), subtitle
(mono 12, muted, `flex:1 min-width:0`, ellipsis — this is the element that truncates),
then right-side pills, all `flex:none; white-space:nowrap`.

**Segmented control** — capsule track (`seg`), 2px padding. Active pill gets a white/22%
fill in dark, `#fff` in light, plus the knob shadow. Used for filters, tabs, theme, language.

**Switch** — 38 × 22, knob 18, `translateX(16px)` when on, track green when on.

**Field** — radius 10, hairline, `field` background, inset shadow. Focus: green border +
3.5px ring. Combined fields (host : port, subdomain + suffix) are one bordered row with
borderless inputs inside and a hairline divider.

**Sheet** — drops from the top edge, centered, over a `rgba(0,0,0,.34)` scrim, radius 20.
Buttons in a divided footer row, the affirmative on the right in green.

**Popover** — radius 18, tray glass, `np-tray` entry animation.

---

## 7. Layout rules that were bugs before

- Every flex child that holds text needs `min-width:0`, or it refuses to shrink and pushes
  the parent past its bounds.
- In a **column**, `flex-basis` sizes height. Use `width` + `align-self:flex-start` to
  constrain a field's width.
- Scroll regions need `min-height:0` on every ancestor up to the fixed-height box, or the
  content grows the container instead of scrolling.
- Meta rows (target · node · count · timer) wrap as a whole: `flex-wrap:wrap; gap:4px 14px`,
  each span `flex:none; white-space:nowrap`. Never let them squeeze word-by-word.
- The full-bleed backdrop lives in its own absolutely-positioned, `overflow:hidden` layer —
  putting `overflow-x:hidden` on the page root makes it a scroll container and breaks
  `position:sticky` in the nav.
- Use flex/grid + `gap` for every sibling group. Never whitespace or per-element margins.

---

## 8. Copy rules

- **Never say "free"** as a pricing claim. The 3-tunnel cap is a Cloudflare account quota,
  not a paywall — say so: "a Cloudflare account quota, not a paywall".
- Counts read "1 of 3 slots remaining", never "1 slot free". Singular/plural must be handled.
- Say **relay node** and **control plane**. Not master/slave.
- Sponsored placeholder sells the slot: "Your message here / One sponsored card per screen,
  no tracking." CTA "Sponsor NPort".
- Buy Me a Coffee labels are always set in Cookie with the cup icon and `#FFDD00`.
- Attribution: "Created by Nick — Ngoc Pham", "Made with ❤️ in Vietnam", footer only.
- State the reason with the ask: "No paid tier. Coffees cover the server bill."

---

## 9. Monetisation gating

The site embeds the real app component with `embed: true`, which must hide **all**
monetisation and demo chrome: wallpaper, theme toggle, demo buttons, sidebar coffee card,
toolbar star pill, sponsored slot, and the Supporter/Support sections in Settings.

The sponsored card is additionally hidden when: the user is a verified supporter, they
dismissed it, the current screen is Settings, onboarding is open, or the window is in the
menu-bar state. Never advertise on the screen where someone is paying you.

Supporter verification is email-OTP. **Check the address against the Buy Me a Coffee
supporter list server-side before sending a code** — otherwise anyone who guesses a donor's
email gets ad-free.

---

## 10. Assets

```
assets/nport-logo-dark.png    white mark  → dark theme
assets/nport-logo-light.png   black mark  → light theme
assets/buy-me-a-coffee.png    cup glyph
```

Ship both logo variants with literal `src` and toggle `display` — a templated `src` 404s
during render. Inline the GitHub, npm and Cloudflare marks as SVG with `fill="currentColor"`.

---

## 11. Accessibility

Contrast: muted text is the floor — do not go below `rgba(235,235,245,.54)` on dark.
The dark coffee cup needs a `#FFDD00` chip behind it on dark surfaces to stay legible.

Hit targets 44px on touch, 28px minimum on desktop. Visible focus rings on every control
(the green 3.5px ring). Full keyboard navigation — not yet designed, needs doing.
Semantic roles on segmented controls (`radiogroup`/`radio`, `tablist`/`tab`) and
`aria-pressed` on switches.

---

## 12. Still undesigned

- Own-Cloudflare onboarding: API token entry, zone selection, permission validation
- Registering a private relay node from the app
- "Follow system" theme — only light and dark exist
- Windows and Linux shells (this design is macOS-only)
- Keyboard shortcuts and focus order
- Inspector: search, copy-as-cURL, empty and error states
- Per-tunnel vs global inspector scope — pick one before building
