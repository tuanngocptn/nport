//! `~/.nport/config.toml`: what is in it, and where it lives.
//!
//! **The format, not the file.** Reading and writing bytes stays with whoever owns the environment —
//! `crates/cli` for the terminal, `apps/desktop` for the window. What lives here is the shape both
//! agree on, so that a field added for one is a field the other already understands (ADR-0051).
//!
//! Before this, the schema was `crates/cli`'s alone. The desktop app cannot depend on the CLI —
//! they are siblings under `core` in the layering graph — so a Settings screen that wrote this file
//! would have had to restate every field, and the first divergence would have been a user's config
//! silently losing a value depending on which of the two last wrote it.
//!
//! It holds no credential and never will. Tokens are returned once by the control plane and used in
//! memory; writing one here would make invariant 4 impossible to keep.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file's contents. Every field is optional — this sets defaults, it does not require anything.
///
/// `deny_unknown_fields` is deliberate and is the reason a corrupt file is an error rather than a
/// shrug: a typo'd key silently changing what the tool does is worse than a message saying which
/// key is wrong.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Default subdomain, when `-s` is not given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
    /// Default control plane. For self-hosting (`docs/SELF_HOSTING.md`). Skips discovery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Default node directory. `docs/FEATURES.md` §10's "Registry URL" setting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry: Option<String>,
    /// Default node to pin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// Default interface language.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Default port, when none is given on the command line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// Why a config file's contents could not be used.
#[derive(Debug, thiserror::Error)]
#[error("not valid TOML: {reason}")]
pub struct ParseError {
    /// `toml`'s own message, which carries the line, the column and a caret.
    ///
    /// **Never the error value itself.** Its `Display` is the useful half; a debug rendering would
    /// carry values out of the user's file into a log.
    pub reason: String,
}

/// Parses the file's contents.
///
/// # Errors
///
/// [`ParseError`] when the text is not valid TOML, or names a key this version does not know.
pub fn parse(text: &str) -> Result<Config, ParseError> {
    toml::from_str(text).map_err(|error| ParseError {
        reason: error.message().to_owned(),
    })
}

/// Renders a config back to TOML.
///
/// **Absent fields are omitted rather than written empty**, which is what makes a round trip
/// non-destructive for a file that only set one key: writing `subdomain = ""` for a value the user
/// never set would turn "unset" into "set to nothing", and the two mean different things to every
/// consumer of this file.
///
/// # Panics
///
/// Never in practice: every field is a `String`, a `u16` or an `Option` of one, and `toml` cannot
/// fail to render those. The `expect` documents that rather than propagating an error no caller
/// could act on.
#[must_use]
pub fn to_toml(config: &Config) -> String {
    toml::to_string_pretty(config).expect("a config of strings and numbers always renders")
}

/// Where the config file lives, given a way to read the environment.
///
/// `$HOME` on Unix, `%USERPROFILE%` on Windows, with `NPORT_HOME` overriding both — read through
/// the supplied closure rather than through `std::env::home_dir`, whose behaviour has changed across
/// releases in ways that would move a user's file out from under them.
///
/// **This takes the environment rather than reading it**, which is what makes it safe here.
/// `crates/CLAUDE.md` rule 9 says `core` never reads the environment, and the concern behind it is
/// concrete: a library that read `HOME` wrote into a developer's real `~/.nport` from inside a test.
/// A function whose caller supplies the reader cannot do that, and putting it here is what stops the
/// CLI and the desktop app from disagreeing about *where* the file is — a disagreement that would
/// look, to a user with both installed, like settings that do not save.
#[must_use]
pub fn path(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    Some(home(env)?.join("config.toml"))
}

/// Where the discovered node list is cached: `~/.nport/nodes.json`. Beside `config.toml`.
#[must_use]
pub fn nodes_path(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    Some(home(env)?.join("nodes.json"))
}

fn home(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let home = env("NPORT_HOME")
        .or_else(|| env("HOME"))
        .or_else(|| env("USERPROFILE"))?;
    if home.is_empty() {
        return None;
    }
    Some(Path::new(&home).join(".nport"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_is_a_config_with_nothing_set() {
        assert_eq!(parse("").expect("parse"), Config::default());
    }

    #[test]
    fn every_field_round_trips() {
        let config = Config {
            subdomain: Some("myapp".to_owned()),
            backend: Some("https://api.nport.link".to_owned()),
            registry: Some("https://api.nport.link".to_owned()),
            node: Some("nport-online-1".to_owned()),
            lang: Some("vi".to_owned()),
            port: Some(3000),
        };

        assert_eq!(parse(&to_toml(&config)).expect("parse"), config);
    }

    /**
    Unset stays unset across a write.

    Writing `subdomain = ""` for a value nobody set turns "unset" into "set to nothing", and the
    two mean different things to every consumer — the CLI would stop generating a name.
    */
    #[test]
    fn a_field_that_was_never_set_is_not_written() {
        let rendered = to_toml(&Config {
            port: Some(3000),
            ..Config::default()
        });

        assert!(rendered.contains("port = 3000"), "{rendered}");
        assert!(!rendered.contains("subdomain"), "{rendered}");
        assert_eq!(parse(&rendered).expect("parse").subdomain, None);
    }

    /// A typo is an error, not a silent default — that is what `deny_unknown_fields` buys.
    #[test]
    fn an_unknown_key_is_refused_rather_than_ignored() {
        let error = parse("subdomian = \"typo\"").expect_err("should refuse");
        assert!(error.reason.contains("unknown field"), "{}", error.reason);
    }

    #[test]
    fn the_path_is_under_nport_home_when_it_is_set() {
        let resolved = path(|key| match key {
            "NPORT_HOME" => Some("/tmp/elsewhere".to_owned()),
            "HOME" => Some("/home/someone".to_owned()),
            _ => None,
        })
        .expect("path");

        assert!(resolved.ends_with("config.toml"));
        assert!(resolved.starts_with("/tmp/elsewhere"));
    }

    /// The cache sits beside the config, so one override moves both.
    #[test]
    fn the_node_cache_is_beside_the_config() {
        let env = |key: &str| (key == "HOME").then(|| "/home/someone".to_owned());

        assert_eq!(
            path(env).expect("config").parent(),
            nodes_path(env).expect("nodes").parent()
        );
    }

    #[test]
    fn no_home_means_no_path_rather_than_a_guess() {
        assert!(path(|_| None).is_none());
        assert!(path(|_| Some(String::new())).is_none());
    }
}
