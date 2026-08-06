/**
 * `powered-by` — the Cloudflare line the v2 order keeps between features and the CTA.
 *
 * Small on purpose. Its job is one honest sentence about where the traffic actually goes, which is also
 * the sentence `docs/ARCHITECTURE.md` §1 had to correct once: tunnel traffic passes through Cloudflare's
 * edge, and under federation it can pass through a node someone else runs.
 */
export function PoweredBy() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-10 text-center">
      <p className="text-sm text-muted">
        Localhost on the public internet, running on Cloudflare's edge — the same anycast network,
        TLS and DDoS protection their own customers get.
      </p>
    </section>
  )
}
