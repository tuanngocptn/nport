import { ERRORS, type ErrorDefinition } from "@nport/contract"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { codeFromSlug, errorPageParams } from "../../../lib/error-codes"
import { inlineMarkdown } from "../../../lib/inline-markdown"

/**
 * `/errors/<slug>` — the page every NPort error message points at.
 *
 * **This is the other end of a promise the product has been making since Phase 2a.** Every error
 * envelope the API returns carries `docsUrl: https://nport.link/errors/<slug>`, and for the seven codes
 * `crates/cli` does not translate, that URL *is* the entire remedy the user is offered — `render.rs`
 * prints `[CODE] — see: <url>` and nothing else. Thirty-three such URLs existed and none of them
 * resolved.
 *
 * **Generated from the registry, never written by hand** (invariant 7). Adding a code in
 * `packages/contract` gives it a page; there is nothing here to keep in step, which is the property
 * `docs/ERRORS.md` already relies on when it says the page behind the URL "is always current in a way a
 * hand-written translation is not".
 *
 * `docs/mockup` designs the marketing site's five sections and does not cover this page, so the
 * aesthetic here comes from `packages/design-tokens` rather than from a screen in the mockup — noted
 * because "follow the mockup" is otherwise the rule for anything visual.
 */

/**
 * Static at build time: the registry is fixed when the Worker is built, so nothing needs a request.
 *
 * A **re-export, not a wrapper** — the implementation lives in `src/lib/error-codes.ts` where a unit
 * test can reach it, because a test cannot import this module (`jsx: "preserve"` is set for Next's
 * compiler and Vite cannot parse the result). A wrapper here would be one untested line between the
 * tested function and the thing Next actually calls.
 */
export { errorPageParams as generateStaticParams }

/**
 * Only the codes above exist.
 *
 * Without this, an unknown slug would be rendered on demand and `notFound()` would still catch it — but
 * a Worker that will answer any path is a Worker that can be asked to render a million of them.
 */
export const dynamicParams = false

interface PageProps {
  readonly params: Promise<{ readonly code: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = codeFromSlug((await params).code)
  if (!code) {
    return { title: "Unknown error code — NPort" }
  }
  const definition: ErrorDefinition = ERRORS[code]
  return {
    title: `${code} — NPort`,
    // The registry's own one-line cause, which is what a search result should show: someone arriving
    // here has already seen the message and wants to know what it means.
    description: `${definition.message} ${definition.cause}.`,
  }
}

export default async function ErrorCodePage({ params }: PageProps) {
  const code = codeFromSlug((await params).code)
  if (!code) {
    notFound()
  }

  // Widened from the `as const satisfies` literal union. Narrowed, each entry has its own type and
  // `details` only exists on the ones that declare it — so reading it needs the interface the registry
  // satisfies rather than the literal.
  const definition: ErrorDefinition = ERRORS[code]
  const isServer = definition.origin === "server"

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/errors" className="text-sm text-muted hover:text-text">
        ← All error codes
      </Link>

      <h1 className="mt-6 font-mono text-2xl font-semibold break-words text-text sm:text-3xl">
        {code}
      </h1>
      <p className="mt-3 text-lg text-muted">{definition.message}</p>

      <dl className="mt-8 flex flex-wrap gap-2">
        <Fact label="Origin" value={isServer ? "Server" : "On your machine"} />
        {/* A client-side code never crosses the network, so it has no status — and showing a blank or a
            zero would imply it does. `docs/ERRORS.md` splits its tables for the same reason. */}
        {isServer && definition.status !== null ? (
          <Fact label="HTTP" value={String(definition.status)} />
        ) : null}
        <Fact
          label="Retry"
          value={definition.retryable ? "Worth retrying" : "Retrying will not help"}
          tone={definition.retryable ? "green" : "orange"}
        />
      </dl>

      <Section title="What happened">
        <p className="text-muted">{inlineMarkdown(definition.cause)}</p>
      </Section>

      <Section title="What to do">
        <p className="text-muted">{inlineMarkdown(definition.action)}</p>
      </Section>

      {definition.details && definition.details.length > 0 ? (
        <Section title="Extra detail this error carries">
          {/* Documented because clients are told they may rely on these keys, so the page has to say
              which ones exist rather than leaving a caller to discover them from a response. */}
          <ul className="flex flex-wrap gap-2">
            {definition.details.map((key: string) => (
              <li key={key} className="rounded-xs bg-chip px-2 py-1 font-mono text-sm text-text">
                error.details.{key}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Where this comes from">
        <p className="text-muted">
          {inlineMarkdown(
            isServer
              ? "The control plane returned this in an error envelope. Branch on `error.code`, never on `error.message` — messages are translated and free to change."
              : "`nport` raised this locally. It never crossed the network, so there is no request to retry and no `requestId` to quote.",
          )}
        </p>
      </Section>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold tracking-wide text-text uppercase">{title}</h2>
      <div className="mt-2 leading-relaxed">{children}</div>
    </section>
  )
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "green" | "orange" }) {
  const colour = tone === "green" ? "text-green" : tone === "orange" ? "text-orange" : "text-text"
  return (
    <div className="rounded-md border border-hair bg-card px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-sm font-medium ${colour}`}>{value}</dd>
    </div>
  )
}
