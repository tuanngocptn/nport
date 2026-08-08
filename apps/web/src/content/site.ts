/**
 * The marketing copy, as data — and the record of where it departs from the mockup.
 *
 * `docs/mockup/NPort Site.dc.html` is the approved design and this follows its structure, order and
 * aesthetic. It is **not** the authority on claims: its own README says so ("the design is not the
 * authority on behaviour... those win and the design is wrong"), and here that rule bites hard.
 *
 * ## The problem
 *
 * The design was drawn for the finished product, desktop app included. The site ships at the 3.0
 * announcement, which is **before** Phase 4 — so a straight transcription of its copy would advertise:
 *
 * - a desktop app that is a booting scaffold (`docs/ROADMAP.md` Phase 4),
 * - a live request inspector, whose UI is Phase 4 and whose CLI equivalent is on the **Deferred** list,
 * - request **replay**, which is on the Deferred list explicitly,
 * - a menu bar, presets and history — all Phase 4.
 *
 * Four of its eight features and most of its hero. Shipping that is not a rendering decision, it is a
 * false claim on a public page, and `apps/web/CLAUDE.md` already warns that structured data "starts
 * lying" when copy and reality diverge.
 *
 * ## What this file does about it
 *
 * Every feature the design lists is **kept here with an honest `ships` tag**, and the page renders only
 * the ones true today. Nothing is silently dropped, so Phase 4 is a status flip rather than an
 * archaeology exercise — and `site.test.ts` asserts the rendered set contains nothing untrue, which
 * makes "do not lie in marketing" a check rather than a habit.
 */

/**
 * The hero, as data.
 *
 * Here rather than inside `sections/hero.tsx` because **the OpenGraph card renders the same words**
 * (`src/app/opengraph-image.tsx`). A social card that disagreed with the page it links to is the same
 * class of problem as structured data that does — invisible to anyone reading either one alone.
 *
 * `headline` is two lines because the design breaks it: the page renders a `<br />` between them, and the
 * card renders them as separate rows. Joining them with a space is what a reader of the array gets.
 */
export const HERO = {
  /** The design's, verbatim — it is true and it is good. */
  headline: ["Your tunnels, your Cloudflare,", "your rules."],
  supporting:
    "Expose localhost over Cloudflare's edge with one command — custom subdomains, automatic HTTPS, and the option to run every tunnel on infrastructure you own. No account, ever.",
  /** One string, because it appeared in two components before this and could have drifted in either. */
  command: "npx nport 3000",
  commandNote: "No signup. No config file. A public HTTPS URL in a couple of seconds.",
} as const

/** When a claim becomes true. The page renders `"3.0"` and nothing else. */
export type Ships = "3.0" | "phase-4" | "deferred"

export interface Feature {
  readonly title: string
  readonly description: string
  readonly ships: Ships
  /** Why it is not `"3.0"` yet, and where that is decided. Required for anything unshipped. */
  readonly because?: string
}

/**
 * The design's eight features, with what is actually true.
 *
 * Titles are kept verbatim where the claim survives, so a diff against the mockup stays readable.
 */
