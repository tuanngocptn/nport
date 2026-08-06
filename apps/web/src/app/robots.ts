import type { MetadataRoute } from "next"

import { SITE_URL } from "../lib/seo"

/**
 * `/robots.txt` — v2's three lines, generated so the sitemap URL cannot drift from `sitemap.ts`.
 *
 * Everything is allowed, and there is nothing here to disallow: there are no accounts (ADR-0007), so the
 * site has no authenticated surface, no search endpoint and no per-user page. A `Disallow` rule added
 * here would be a hint that one of those had appeared.
 *
 * It is not an access control either way — `robots.txt` is a request, and the Worker serves the same
 * bytes to a crawler that ignores it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
