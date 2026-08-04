//! Repository automation, run as `cargo xtask <command>` via the alias in
//! `.cargo/config.toml`.
//!
//! `codegen` is implemented. The rest land with the phase that needs them
//! (`docs/ROADMAP.md`). Until then they succeed as no-ops, which is the honest answer
//! for a repository with nothing generated in it: `codegen-drift.yml` compares the tree
//! before and after, so a no-op leaves it clean and the gate starts biting for real the
//! moment codegen produces something.

#![forbid(unsafe_code)]

use std::process::ExitCode;

mod codegen;
mod verify_docs;

const USAGE: &str = "\
usage: cargo xtask <command>

commands:
  codegen        regenerate schema/, crates/contract, and docs/ERRORS.md   (Phase 1.5)
  fixtures       capture golden protocol byte fixtures from cloudflared    (Phase 1)
  npm-packages   generate the nine npm manifests from the Cargo version    (Phase 3)
  verify-docs    check repo-map paths, error codes, and markdown links     (Phase 0+)
";

fn main() -> ExitCode {
    let Some(command) = std::env::args().nth(1) else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };

    match command.as_str() {
        "codegen" => match codegen::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask codegen: {error}");
                ExitCode::FAILURE
            }
        },
        "verify-docs" => match verify_docs::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("xtask verify-docs: {error}");
                ExitCode::FAILURE
            }
        },
        "fixtures" | "npm-packages" => {
            eprintln!("xtask {command}: not implemented yet — see docs/ROADMAP.md");
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("xtask: unknown command `{other}`");
            eprintln!();
            eprint!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