export const FEATURES: readonly Feature[] = [
  {
    title: "Custom subdomains",
    description:
      "No paid tier gating the URL you want. The tunnel cap is your Cloudflare account quota, not a paywall.",
    ships: "3.0",
  },
  {
    title: "Bring your own backend",
    description:
      "Point NPort at your own Cloudflare account and the shared infrastructure drops out entirely.",
    ships: "3.0",
  },
  {
    title: "Automatic HTTPS",
    description:
      "TLS terminated at Cloudflare's edge. WebSocket and Server-Sent Events pass straight through.",
    ships: "3.0",
  },
  {
    title: "Three tunnels at once",
    description: "Run your app, your webhook receiver and a teammate preview side by side.",
    ships: "3.0",
  },
  {
    title: "No account, ever",
    description:
      "No signup, no API key, no dashboard. Abuse control happens without knowing who you are.",
    // Not in the mockup's feature grid, and it is the product's defining property (invariant 1) —
    // worth a card of its own once the four desktop features below are not there to fill the row.
    ships: "3.0",
  },
  {
    title: "Runs anywhere you do",
    description:
      "One static binary for macOS, Linux and Windows. Install it from npm, Homebrew or Scoop.",
    ships: "3.0",
  },
  {
    title: "Live request inspector",
    description: "Method, status, timing, headers and body for every request through the tunnel.",
    ships: "phase-4",
    because:
      "`core::inspector` is built and tested, but the UI over it is Phase 4 and CLI traffic inspection is on docs/ROADMAP.md's Deferred list — so there is nothing a user can look at yet.",
  },
  {
    title: "Replay any request",
    description:
      "Re-issue a captured request against your local server without re-triggering the sender.",
    ships: "deferred",
    because:
      "Explicitly on docs/ROADMAP.md's Deferred list. Being drawn in the mockup does not schedule it.",
  },
  {
    title: "Menu bar control",
    description: "Copy a URL or stop a tunnel without leaving whatever you were doing.",
    ships: "phase-4",
    because: "Part of the desktop app, which is Phase 4 — after this site ships.",
  },
  {
    title: "Presets and history",
    description:
      "Reopen yesterday's tunnel with the same port, subdomain and options in one click.",
    ships: "phase-4",
    because: "Part of the desktop app, which is Phase 4 — after this site ships.",
  },
]

/** The three steps, verbatim from the design except where they named the app. */
export const STEPS: ReadonlyArray<{ n: string; title: string; description: string }> = [
  {
    n: "1",
    title: "Pick a port",
    // The design says "or choose from the ones NPort detects", which is the desktop app's port
    // detection (`docs/FEATURES.md` §7, Phase 4). The CLI takes the port you give it.
    description: "Run `nport 3000` against whatever your dev server is already listening on.",
  },
  {
    n: "2",
    title: "Name your URL",
    description:
      "Claim any free subdomain — `myapp.nport.link` — and it stays yours for the session.",
  },
  {
    n: "3",
    title: "Share it",
    // The design's third step is "Watch the traffic" in the inspector. That is Phase 4, so the step
    // that is actually true at 3.0 is the one the tunnel exists for.
    description:
      "The URL is live on the public internet, over HTTPS, from the moment it is claimed.",
  },
]

export interface CompareRow {
  readonly feature: string
  readonly nport: string
  readonly ngrok: string
  readonly ships: Ships
  readonly because?: string
}

/**
 * The ngrok comparison.
 *
 * Every row is checkable against something in this repository, which is the standard a comparison table
 * has to meet: it names a competitor, so a row that is merely optimistic is a row that is wrong about
 * someone else.
 */
export const COMPARE: readonly CompareRow[] = [
  { feature: "Price", nport: "Free", ngrok: "Free tier, limited", ships: "3.0" },
  { feature: "Custom subdomains", nport: "Always", ngrok: "Paid only", ships: "3.0" },
  { feature: "Account required", nport: "No", ngrok: "Yes", ships: "3.0" },
  // `MAX_CONCURRENT_PER_SOURCE` in apps/node/wrangler.jsonc.
  { feature: "Concurrent tunnels", nport: "3", ngrok: "1 on free", ships: "3.0" },
  // `--backend`, and docs/SELF_HOSTING.md.
  { feature: "Self-hostable backend", nport: "Yes", ngrok: "No", ships: "3.0" },
  { feature: "Open source", nport: "MIT", ngrok: "Proprietary", ships: "3.0" },
  {
    feature: "Request inspector",
    nport: "Built in",
    ngrok: "Built in",
    ships: "phase-4",
    because:
      "The design's table claims this for NPort. At 3.0 there is no inspector a user can open, so the row would be false in the one place a reader is comparing us to somebody else.",
  },
]

export interface FaqEntry {
  readonly question: string
  readonly answer: string
  readonly ships: Ships
  readonly because?: string
}

