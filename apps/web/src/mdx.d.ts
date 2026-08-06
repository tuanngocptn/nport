/**
 * What an `.mdx` import gives you.
 *
 * Hand-written rather than `@types/mdx`, which types the default export and says in its own doc
 * comment that it cannot type the others: "It's currently not possible for the other exports to be
 * typed automatically." Every doc page here exports `meta`, and that is the export the route reads to
 * build a `<title>` and a nav entry — so the useful half is the half the package cannot provide.
 *
 * Declaring it here also means the docs pipeline has exactly one place that says what a doc *is*.
 */
declare module "*.mdx" {
  import type { ComponentType } from "react"

  /** Required on every page. `docs.ts` fails the build if a page omits it. */
  export const meta: {
    readonly title: string
    readonly description: string
  }

  const MDXContent: ComponentType<Record<string, unknown>>
  export default MDXContent
}
