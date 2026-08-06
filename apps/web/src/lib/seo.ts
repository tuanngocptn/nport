import type { Metadata } from "next"

import { LINKS, STEPS, shippingFaqs, shippingFeatures } from "../content/site"

/**
 * The four JSON-LD blocks (`apps/web/CLAUDE.md` rule 3), built from the copy rather than beside it.
 *
 * v2's structured data was its most deliberate SEO investment and it is the one piece of the site that
 * no reviewer ever reads: nothing renders it, so a claim in here can be false for years. This module
 * therefore takes its facts from `src/content/site.ts` — the same array the page renders — so a feature
 * held back for Phase 4 is absent from `featureList` for the same reason it is absent from the grid.
 * `apps/web/CLAUDE.md` § Common tasks used to say "update the JSON-LD to match, or structured data
 * starts lying"; a derivation is what makes that instruction unnecessary.
 *
 * ## What v2 had here that is not carried forward
 *
 * - **`softwareRequirements: "Node.js"`** — false since the rewrite. The connector is a native Rust
 *   binary (ADR-0002) and npm is one of four install channels, so this told crawlers NPort needs a
 *   runtime it does not need.
 * - **`softwareVersion`, `datePublished`, `dateModified`** — v2 hardcoded `2.1.3` and two dates, which
 *   rule 8 forbids and which had already gone stale. All three are optional in schema.org and none is
 *   used by any rich result, so they are omitted rather than wired to a build-time constant that would
 *   claim a content change on every unrelated rebuild.
 * - **`logo`, `image`, `screenshot`** — they pointed at `/assets/` files that do not exist in this app.
 *   They stay absent even now that `/opengraph-image` exists: `screenshot` means a picture of the software
 *   running and `logo` means a mark, and a social card is neither. Present-and-wrong is worse than absent.
 */

/**
 * The production origin, absolute because canonical URLs and JSON-LD `@id`s cannot be relative.
 *
 * One constant rather than a binding: unlike `apps/api`, which serves several zones and reads
 * `CF_DOMAIN` for that reason, this app is the single public site. A preview deployment that echoed its
 * own hostname here would publish canonical tags pointing at itself, which is how preview URLs end up
 * outranking production.
 */
export const SITE_URL = "https://nport.link"

/** One sentence, shared by the meta description, the `WebSite` block and the OpenGraph card. */
export const SITE_DESCRIPTION =
  "Give your local development server a public HTTPS URL. NPort is a free, open-source ngrok alternative with custom subdomains and no account, running on Cloudflare's edge."

/** Carried from v2. Search engines have ignored this for over a decade; it costs nothing and is parity. */
export const SITE_KEYWORDS = [
  "nport",
  "ngrok alternative",
  "localhost tunnel",
  "http tunnel",
  "https tunnel",
  "webhook testing",
  "cloudflare tunnel",
  "custom subdomain",
  "open source tunnel",
  "port forwarding",
]

/**
 * One page's canonical URL, OpenGraph card and Twitter card, from its own path.
 *
 * A function rather than a layout-level default because Next lets a page inherit the layout's
 * `alternates` and `openGraph` wholesale: a canonical set once at the top would name the home page as the
 * canonical version of all 33 error pages, and an OG card set once would give each of them the home
 * page's title. Both are silent — nothing renders a canonical tag — so the safeguard has to be that every
 * page passes its own `path` and a test asserts the result contains it.
 *
 * **The image is not set here.** `src/app/opengraph-image.tsx` is a file convention: Next injects
 * `og:image` and its dimensions into every page from that file alone, so setting `openGraph.images` would
 * be a second source for one image. `twitter.card` is `summary_large_image` because there is now a
 * 1200×630 card to justify it — it was `summary` while there was not, since a large-image card with no
 * image renders worse than a small one.
 */
export function pageMetadata({
  path,
  title,
  description,
}: {
  path: string
  title: string
  description: string
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "NPort",
      locale: "en_US",
      url: path,
      title,
      description,
    },
    twitter: { card: "summary_large_image", title, description },
  }
}

/**
 * Strips the inline markdown the copy carries for the page's benefit.
 *
 * `src/content/site.ts` writes `` `nport 3000` `` because `inlineMarkdown` renders it as code. A crawler
 * does no such thing, so a backtick left in JSON-LD is a backtick a search result displays.
 */
function plain(text: string): string {
  return text.replaceAll("`", "")
}

export function webSiteJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: "NPort",
    alternateName: ["nport", "nport.link"],
    url: `${SITE_URL}/`,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: {
      "@type": "Organization",
      "@id": `${SITE_URL}/#project`,
      name: "NPort",
      url: `${SITE_URL}/`,
      sameAs: [LINKS.github, LINKS.npm],
    },
  }
}

export function softwareApplicationJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: "NPort",
    alternateName: "nport",
    description: SITE_DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Networking Tool",
    // The three targets `crates/cli` builds for. Kept as one string because schema.org models it that
    // way; the release matrix in docs/RELEASE.md is the authority on the specific triples.
    operatingSystem: "macOS, Linux, Windows",
    url: `${SITE_URL}/`,
    downloadUrl: LINKS.npm,
    installUrl: LINKS.npm,
    codeRepository: LINKS.github,
    license: LINKS.license,
    // Both, because they mean different things to a crawler: no price, and no paywall behind the price.
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    author: {
      "@type": "Person",
      name: "Nick - Ngoc Pham",
      url: LINKS.author,
    },
    // **The load-bearing line of this file.** Derived, so the block advertises exactly what the features
    // grid advertises — never the desktop app, the inspector, or replay.
    featureList: shippingFeatures().map((feature) => feature.title),
  }
}

export function howToJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "@id": `${SITE_URL}/#howto`,
    name: "How to give your localhost a public HTTPS URL with NPort",
    description: "Three steps from a local port to a URL anyone can open.",
    totalTime: "PT1M",
    step: STEPS.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.title,
      text: plain(step.description),
      url: `${SITE_URL}/#how`,
    })),
  }
}

/**
 * `FAQPage`, from the same array `sections/faq.tsx` renders.
 *
 * Google requires the Q&A be visible on the page it is marked up on. v2 satisfied neither half of that —
 * five questions in the markup, none on the page — so the section exists partly because this block does.
 */
export function faqPageJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${SITE_URL}/#faq`,
    mainEntity: shippingFaqs().map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  }
}

/**
 * Everything the home page emits, in four separate `<script>` tags as v2 did.
 *
 * Four blocks rather than one `@graph`: they are independent claims, and a validator that rejects one
 * should not take the other three with it.
 */
export function homeJsonLd(): ReadonlyArray<Record<string, unknown>> {
  return [webSiteJsonLd(), softwareApplicationJsonLd(), howToJsonLd(), faqPageJsonLd()]
}

/**
 * A block as it goes into the document, with every `<` replaced by its unicode escape.
 *
 * Every value above is a constant in this repository, so there is no untrusted input to sanitise — but
 * the one string that ends a script element early is a closing script tag, and a JSON-LD block is
 * written by hand often enough that "no such string exists today" is not a property worth depending on.
 * A unicode escape is valid JSON and parses back to the same character, so this costs nothing.
 */
export function serializeJsonLd(block: Record<string, unknown>): string {
  return JSON.stringify(block).replaceAll("<", "\\u003c")
}
