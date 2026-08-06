import { shippingFaqs } from "../../content/site"

/**
 * `#faq` — the questions, visible.
 *
 * **This section is not in the mockup.** It exists because `apps/web/CLAUDE.md` rule 3 requires a
 * `FAQPage` JSON-LD block and Google requires that block's Q&A to be visible on the page carrying it.
 * v2 satisfied the first half and not the second: five questions in the markup, none rendered anywhere.
 * Copying that would have shipped structured data describing content the site does not have.
 *
 * **Placed after the CTA rather than inside the sequence**, which is the least invasive answer to rule 1.
 * `#compare` was inserted mid-sequence because the mockup shows it there; the mockup has no FAQ at all,
 * so there is no designed position to honour — and appending keeps navbar → hero → how → features →
 * powered-by → CTA at the same depth it converts at. Whoever reached the CTA and did not click is also
 * exactly the reader with a question left.
 *
 * Not in the navbar for the same reason: the mockup specifies that bar, and `#faq` still resolves for
 * anyone linking to it.
 *
 * `<details>` rather than a client component — disclosure is native, so this stays a server component
 * (rule 5) and the answers are in the HTML for a crawler whether or not they are open.
 */
export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-16">
      <h2 className="font-display text-2xl tracking-tight text-text sm:text-3xl">
        Questions people actually ask.
      </h2>

      {/* Not a `<dl>`: a definition list may only contain `dt`/`dd`/`div`, so wrapping each pair in a
          `<details>` would be invalid HTML — and invalid markup around a `FAQPage` block is the one place
          it matters, since that is what a crawler parses to check the questions are really here. */}
      <div className="mt-8 divide-y divide-hair overflow-hidden rounded-lg border border-hair bg-card shadow-card">
        {shippingFaqs().map((entry) => (
          <details key={entry.question} className="group px-5 py-4">
            <summary className="flex cursor-pointer items-center justify-between gap-4 marker:content-none [&::-webkit-details-marker]:hidden">
              <h3 className="font-medium text-text">{entry.question}</h3>
              <span
                aria-hidden="true"
                className="font-mono text-muted transition-transform group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-muted">{entry.answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
