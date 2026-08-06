import { ERRORS, type ErrorCode, type ErrorDefinition, errorSlug } from "@nport/contract"
import Link from "next/link"

import { pageMetadata } from "../../lib/seo"

/**
 * `/errors` — every code NPort can return or raise.
 *
 * Generated from `packages/contract`, like the per-code pages. Grouped the way `docs/ERRORS.md` groups
 * them, because the split is a real distinction and not a presentation choice: a `server` code arrived
 * over the network and carries an HTTP status, a `client` code was raised by `nport` on the user's own
 * machine and never left it. Someone who saw one of these in a terminal wants to know which kind it
 * was before anything else.
 */

export const metadata = pageMetadata({
  path: "/errors",
  title: "Error codes — NPort",
  description:
    "Every error NPort can return or raise, with what causes it and what to do about it. Clients branch on the code, never on the message.",
})

export default function ErrorsIndexPage() {
  // Widened deliberately: narrowed, every entry has a distinct literal type and the shared
  // optional fields are invisible.
  const entries = Object.entries(ERRORS) as Array<[ErrorCode, ErrorDefinition]>
  const server = entries
    .filter(([, definition]) => definition.origin === "server")
    // By status, so the list reads as a taxonomy rather than an alphabet — the same ordering
    // `docs/ERRORS.md` uses, and for the same reason.
    .sort(([a, x], [b, y]) => (x.status ?? 0) - (y.status ?? 0) || a.localeCompare(b))
  const client = entries
    .filter(([, definition]) => definition.origin === "client")
    .sort(([a], [b]) => a.localeCompare(b))

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-text">Error codes</h1>
      <p className="mt-3 max-w-prose text-muted">
        Every failure NPort can report carries one of these. Branch on the code — messages are
        translated and free to change.
      </p>

      <Group
        title="From the server"
        note={`${server.length} codes. These cross the network and carry an HTTP status.`}
        codes={server}
        showStatus
      />
      <Group
        title="From your machine"
        note={`${client.length} codes. Raised by nport locally; they never reach the network.`}
        codes={client}
      />
    </main>
  )
}

function Group({
  title,
  note,
  codes,
  showStatus = false,
}: {
  title: string
  note: string
  codes: Array<[ErrorCode, ErrorDefinition]>
  showStatus?: boolean
}) {
  return (
    <section className="mt-12">
      <h2 className="text-sm font-semibold tracking-wide text-text uppercase">{title}</h2>
      <p className="mt-1 text-sm text-muted">{note}</p>
      <ul className="mt-4 divide-y divide-hair overflow-hidden rounded-lg border border-hair bg-card">
        {codes.map(([code, definition]) => (
          <li key={code}>
            <Link
              href={`/errors/${errorSlug(code)}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-chip"
            >
              <span className="font-mono text-sm font-medium text-text">{code}</span>
              {showStatus && definition.status !== null ? (
                <span className="font-mono text-xs text-muted">{definition.status}</span>
              ) : null}
              <span className="w-full text-sm text-muted sm:w-auto sm:flex-1">
                {definition.message}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
