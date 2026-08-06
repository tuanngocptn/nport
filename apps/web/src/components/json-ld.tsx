import { serializeJsonLd } from "../lib/seo"

/**
 * Emits JSON-LD blocks as `<script type="application/ld+json">`, one tag per block.
 *
 * `dangerouslySetInnerHTML` is unavoidable — React escapes text children, and an escaped `&quot;` inside
 * an `ld+json` script is not JSON any crawler will parse. The escaping that does matter happens in
 * `serializeJsonLd`, which lives in `src/lib/seo.ts` rather than here so a unit test can reach it: this
 * module is `.tsx`, and `tsconfig.json` sets `jsx: "preserve"` for Next's compiler, which Vite cannot
 * parse (the same constraint that shaped `src/lib/error-codes.ts`).
 */
export function JsonLd({ blocks }: { blocks: ReadonlyArray<Record<string, unknown>> }) {
  return (
    <>
      {blocks.map((block) => (
        <script
          // `@id` is unique per block by construction and is what a validator reports, so it is the
          // honest key — an array index would silently reorder if a block became conditional.
          key={String(block["@id"] ?? block["@type"])}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(block) }}
        />
      ))}
    </>
  )
}
