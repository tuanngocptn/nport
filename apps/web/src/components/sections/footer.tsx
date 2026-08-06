import Link from "next/link"

import { LINKS } from "../../content/site"

/**
 * The footer. Design: `docs/mockup/NPort Site.dc.html`.
 *
 * No year, no version: rule 7 forbids hardcoding either, and a copyright year is the classic thing that
 * silently goes stale. The licence and the author are facts that do not move.
 */
export function Footer() {
  return (
    <footer className="border-t border-hair">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10 text-sm sm:flex-row sm:justify-between">
        <div>
          <p className="font-display text-base font-semibold text-text">NPort</p>
          <p className="mt-1 max-w-xs text-muted">
            Localhost on the public internet, over Cloudflare's edge.
          </p>
        </div>

        <nav aria-label="Footer" className="flex gap-10">
          <div>
            <h2 className="font-medium text-text">Product</h2>
            <ul className="mt-2 space-y-1 text-muted">
              <li>
                <a href="#features" className="hover:text-text">
                  Features
                </a>
              </li>
              <li>
                <Link href="/errors" className="hover:text-text">
                  Error codes
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="font-medium text-text">Open source</h2>
            <ul className="mt-2 space-y-1 text-muted">
              <li>
                <a
                  href={LINKS.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-text"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href={LINKS.npm}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-text"
                >
                  npm
                </a>
              </li>
              <li>
                <a
                  href={LINKS.issues}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-text"
                >
                  Report an issue
                </a>
              </li>
            </ul>
          </div>
        </nav>
      </div>

      <div className="mx-auto max-w-5xl px-6 pb-10 text-xs text-muted">
        <p>MIT licensed · Created by Nick — Ngoc Pham · Made with ❤️ in Vietnam</p>
      </div>
    </footer>
  )
}
