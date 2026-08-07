import { TunnelsView } from "./views/tunnels"

/**
 * The window.
 *
 * **A shell, not the finished chrome.** `docs/mockup/README.md` specifies a sidebar plus five
 * screens with a first-run overlay and a menu-bar popover; this renders one of the five. The sidebar
 * arrives with the second screen, because a nav with one destination is a nav that cannot be used
 * wrongly and cannot be evaluated either.
 */
export function App() {
  return (
    <div className="h-full overflow-y-auto">
      <TunnelsView />
    </div>
  )
}
