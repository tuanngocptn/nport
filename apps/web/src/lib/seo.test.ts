import { describe, expect, it } from "vitest"

import { FAQS, FEATURES, STEPS, shippingFaqs, shippingFeatures } from "../content/site"
import {
  faqPageJsonLd,
  homeJsonLd,
  pageMetadata,
  SITE_URL,
  serializeJsonLd,
  softwareApplicationJsonLd,
} from "./seo"

/**
 * Structured data is the only part of the site nobody looks at.
 *
 * Nothing renders it, no reviewer opens it, and a false claim inside it survives every visual check — so
 * the claims have to be derived and the derivation has to be asserted. v2 is the worked example: its
 * `SoftwareApplication` said `softwareRequirements: "Node.js"` and `softwareVersion: "2.1.3"` long after
 * both were wrong, and its `FAQPage` described five questions the page never showed.
 */

describe("the four blocks", () => {
  it("emits exactly the four types rule 3 requires", () => {
    // `apps/web/CLAUDE.md` rule 3 names them. A block quietly dropped during a refactor is invisible
    // otherwise: the page still renders, and only a crawler notices.
    expect(homeJsonLd().map((block) => block["@type"])).toEqual([
      "WebSite",
      "SoftwareApplication",
      "HowTo",
      "FAQPage",
    ])
  })

  it("gives every block a context and a distinct id", () => {
    const ids = homeJsonLd().map((block) => {
      expect(block["@context"]).toBe("https://schema.org")
      return block["@id"]
    })
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("uses absolute https urls throughout", () => {
    // Relative URLs are legal JSON and meaningless to a crawler, which resolves nothing.
    for (const url of JSON.stringify(homeJsonLd()).match(/"[^"]*:\/\/[^"]*"/g) ?? []) {
      expect(url).toMatch(/^"https:\/\//)
    }
  })

  it("hardcodes no version and no year", () => {
    // Rule 8, and the specific thing v2 got wrong here: `softwareVersion: "2.1.3"` and two `date*`
    // fields, all three stale by the time anyone looked. `PT1M` is a duration, not a date.
    const json = JSON.stringify(homeJsonLd())
    expect(json).not.toMatch(/\b\d+\.\d+\.\d+\b/)
    expect(json).not.toMatch(/\b(19|20)\d\d\b/)
  })
})

describe("SoftwareApplication", () => {
  it("advertises exactly the features the page renders", () => {
    // The load-bearing assertion of this file. `featureList` is derived from the same array the grid
    // renders, so it cannot describe a capability the site is careful not to claim.
    expect(softwareApplicationJsonLd().featureList).toEqual(
      shippingFeatures().map((feature) => feature.title),
    )
  })

  it("advertises nothing held back for a later phase", () => {
    // The same property stated as a consequence, because it is the one that matters: the withheld
    // features are a desktop app, an inspector, and replay. Naming them here means this test still bites
    // if `featureList` is ever rewritten by hand instead of derived.
    const withheld = FEATURES.filter((feature) => feature.ships !== "3.0")
    expect(withheld.length).toBeGreaterThan(0)
    const list = softwareApplicationJsonLd().featureList as string[]
    for (const feature of withheld) {
      expect(list, feature.title).not.toContain(feature.title)
    }
  })

  it("claims no runtime requirement", () => {
    // v2 said "Node.js". The connector has been a native Rust binary since ADR-0002 and npm is one of
    // four install channels, so the field is absent rather than corrected.
    expect(softwareApplicationJsonLd()).not.toHaveProperty("softwareRequirements")
  })

  it("names all three platforms the CLI is built for", () => {
    const operatingSystem = String(softwareApplicationJsonLd().operatingSystem)
    for (const platform of ["macOS", "Linux", "Windows"]) {
      expect(operatingSystem).toContain(platform)
    }
  })

  it("references no logo or screenshot, because neither exists", () => {
    // v2's `logo`, `image` and `screenshot` pointed at `/assets/` paths this app does not serve.
    //
    // The OpenGraph card is **not** the thing to point them at, now that one exists: `screenshot` means a
    // picture of the software running and `logo` means a mark, and the card is neither — it is type on a
    // dark field. Filling these with it would be structured data that is present and wrong, which is
    // worse than absent, and worse in the way nobody notices.
    const block = softwareApplicationJsonLd()
    for (const field of ["logo", "image", "screenshot"]) {
      expect(block, field).not.toHaveProperty(field)
    }
  })
})

describe("HowTo and FAQPage", () => {
  it("matches the steps the page shows, in order", () => {
    const steps = howToSteps()
    expect(steps).toHaveLength(STEPS.length)
    expect(steps.map((step) => step.position)).toEqual(STEPS.map((_, index) => index + 1))
    expect(steps.map((step) => step.name)).toEqual(STEPS.map((step) => step.title))
  })

  it("strips the markdown the copy carries for the page's benefit", () => {
    // `STEPS` writes `` `nport 3000` `` because `inlineMarkdown` renders it as code. A crawler renders
    // the backtick.
    expect(STEPS.some((step) => step.description.includes("`"))).toBe(true)
    for (const step of howToSteps()) {
      expect(step.text).not.toContain("`")
    }
  })

  it("asks only the questions the page answers", () => {
    // Google requires `FAQPage` content be visible on the page carrying it, which v2 ignored. Both sides
    // come from `FAQS`, so the only way to break this is to stop rendering `sections/faq.tsx`.
    const questions = faqQuestions()
    expect(questions.map((question) => question.name)).toEqual(
      shippingFaqs().map((entry) => entry.question),
    )
    for (const question of questions) {
      expect(question.acceptedAnswer.text.length, question.name).toBeGreaterThan(20)
    }
  })

  it("withholds the question about a feature that does not exist", () => {
    const withheld = FAQS.filter((entry) => entry.ships !== "3.0")
    expect(withheld.length).toBeGreaterThan(0)
    const asked = faqQuestions().map((question) => question.name)
    for (const entry of withheld) {
      expect(asked, entry.question).not.toContain(entry.question)
    }
  })
})

describe("serialization", () => {
  it("cannot close the script element it sits in", () => {
    const escaped = serializeJsonLd({ "@type": "Test", name: "</script><script>alert(1)</script>" })
    expect(escaped).not.toContain("</script")
    expect(escaped).not.toContain("<")
    // Still JSON, and still the original string once parsed — the escape is a transport detail.
    expect(JSON.parse(escaped).name).toBe("</script><script>alert(1)</script>")
  })

  it("round-trips every block the page emits", () => {
    for (const block of homeJsonLd()) {
      expect(JSON.parse(serializeJsonLd(block))).toEqual(block)
    }
  })
})

describe("pageMetadata", () => {
  it("gives each page its own canonical", () => {
    // The bug this function exists to prevent: a `canonical` set once in the layout is inherited by
    // every route, which would tell Google the home page is the canonical version of all 33 error pages.
    const home = pageMetadata({ path: "/", title: "a", description: "b" })
    const error = pageMetadata({ path: "/errors/subdomain-in-use", title: "c", description: "d" })

    expect(home.alternates?.canonical).toBe("/")
    expect(error.alternates?.canonical).toBe("/errors/subdomain-in-use")
    expect(error.openGraph?.url).toBe("/errors/subdomain-in-use")
  })

  it("promises a large image card, and names no image itself", () => {
    const metadata = pageMetadata({ path: "/", title: "a", description: "b" })
    // @ts-expect-error `twitter` is a union and only the card variants carry `card`; the assertion is
    // the point of reading it.
    expect(metadata.twitter?.card).toBe("summary_large_image")
    // `src/app/opengraph-image.tsx` is a file convention — Next injects `og:image` from it. Setting
    // `images` here as well would be two sources for one image, and the file would win silently.
    expect(metadata.openGraph).not.toHaveProperty("images")
  })

  it("keeps the title and description consistent across all three surfaces", () => {
    // A card that disagrees with the page's own title is the failure mode of writing them separately.
    const metadata = pageMetadata({ path: "/x", title: "Title", description: "Description" })
    expect(metadata.openGraph?.title).toBe("Title")
    expect(metadata.openGraph?.description).toBe("Description")
    expect(metadata.twitter?.title).toBe("Title")
  })
})

it("points the site at one origin", () => {
  // Not derived from a request: a preview deployment echoing its own hostname here would publish
  // canonical tags naming itself, which is how a preview URL outranks production.
  expect(SITE_URL).toBe("https://nport.link")
})

interface HowToStep {
  readonly position: number
  readonly name: string
  readonly text: string
}

function howToSteps(): HowToStep[] {
  const block = homeJsonLd().find((entry) => entry["@type"] === "HowTo")
  return (block?.step ?? []) as HowToStep[]
}

interface FaqQuestion {
  readonly name: string
  readonly acceptedAnswer: { readonly text: string }
}

function faqQuestions(): FaqQuestion[] {
  return (faqPageJsonLd().mainEntity ?? []) as FaqQuestion[]
}
