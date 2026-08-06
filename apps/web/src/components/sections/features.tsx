import { shippingFeatures } from "../../content/site"

/**
 * `#features`. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * The design's heading is "Everything the CLI does, plus what a terminal can't show you" — which is a
 * promise about the desktop app's inspector, and therefore not one this page can make yet. The grid
 * renders `shippingFeatures()`, and `src/content/site.ts` holds the four that are waiting on Phase 4 or
 * are deferred, with the reason each is absent.
 */
export function Features() {
  return (
    <section id="features" className="mx-auto max-w-5xl px-6 py-16">
      <h2 className="font-display text-2xl tracking-tight text-text sm:text-3xl">
        Everything a tunnel should do, and nothing you have to sign up for.
      </h2>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shippingFeatures().map((feature) => (
          <li key={feature.title} className="rounded-lg border border-hair bg-card p-5 shadow-card">
            <h3 className="font-medium text-text">{feature.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">{feature.description}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
