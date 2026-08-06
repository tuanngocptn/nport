import { describe, expect, it } from "vitest"

import { COMPARE, FEATURES, LINKS, STEPS, shippingCompareRows, shippingFeatures } from "./site"

/**
 * The marketing page must not claim something NPort does not do.
 *
 * This is the enforcement half of a decision `src/content/site.ts` explains: the approved design was
 * drawn for the finished product, and a straight transcription of its copy would advertise a desktop
 * app, a request inspector and request replay — none of which exist when this site ships, and the last
 * of which is on `docs/ROADMAP.md`'s Deferred list.
 *
 * The design's own README says the design is not the authority on behaviour. That rule now has a test
 * behind it rather than a reviewer's memory, which is the difference this repository keeps rediscovering.
 */

describe("the page renders only claims that are true", () => {
  it("ships no feature that is waiting on a later phase", () => {
    for (const feature of shippingFeatures()) {
      expect(feature.ships, feature.title).toBe("3.0")
    }
  })

  it("ships no comparison row that is waiting on a later phase", () => {
    // A table that names a competitor is the last place to be optimistic: an unshipped row here is a
    // claim about somebody else's product as well as our own.
    for (const row of shippingCompareRows()) {
      expect(row.ships, row.feature).toBe("3.0")
    }
  })

  it("keeps the withheld claims rather than deleting them", () => {
    // The point of tagging instead of cutting: Phase 4 should be a status flip, not archaeology. If this
    // ever reaches zero, someone has quietly dropped the design's copy instead of deferring it.
    const withheld = FEATURES.filter((feature) => feature.ships !== "3.0")
    expect(withheld.length).toBeGreaterThan(0)
  })

  it("makes every withheld claim say why, and where that is decided", () => {
    // Without this, "phase-4" is an assertion with no evidence — and the next person to read the list
    // cannot tell a deliberate deferral from a guess.
    for (const item of [...FEATURES, ...COMPARE]) {
      if (item.ships !== "3.0") {
        expect(item.because, "ships" in item ? JSON.stringify(item) : "").toBeTruthy()
        expect(item.because?.length ?? 0).toBeGreaterThan(20)
      }
    }
  })
})

describe("the copy itself", () => {
  it("still renders something in each section", () => {
    // A filter that accidentally excluded everything would leave an empty grid and an empty table, which
    // reads as a broken page rather than as a cautious one.
    expect(shippingFeatures().length).toBeGreaterThanOrEqual(4)
    expect(shippingCompareRows().length).toBeGreaterThanOrEqual(5)
    expect(STEPS).toHaveLength(3)
  })

  it("hardcodes no version number or year", () => {
    // Rule 7. A version in marketing copy is the thing that goes stale first, and a copyright year is
    // the classic one — both are derived or omitted, never typed.
    const prose = [
      ...FEATURES.map((f) => `${f.title} ${f.description}`),
      ...STEPS.map((s) => `${s.title} ${s.description}`),
      ...COMPARE.map((r) => `${r.feature} ${r.nport} ${r.ngrok}`),
    ].join(" ")

    expect(prose).not.toMatch(/\bv?\d+\.\d+\.\d+\b/)
    expect(prose).not.toMatch(/\b20\d\d\b/)
  })

  it("points every external link at https", () => {
    // The components set `target="_blank" rel="noopener noreferrer"` per rule 9; this catches the other
    // half, which is that a link collected here is a real destination and not a placeholder.
    for (const [name, url] of Object.entries(LINKS)) {
      expect(url, name).toMatch(/^https:\/\//)
    }
  })
})
