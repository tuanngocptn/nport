import type { ReactNode } from "react"

/**
 * Renders the small amount of markdown the error registry's prose actually uses.
 *
 * **Not a markdown library, and deliberately not.** The strings come from
 * `packages/contract/src/errors.ts`, written for humans reading `docs/ERRORS.md`, and they use exactly
 * two constructs: `` `code` `` and `**bold**`. Rendering them literally would put backticks on the
 * page; pulling in a markdown parser to handle two patterns would be a dependency, a bundle, and an
 * HTML-injection surface for text that is never going to contain a table.
 *
 * The registry is authored in this repository, so this is not untrusted input — but it is still parsed
 * into React elements rather than `dangerouslySetInnerHTML`, because "authored here" is a property of
 * today's registry and not of the function.
 */

/** Matches a `` `code` `` span or a `**bold**` run, in one pass so nesting cannot confuse the order. */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/g

export function inlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = []

  // `split` with a capturing group keeps the delimiters, so plain text and markup alternate and the
  // original order survives without tracking indices. Built with a loop rather than `flatMap`, which
  // would have to be typed as returning strings and cannot carry an element.
  for (const [index, part] of text.split(INLINE).entries()) {
    if (part.length === 0) {
      continue
    }
    const key = `${index}-${part}`
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      out.push(
        <code key={key} className="rounded-xs bg-chip px-1 py-0.5 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>,
      )
    } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      out.push(
        <strong key={key} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>,
      )
    } else {
      out.push(part)
    }
  }

  return out
}