/**
 * The FAQ — rendered as a section **and** as `FAQPage` structured data, from this one list.
 *
 * That coupling is the point. v2 shipped a `FAQPage` block containing five questions and rendered none
 * of them anywhere on the page, which is invalid by Google's own rule (the Q&A has to be visible on the
 * source page) and is the exact failure `apps/web/CLAUDE.md` names when it says structured data "starts
 * lying". Deriving both from one array means the markup cannot describe content the page does not show.
 *
 * Answers are plain prose, not markdown: `src/lib/seo.ts` puts them in JSON-LD verbatim, and a stray
 * backtick would be rendered as a literal character by a crawler.
 */
export const FAQS: readonly FaqEntry[] = [
  {
    question: "What is NPort?",
    answer:
      "NPort gives your local development server a public HTTPS URL. It is a free, open-source alternative to ngrok, and it runs over Cloudflare's edge network rather than servers of its own.",
    ships: "3.0",
  },
  {
    question: "Do I need an account?",
    answer:
      "No. There is no signup, no API key and no dashboard, and there never will be — abuse control works without knowing who you are. Install it and run it.",
    ships: "3.0",
  },
  {
    question: "How do I install it?",
    answer:
      "Run npx nport 3000 to start a tunnel without installing anything. To keep it around, install it with npm i -g nport, or from Homebrew or Scoop.",
    ships: "3.0",
  },
  {
    question: "Is HTTPS automatic?",
    answer:
      "Yes. TLS is terminated at Cloudflare's edge, so every tunnel is HTTPS from the moment it is claimed and there are no certificates to manage.",
    ships: "3.0",
  },
  {
    question: "Does it support WebSockets?",
    answer:
      "Yes. WebSocket connections and Server-Sent Events pass through the tunnel alongside ordinary HTTP requests.",
    ships: "3.0",
  },
  {
    question: "How long does a tunnel last?",
    answer:
      // Deliberately not a number. `LEASE_TTL_SECONDS` is a server binding that differs between staging
      // and production, the API publishes the live value at GET /v1/meta, and the server is the only
      // authority on it (invariant 3). A duration typed into a static page is a client enforcing a
      // limit it does not own, and it goes stale the first time the binding changes.
      "As long as your client keeps renewing it. The server owns that limit and publishes the current one through its API; nport shows you the expiry it was given rather than deciding one itself.",
    ships: "3.0",
  },
  {
    question: "Can I run it on my own Cloudflare account?",
    answer:
      "Yes. Point NPort at your own account with --backend and the shared infrastructure drops out entirely: your tunnels, your zone, your logs.",
    ships: "3.0",
  },
  {
    question: "Can I inspect the requests going through the tunnel?",
    answer:
      "Yes — every request through the tunnel shows its method, status, timing, headers and body.",
    ships: "phase-4",
    because:
      "Same deferral as the 'Live request inspector' feature above: the capture side exists in core::inspector, but the UI over it is Phase 4 and CLI traffic inspection is on docs/ROADMAP.md's Deferred list.",
  },
]

/** Everything the page renders: the claims that are true now. */
export function shippingFeatures(): readonly Feature[] {
  return FEATURES.filter((feature) => feature.ships === "3.0")
}

export function shippingCompareRows(): readonly CompareRow[] {
  return COMPARE.filter((row) => row.ships === "3.0")
}

export function shippingFaqs(): readonly FaqEntry[] {
  return FAQS.filter((entry) => entry.ships === "3.0")
}

/** External destinations, in one place so `rel`/`target` cannot be forgotten per-link. */
export const LINKS = {
  github: "https://github.com/tuanngocptn/nport",
  issues: "https://github.com/tuanngocptn/nport/issues",
  npm: "https://www.npmjs.com/package/nport",
  coffee: "https://www.buymeacoffee.com/tuanngocptn",
  license: "https://github.com/tuanngocptn/nport/blob/main/LICENSE",
  author: "https://github.com/tuanngocptn",
} as const
