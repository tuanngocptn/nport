import { LINKS } from "../../content/site"

/**
 * `#download` — the CTA. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * The design's heading is kept verbatim: "Free forever. Open source. No account." All three are true and
 * all three are invariants rather than marketing (invariant 1, the MIT licence, ADR-0007).
 *
 * **No version number and no install command per platform yet.** Rule 8 forbids hardcoding a version,
 * and Homebrew, Scoop and the npm packages are Phase 3 — so this offers the one install path that works
 * today and links to the repository for the rest. A download button for an artifact that does not exist
 * is the same class of claim as the features held back in `src/content/site.ts`.
 */
export function Download() {
  return (
    <section id="download" className="mx-auto max-w-3xl px-6 py-16 text-center">
      <h2 className="font-display text-2xl tracking-tight text-text sm:text-3xl">
        Free forever. Open source. No account.
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-muted">
        Point NPort at your own Cloudflare account and every tunnel runs on infrastructure you
        control.
      </p>

      <div className="mx-auto mt-8 max-w-md">
        <pre className="overflow-x-auto rounded-lg border border-hair bg-card px-5 py-4 text-left font-mono text-sm text-text shadow-card">
          <code>
            <span className="text-muted select-none">$ </span>npx nport 3000
          </code>
        </pre>
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm">
        <a
          href={LINKS.github}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-pill border border-hair bg-card px-4 py-2 text-text hover:bg-chip"
        >
          Star on GitHub
        </a>
        <a
          href={LINKS.coffee}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-pill bg-yellow px-4 py-2 font-medium text-black"
        >
          Buy me a coffee
        </a>
      </div>

      <div className="mt-12 rounded-lg border border-hair bg-card p-6 text-left shadow-card">
        <h3 className="font-medium text-text">NPort has no paid tier. It runs on coffee.</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          One developer maintains it and pays the server bills out of pocket. If NPort replaced a
          subscription for you, sending a few back keeps it free for everyone else.
        </p>
      </div>
    </section>
  )
}
