import type { ComponentPropsWithoutRef } from "react"

/**
 * How every element in a `.mdx` doc page is rendered.
 *
 * `@next/mdx` calls this to resolve the components an MDX file compiles to, so **this file is the docs'
 * entire stylesheet**. Tailwind's preflight strips heading sizes and list markers, so without it a doc
 * page renders as undifferentiated text — which looks like a broken build rather than a styling gap.
 *
 * Everything here uses `packages/design-tokens` utilities (rule 4): no raw hex, and the same
 * `text-text`/`text-muted`/`bg-card`/`border-hair` vocabulary as the error pages, so a doc page and an
 * error page look like the same site without either importing from the other.
 *
 * The type is local rather than `mdx/types`. `@types/mdx` was installed and removed: it types the default
 * export and states in its own doc comment that it cannot type the named ones, which is the half that
 * matters here (`src/mdx.d.ts`). One dependency fewer, and `meta` gets a real type.
 */

type Components = Record<string, unknown>

export function useMDXComponents(components: Components): Components {
  return {
    h1: (props: ComponentPropsWithoutRef<"h1">) => (
      <h1 className="mt-2 font-display text-2xl tracking-tight text-text sm:text-3xl" {...props} />
    ),
    h2: (props: ComponentPropsWithoutRef<"h2">) => (
      <h2 className="mt-10 font-display text-xl tracking-tight text-text" {...props} />
    ),
    h3: (props: ComponentPropsWithoutRef<"h3">) => (
      <h3 className="mt-8 font-medium text-text" {...props} />
    ),
    p: (props: ComponentPropsWithoutRef<"p">) => (
      <p className="mt-4 leading-relaxed text-muted" {...props} />
    ),
    a: (props: ComponentPropsWithoutRef<"a">) => {
      // Internal links stay in the tab; external ones get `rel`/`target` per rule 10. Decided from the
      // href rather than per-link, because a doc author writing markdown should not have to remember it.
      const external = props.href?.startsWith("http") ?? false
      return (
        <a
          className="text-green underline decoration-hair underline-offset-4 hover:decoration-green"
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          {...props}
        />
      )
    },
    ul: (props: ComponentPropsWithoutRef<"ul">) => (
      <ul className="mt-4 list-disc space-y-2 pl-5 text-muted" {...props} />
    ),
    ol: (props: ComponentPropsWithoutRef<"ol">) => (
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-muted" {...props} />
    ),
    li: (props: ComponentPropsWithoutRef<"li">) => <li className="leading-relaxed" {...props} />,
    strong: (props: ComponentPropsWithoutRef<"strong">) => (
      <strong className="font-medium text-text" {...props} />
    ),
    hr: (props: ComponentPropsWithoutRef<"hr">) => <hr className="mt-10 border-hair" {...props} />,
    // Inline code. A fenced block arrives as `pre > code`, and the `pre` below owns that case — this
    // styling would double the background if it applied to both.
    code: (props: ComponentPropsWithoutRef<"code">) => (
      <code
        className="rounded-xs bg-chip px-1.5 py-0.5 font-mono text-[0.9em] text-text"
        {...props}
      />
    ),
    pre: (props: ComponentPropsWithoutRef<"pre">) => (
      <pre
        className="mt-4 overflow-x-auto rounded-lg border border-hair bg-card p-4 font-mono text-sm text-text shadow-card [&_code]:bg-transparent [&_code]:p-0"
        {...props}
      />
    ),
    ...components,
  }
}
