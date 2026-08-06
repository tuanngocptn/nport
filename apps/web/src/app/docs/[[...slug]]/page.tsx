import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Footer } from "../../../components/sections/footer"
import { Navbar } from "../../../components/sections/navbar"
import { DOC_PAGES, docHref, isDocSlug, loadDoc } from "../../../content/docs"
import { pageMetadata } from "../../../lib/seo"

/**
 * `/docs` and `/docs/<slug>` — the user documentation (`apps/web/CLAUDE.md` rule 9).
 *
 * **An optional catch-all**, so `/docs` and `/docs/cli` are one route with one layout. The index is the
 * page whose slug is `""`, which keeps "the first doc page" and "the docs landing page" from being two
 * things that can disagree.
 *
 * `docs/mockup` does not design this surface — it specifies the marketing page's sections and nothing
 * else — so the styling comes from `packages/design-tokens` by way of `src/mdx-components.tsx`, the same
 * arrangement `/errors/[code]` uses and for the same reason.
 *
 * Static at build time, like the error pages: the content is fixed when the Worker is built, and
 * `dynamicParams = false` means a Worker that will answer `/docs/anything` is not a Worker anyone can ask
 * to render a million pages.
 */

export function generateStaticParams(): Array<{ slug: string[] }> {
  // `[]` for the index — an optional catch-all wants an empty array, not `undefined`, or Next treats the
  // entry as a missing parameter and drops `/docs` from the prerendered set.
  return DOC_PAGES.map((page) => ({ slug: page.slug === "" ? [] : [page.slug] }))
}

export const dynamicParams = false

interface PageProps {
  readonly params: Promise<{ readonly slug?: string[] }>
}

/** `["cli"]` → `"cli"`, `undefined` → `""`. Anything deeper is not a doc page. */
function slugFrom(segments: string[] | undefined): string | null {
  if (segments === undefined || segments.length === 0) return ""
  if (segments.length > 1) return null
  return segments[0] ?? null
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const slug = slugFrom((await params).slug)
  if (slug === null || !isDocSlug(slug)) {
    return { title: "Not found — NPort" }
  }

  const page = await loadDoc(slug)
  if (page === null) {
    return { title: "Not found — NPort" }
  }

  // From the MDX file's own `meta` export rather than a second table here — the page and its title
  // cannot drift if there is only one of them.
  return pageMetadata({
    path: docHref(slug),
    title: `${page.meta.title} — NPort`,
    description: page.meta.description,
  })
}

export default async function DocsPage({ params }: PageProps) {
  const slug = slugFrom((await params).slug)
  if (slug === null || !isDocSlug(slug)) {
    notFound()
  }

  const page = await loadDoc(slug)
  if (page === null) {
    notFound()
  }

  const Content = page.default

  return (
    <>
      <Navbar />
      <div className="mx-auto flex max-w-5xl gap-10 px-6 py-12">
        <Sidebar current={slug} />
        <main className="min-w-0 flex-1">
          <Content />
        </main>
      </div>
      <Footer />
    </>
  )
}

function Sidebar({ current }: { current: string }) {
  return (
    // Hidden below `sm` rather than collapsed into a menu: a menu needs client JS (rule 5), and with two
    // pages the cost of hiding it is that a phone reader scrolls to the footer to find the other one.
    <nav aria-label="Documentation" className="hidden w-44 shrink-0 sm:block">
      <ul className="sticky top-20 space-y-1 text-sm">
        {DOC_PAGES.map((page) => (
          <li key={page.slug}>
            <Link
              href={docHref(page.slug)}
              // `aria-current` and not only a colour: the current page has to be announced, not just
              // look different (rule 10's spirit).
              aria-current={page.slug === current ? "page" : undefined}
              className={
                page.slug === current
                  ? "block rounded-md bg-chip px-3 py-1.5 font-medium text-text"
                  : "block rounded-md px-3 py-1.5 text-muted hover:bg-chip hover:text-text"
              }
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
