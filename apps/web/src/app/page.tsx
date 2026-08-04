import { ROUTES } from "@nport/contract"

/**
 * The development landing page.
 *
 * **This is not the site.** The real one is Phase 2c, built from `docs/mockup/NPort Site.dc.html`
 * in the section order `apps/web/CLAUDE.md` fixes. What this page is for is proving the scaffold
 * works end to end: server components render, the design tokens resolve, Tailwind's theme-following
 * utilities pick up `[data-theme]`, and `@nport/contract` imports across the workspace boundary.
 *
 * It renders the route table from the contract rather than a hardcoded list, so it cannot drift —
 * and the moment a route is added, this page shows it without being edited.
 */
export default function Home() {
  const backend = process.env.NEXT_PUBLIC_NPORT_BACKEND ?? "http://localhost:8787"

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-sm text-green">nport · local development</p>
        <h1 className="font-display text-5xl tracking-tight text-text">The stack is up.</h1>
        <p className="max-w-xl text-muted leading-relaxed">
          This is the <code className="font-mono text-text">apps/web</code> scaffold, not the
          marketing site. It exists so <code className="font-mono text-text">pnpm dev</code> brings
          every surface up at once. The real site is Phase 2c.
        </p>
      </header>

      <section className="rounded-xl border border-hair bg-card p-6 shadow-card backdrop-blur-2xl">
        <h2 className="mb-4 font-display text-lg text-text">Control plane</h2>
        <p className="mb-4 font-mono text-sm text-muted">{backend}</p>
        <ul className="flex flex-col gap-2 font-mono text-sm">
          {ROUTES.map((route) => (
            <li key={`${route.method} ${route.path}`} className="flex gap-3">
              <span className="w-16 shrink-0 text-green">{route.method}</span>
              <span className="text-muted">{route.path}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-hair bg-card p-6 shadow-card backdrop-blur-2xl">
        <h2 className="mb-4 font-display text-lg text-text">Open a tunnel</h2>
        <pre className="overflow-x-auto rounded-md bg-field p-4 font-mono text-sm text-text">
          cargo run -p nport -- 3000 --backend {backend}
        </pre>
      </section>
    </main>
  )
}
