//! Command-line parsing.
//!
//! Four of v2's defects were in this file's job, and every one of them is now a test:
//!
//! 1. **The port is positional *and* a flag.** v2 accepted only a position, so `nport -s app 3000`
//!    silently tunnelled port 8080 — the default — while printing a URL that looked right.
//! 2. **`--help` and `--version` answer immediately**, before any config read, locale resolution, or
//!    network call. v2's `nport -v` hung on a fresh install behind an interactive prompt.
//! 3. **An unknown flag is an error.** Silently ignoring one means a typo'd `--subdomian` produces a
//!    random name and no explanation.
//! 4. **Nothing prompts, ever** (ADR-0019). There is no flag here whose absence starts a
//!    conversation; anything missing has a default or is an error.

use clap::Parser;

/// Expose a local port on a public `*.nport.link` URL.
#[derive(Debug, Parser)]
#[command(
    name = "nport",
    version,
    about,
    // Unknown flags and missing values are errors, not guesses.
    disable_help_subcommand = true
)]
pub struct Args {
    // Positional *and* a flag on purpose: `nport 3000` is what people type, and `nport -p 3000` is
    // what they type when a flag came first. v2 accepted only the former, so `nport -s app 3000`
    // silently tunnelled the default port.
    //
    // Written as a `//` comment rather than a doc comment because clap prints doc comments in
    // `--help`, and a rationale aimed at whoever maintains this file is not what a user asked for.
    /// The local port to expose
    #[arg(value_name = "PORT")]
    pub port_positional: Option<u16>,

    /// The local port to expose.
    #[arg(short, long, value_name = "PORT")]
    pub port: Option<u16>,

    /// The subdomain to claim. Omit to have one generated.
    #[arg(short, long, value_name = "NAME")]
    pub subdomain: Option<String>,

    /// The control plane to use. For self-hosting and for `pnpm dev:node`.
    // Setting this **skips node discovery entirely** (ADR-0031), which is what keeps every
    // self-hosted deployment and `pnpm dev:cli` working exactly as they did before federation.
    #[arg(long, value_name = "URL")]
    pub backend: Option<String>,

    /// The node directory to discover through. Ignored when `--backend` is given.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,

    /// Pin a specific node by id, instead of letting nport choose.
    // `--node` and not `-n`: short flags are scarce and this is a rare option. `docs/FEATURES.md` §7
    // notes the design's `-h <host>` is unavailable for the same class of reason — `-h` is `--help`.
    #[arg(long, value_name = "ID")]
    pub node: Option<String>,

    /// Interface language: `en`, `vi`, or `es`. Detected from the environment when omitted.
    #[arg(long, value_name = "LANG")]
    pub lang: Option<String>,

    /// Print the tunnel's URL and nothing else. For scripts.
    #[arg(short, long)]
    pub quiet: bool,
}

impl Args {
    /// The port the user meant, whichever way they said it.
    ///
    /// The flag wins over the position when both are given — an explicit `-p` is the more specific
    /// statement, and disagreeing with yourself is not an error worth stopping for.
    #[must_use]
    pub fn resolved_port(&self) -> Option<u16> {
        self.port.or(self.port_positional)
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory as _;

    use super::*;

    fn parse(argv: &[&str]) -> Result<Args, clap::Error> {
        Args::try_parse_from(std::iter::once("nport").chain(argv.iter().copied()))
    }

    #[test]
    fn the_port_is_accepted_positionally_and_as_a_flag() {
        assert_eq!(
            parse(&["3000"]).expect("parses").resolved_port(),
            Some(3000)
        );
        assert_eq!(
            parse(&["-p", "3000"]).expect("parses").resolved_port(),
            Some(3000)
        );
        assert_eq!(
            parse(&["--port", "3000"]).expect("parses").resolved_port(),
            Some(3000)
        );
    }

    #[test]
    fn a_flag_before_the_port_does_not_swallow_it() {
        // v2's exact bug: `nport -s app 3000` tunnelled port 8080 and printed a URL that looked
        // perfectly correct.
        let args = parse(&["-s", "app", "3000"]).expect("parses");
        assert_eq!(args.resolved_port(), Some(3000));
        assert_eq!(args.subdomain.as_deref(), Some("app"));
    }

    #[test]
    fn adjacent_flags_do_not_consume_each_others_values() {
        // `-s` followed immediately by another flag: the parser must refuse rather than claim the
        // subdomain is "-l".
        assert!(parse(&["-s", "-l", "vi", "3000"]).is_err());

        let args = parse(&["-s", "app", "--lang", "vi", "3000"]).expect("parses");
        assert_eq!(args.subdomain.as_deref(), Some("app"));
        assert_eq!(args.lang.as_deref(), Some("vi"));
    }

    #[test]
    fn an_unknown_flag_is_an_error() {
        // A typo'd `--subdomian` must not quietly produce a generated name.
        let error = parse(&["3000", "--subdomian", "app"]).expect_err("unknown flag");
        assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
    }

    /// `--node` and `--registry` parse, and neither steals a short flag.
    #[test]
    fn the_federation_flags_are_long_only() {
        let args = Args::try_parse_from([
            "nport",
            "3000",
            "--node",
            "hk1",
            "--registry",
            "https://r.test",
        ])
        .expect("parses");
        assert_eq!(args.node.as_deref(), Some("hk1"));
        assert_eq!(args.registry.as_deref(), Some("https://r.test"));

        // `-n` is deliberately not taken: short flags are scarce, this is a rare option, and the same
        // reasoning is why `docs/FEATURES.md` §7 records that the design's `-h <host>` is unavailable.
        assert!(Args::try_parse_from(["nport", "3000", "-n", "hk1"]).is_err());
    }

    #[test]
    fn help_and_version_answer_without_anything_else_happening() {
        // Asserted at the parser level because that is where the guarantee lives: clap returns these
        // as errors that `main` prints and exits on, before a config file or a socket is touched.
        for flag in ["--help", "-h", "--version", "-V"] {
            let error = parse(&[flag]).expect_err("clap reports these as errors");
            assert!(
                matches!(
                    error.kind(),
                    clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
                ),
                "{flag} produced {:?}",
                error.kind()
            );
        }
    }

    #[test]
    fn a_port_outside_the_range_is_refused_rather_than_wrapped() {
        assert!(parse(&["70000"]).is_err());
        assert!(
            parse(&["0"]).is_ok(),
            "0 is a real port to reject later, with a code"
        );
    }

    #[test]
    fn the_command_itself_is_well_formed() {
        // clap's own debug assertions: duplicate short flags, missing value names, and similar
        // mistakes that only show up at runtime otherwise.
        Args::command().debug_assert();
    }
}
