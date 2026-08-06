import { STEPS } from "../../content/site"
import { inlineMarkdown } from "../../lib/inline-markdown"

/**
 * `#how` — three steps. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * The heading is the design's. Step three is not: the design's is "Watch the traffic" in the inspector,
 * which is Phase 4, so the step that is true at 3.0 is the one the tunnel exists for
 * (`src/content/site.ts`).
 */
export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-5xl px-6 py-16">
      <h2 className="font-display text-2xl tracking-tight text-text sm:text-3xl">
        Three steps, then Cloudflare does the rest.
      </h2>

      <ol className="mt-8 grid gap-4 sm:grid-cols-3">
        {STEPS.map((step) => (
          <li key={step.n} className="rounded-lg border border-hair bg-card p-5 shadow-card">
            <span
              aria-hidden="true"
              className="inline-flex size-7 items-center justify-center rounded-pill bg-chip font-mono text-sm text-green"
            >
              {step.n}
            </span>
            <h3 className="mt-3 font-medium text-text">{step.title}</h3>
            {/* Backticks in the copy render as code through `inlineMarkdown` — the same helper the error
                pages use, so the two places prose carries markup share one renderer. */}
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {inlineMarkdown(step.description)}
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}
