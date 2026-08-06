import type { MetadataRoute } from "next"

import { everySlug } from "../lib/error-codes"
import { SITE_URL } from "../lib/seo"

/**
 * `/sitemap.xml`, generated at build time.
 *
 * **No fragment URLs.** v2 listed `/#features`, `/#how-it-works`, `/#architecture` and `/#get-started`
 * as four entries with their own priorities, and Google treats all of them as the same page — so v2's
 * sitemap declared five URLs for one document (`apps/web/CLAUDE.md` § Gotchas). Everything here is a
 * distinct document that returns its own HTML.
 *
 * **The error pages come from the contract**, the same walk `/errors/[code]` uses for
 * `generateStaticParams`. A code added in `packages/contract` therefore appears in the sitemap without
 * anyone remembering to add it — which matters more here than anywhere, because those pages have no
 * inbound links from the site: they are reached from an error message in a terminal, so a crawler that
 * is not told about them will never find them.
 *
 * **No `lastModified`.** The only value available at build time is "now", which would tell crawlers every
 * page changed on every unrelated rebuild. Google's guidance is that it uses `lastmod` when it is
 * consistently accurate and ignores it otherwise; a field that is wrong for 40 pages is worse than an
 * absent one. It comes back when there is a real content date to report — the MDX docs will have one in
 * their front-matter.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/errors`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    // Below the index on purpose: a reader searching an error code should land on the code's own page,
    // but these are reference pages, not the ones the site wants to rank for.
    ...everySlug().map((slug) => ({
      url: `${SITE_URL}/errors/${slug}`,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ]
}
