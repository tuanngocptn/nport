/**
 * The hero. Design: `docs/mockup/NPort Site.dc.html` §`#top`.
 *
 * The headline is the design's, verbatim — "Your tunnels, your Cloudflare, your rules." — because it is
 * true and it is good.
 *
 * The **supporting line is not**. The design's reads "with a real desktop app — custom subdomains, live
 * request inspection, and the option to run every tunnel on infrastructure you own", and two of those
 * three do not exist when this page ships: the desktop app is Phase 4 and the inspector's UI with it.
 * `src/content/site.ts` records the whole divergence; this is the most visible part of it.
 *
 * The design also puts an interactive demo of the desktop app here ("The real app, running right here.
 * Click anything."). There is no app to embed, so the slot holds the one command instead — which is
 * arguably the better hero for a CLI anyway.
 */
export function Hero() {
  return (
    <section id="top" className="mx-auto max-w-5xl px-6 pt-20 pb-16 text-center">
      <h1 className="font-display text-4xl leading-tight tracking-tight text-text sm:text-6xl">
        Your tunnels, your Cloudflare,
        <br />
        your rules.
      </h1>

      <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
        Expose localhost over Cloudflare's edge with one command — custom subdomains, automatic
        HTTPS, and the option to run every tunnel on infrastructure you own. No account, ever.
      </p>

      <div className="mx-auto mt-10 max-w-md">
        <pre className="overflow-x-auto rounded-lg border border-hair bg-card px-5 py-4 text-left font-mono text-sm text-text shadow-card">
          <code>
            <span className="text-muted select-none">$ </span>npx nport 3000
          </code>
        </pre>
        <p className="mt-3 text-sm text-muted">
          No signup. No config file. A public HTTPS URL in a couple of seconds.
        </p>
      </div>
    </section>
  )
}
