import { CLI, type CliArgument, flagsOursFirst, usage } from "../lib/cli-reference"

/**
 * The flag reference, from `schema/cli.json`.
 *
 * A component rather than a table typed into the MDX, because the data is generated (defect 38) and the
 * page's job is to render whatever `crates/cli` currently accepts. Adding a flag to `args.rs` and running
 * `cargo xtask codegen` changes this page with no edit here.
 */
export function CliTable() {
  return (
    <>
      <Table caption="Arguments" rows={CLI.positionals} />
      <Table caption="Options" rows={flagsOursFirst()} />
    </>
  )
}

function Table({ caption, rows }: { caption: string; rows: readonly CliArgument[] }) {
  if (rows.length === 0) return null

  return (
    <div className="mt-6">
      <h3 className="font-medium text-text">{caption}</h3>
      {/* `overflow-x-auto` on the wrapper, not the table: a long help string must scroll inside its own
          box rather than widening the page, which is the one layout bug a docs table reliably causes. */}
      <div className="mt-3 overflow-x-auto rounded-lg border border-hair bg-card shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-hair text-left">
              <th className="px-4 py-3 font-medium text-text">Flag</th>
              <th className="px-4 py-3 font-medium text-text">What it does</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((argument) => (
              <tr key={argument.id} className="border-b border-hair last:border-0">
                <td className="px-4 py-3 align-top font-mono whitespace-nowrap text-green">
                  {/* Positionals have no flag form; clap shows them as `[PORT]` and so does this. */}
                  {argument.long === null && argument.short === null
                    ? `[${argument.valueName}]`
                    : usage(argument)}
                </td>
                <td className="px-4 py-3 align-top text-muted">
                  {argument.help ?? "—"}
                  {argument.builtin ? (
                    <span className="ml-2 rounded-xs bg-chip px-1.5 py-0.5 text-xs text-muted">
                      built in
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
