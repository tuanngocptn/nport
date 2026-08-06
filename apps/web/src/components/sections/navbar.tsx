import Link from "next/link"

import { LINKS } from "../../content/site"

/**
 * The top bar. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * The mockup's nav is `How it works · Features · vs ngrok · GitHub · Buy me a coffee · Download`. Kept,
 * minus nothing — every destination exists.
 */
export function Navbar() {
  return (
    <header className="sticky top-0 z-10 border-b border-hair bg-card/80 backdrop-blur-xl">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3 text-sm"
      >
        <Link href="/" className="font-display text-base font-semibold text-text">
          NPort
        </Link>

        {/* Hidden on small screens rather than collapsed into a menu: a menu needs client JS, and
            every destination here is also reachable from the page itself (rule 5). */}
        <ul className="hidden items-center gap-5 text-muted sm:flex">
          <li>
            <a href="#how" className="hover:text-text">
              How it works
            </a>
          </li>
          <li>
            <a href="#features" className="hover:text-text">
              Features
            </a>
          </li>
          <li>
            <a href="#compare" className="hover:text-text">
              vs ngrok
            </a>
          </li>
          {/* Not in the mockup's nav, for the same reason `#faq` is not in its sections: the design was
              drawn before there were docs to link to. A docs site with no entry point from the home page
              is the discoverability half of the bug that left 33 error pages unreachable — so this is a
              `Link`, not an anchor, and it is the only nav item that leaves the page. */}
          <li>
            <Link href="/docs" className="hover:text-text">
              Docs
            </Link>
          </li>
        </ul>

        <div className="ml-auto flex items-center gap-4 text-muted">
          <a
            href={LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text"
          >
            GitHub
          </a>
          <a
            href="#download"
            className="rounded-pill bg-green px-3 py-1.5 font-medium text-black shadow-green"
          >
            Download
          </a>
        </div>
      </nav>
    </header>
  )
}
