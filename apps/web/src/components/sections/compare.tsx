import { shippingCompareRows } from "../../content/site"

/**
 * `#compare` — the ngrok table. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * **Placing this was an open decision** (`apps/web/CLAUDE.md` rule 1): the v2 section order has no slot
 * for it, and the mockup puts it between features and download. Kept there, which in the fixed order means
 * after `powered-by` and immediately before the CTA — so the v2 sequence is intact and the new section
 * slots into the one gap it leaves.
 *
 * That position is also the strongest one available: a reader who has just seen what NPort does and where
 * it runs is exactly the one asking how it differs. Moving it earlier would argue with a competitor
 * before saying what the product is.
 *
 * Every row is checkable against something in this repository. The design's `Request inspector` row is
 * withheld until Phase 4: a table that names a competitor is the last place to be optimistic.
 */
export function Compare() {
  return (
    <section id="compare" className="mx-auto max-w-3xl px-6 py-16">
      <h2 className="font-display text-2xl tracking-tight text-text sm:text-3xl">NPort vs ngrok</h2>

      {/* Scrolls inside itself rather than widening the page, which is the rule for any wide block. */}
      <div className="mt-8 overflow-x-auto rounded-lg border border-hair bg-card shadow-card">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            How NPort compares to ngrok on price, subdomains, accounts, concurrency, self-hosting
            and licence.
          </caption>
          <thead>
            <tr className="border-b border-hair">
              <th scope="col" className="px-4 py-3 font-medium text-muted">
                Feature
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-green">
                NPort
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-muted">
                ngrok
              </th>
            </tr>
          </thead>
          <tbody>
            {shippingCompareRows().map((row) => (
              <tr key={row.feature} className="border-b border-hair last:border-0">
                <th scope="row" className="px-4 py-3 font-normal text-muted">
                  {row.feature}
                </th>
                <td className="px-4 py-3 font-medium text-text">{row.nport}</td>
                <td className="px-4 py-3 text-muted">{row.ngrok}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted">
        Compared against ngrok's published free tier. If something here is out of date, please open
        an issue — a comparison that has gone stale is worse than none.
      </p>
    </section>
  )
}
