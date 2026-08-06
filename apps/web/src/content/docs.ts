/**
 * The docs registry: which pages exist, in what order, and how to load one.
 *
 * **A map rather than a directory scan**, because the route needs `generateStaticParams` at build time
 * and a Worker has no filesystem to read at request time. The order here is the nav order, which is a
 * decision no directory listing can express.
 *
 * The obvious risk is the one this repository has hit four times: a registry that drifts from the thing it
 * claims to describe. `docs.test.ts` reads `src/content/docs/` and fails if any `.mdx` file is missing
 * from this list or listed here without existing — so adding a page is two edits, and forgetting the
 * second one is a failing test rather than a page nobody can reach.
 */

export interface DocPage {
  /** URL segment. `/docs/<slug>`, and `""` for the index. */
  readonly slug: string
  /** Nav label. Shorter than the page's own `<h1>`, which `meta.title` carries. */
  readonly label: string
}

/**
 * Every page, in nav order.
 *
 * Deliberately short. `docs/` at the repo root is contributor documentation and stays there; this is the
 * set a *user* needs, and a docs site that opens with twelve links is one nobody reads the first page of.
 */
export const DOC_PAGES: readonly DocPage[] = [
  { slug: "", label: "Getting started" },
  { slug: "configuration", label: "Configuration" },
  { slug: "troubleshooting", label: "Troubleshooting" },
  { slug: "cli", label: "CLI reference" },
]

/**
 * Loads a page's module.
 *
 * A `switch` over literal imports rather than a template-literal `import()`, because a bundler can only
 * follow the former: `import(`../content/docs/${slug}.mdx`)` makes Turbopack include every match it can
 * guess at, or none, and which one you get is not something to leave to inference in a Worker bundle.
 */
export async function loadDoc(slug: string) {
  switch (slug) {
    case "":
      return import("./docs/index.mdx")
    case "configuration":
      return import("./docs/configuration.mdx")
    case "troubleshooting":
      return import("./docs/troubleshooting.mdx")
    case "cli":
      return import("./docs/cli.mdx")
    default:
      return null
  }
}

export function isDocSlug(slug: string): boolean {
  return DOC_PAGES.some((page) => page.slug === slug)
}

/** The path for a slug, with no trailing slash on the index. */
export function docHref(slug: string): string {
  return slug === "" ? "/docs" : `/docs/${slug}`
}
