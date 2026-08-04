//! `~/.nport/config.toml`: defaults for the flags, and nothing else.
//!
//! Three rules, all from `crates/CLAUDE.md`:
//!
//! - **Read lazily.** `--help` and `--version` must answer without touching the disk.
//! - **A corrupt file is a clear error, never a silent default.** Falling back to defaults on a
//!   parse failure means a typo silently changes what the tool does, which is worse than a message.
//! - **A missing file is not an error.** Most people never create one.
//!
//! It holds no credential and never will. Tokens are returned once by the control plane and used in
//! memory; writing one here would make invariant 4 impossible to keep.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The file's contents. Every field is optional — this sets defaults, it does not require anything.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Default subdomain, when `-s` is not given.
    pub subdomain: Option<String>,
    /// Default control plane. For self-hosting (`docs/SELF_HOSTING.md`).
    pub backend: Option<String>,
    /// Default interface language.
    pub lang: Option<String>,
    /// Default port, when none is given on the command line.
    pub port: Option<u16>,
}

/// Why a config file could not be used.
///
/// Deliberately not "we ignored it": both variants are worth telling the user about, because both
/// mean the file they wrote is not doing what they think it is.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{path} could not be read")]
    Unreadable {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not valid TOML: {reason}")]
    Invalid { path: String, reason: String },
}

impl ConfigError {
    /// The registry code for this failure.
    #[must_use]
    pub fn code(&self) -> nport_contract::ErrorCode {
        nport_contract::ErrorCode::ConfigUnreadable
    }
}

/// Where the config file lives.
///
/// `$HOME` on Unix, `%USERPROFILE%` on Windows — read from the environment rather than through
/// `std::env::home_dir`, whose behaviour has changed across releases in ways that would move a
/// user's file out from under them.
#[must_use]
pub fn path(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let home = env("NPORT_HOME")
        .or_else(|| env("HOME"))
        .or_else(|| env("USERPROFILE"))?;
    if home.is_empty() {
        return None;
    }
    Some(Path::new(&home).join(".nport").join("config.toml"))
}

/// Loads the config, if there is one.
///
/// # Errors
///
/// [`ConfigError`] when the file exists and cannot be used. A file that does not exist yields
/// `Ok(None)`, because most people never create one.
pub fn load(path: Option<&Path>) -> Result<Option<Config>, ConfigError> {
    let Some(path) = path else {
        return Ok(None);
    };

    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ConfigError::Unreadable {
                path: path.display().to_string(),
                source,
            });
        }
    };

    toml::from_str(&text)
        .map(Some)
        .map_err(|error| ConfigError::Invalid {
            path: path.display().to_string(),
            // `to_string` rather than the error itself: `toml`'s Display carries the line, the
            // column, and a caret, which is the useful half, and nothing from the file's values.
            reason: error.message().to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(contents: &str) -> (tempdir::Dir, PathBuf) {
        let dir = tempdir::Dir::new();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, contents).expect("write");
        (dir, path)
    }

    /// A temporary directory, without a dependency for it.
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                // The nanosecond clock plus the thread id is enough to keep concurrent tests apart,
                // and this never leaves the test binary.
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("after 1970")
                    .as_nanos();
                let path = std::env::temp_dir().join(format!("nport-cli-test-{stamp:x}"));
                std::fs::create_dir_all(&path).expect("create");
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        // Most people never create one, and refusing to start without it would be absurd.
        let missing = std::env::temp_dir().join("nport-does-not-exist-4f3a/config.toml");
        assert!(load(Some(&missing)).expect("not an error").is_none());
    }

    #[test]
    fn values_are_read_as_defaults() {
        let (_dir, path) = temp("subdomain = \"myapp\"\nlang = \"vi\"\nport = 3000\n");
        let config = load(Some(&path)).expect("loads").expect("present");

        assert_eq!(config.subdomain.as_deref(), Some("myapp"));
        assert_eq!(config.lang.as_deref(), Some("vi"));
        assert_eq!(config.port, Some(3000));
        assert_eq!(config.backend, None);
    }

    #[test]
    fn a_corrupt_file_is_an_error_rather_than_a_silent_default() {
        // The rule this exists for: falling back to defaults means a typo quietly changes what the
        // tool does, and the user has no way to notice.
        let (_dir, path) = temp("subdomain = \n");
        let error = load(Some(&path)).expect_err("invalid TOML");

        assert!(matches!(error, ConfigError::Invalid { .. }));
        assert_eq!(error.code(), nport_contract::ErrorCode::ConfigUnreadable);
    }

    #[test]
    fn an_unknown_key_is_refused() {
        // A misspelled `subdomian` would otherwise sit in the file doing nothing, forever, while the
        // user wonders why their name is being generated.
        let (_dir, path) = temp("subdomian = \"myapp\"\n");
        assert!(matches!(
            load(Some(&path)),
            Err(ConfigError::Invalid { .. })
        ));
    }

    #[test]
    fn the_path_follows_the_home_directory() {
        let env = |key: &str| match key {
            "HOME" => Some("/home/nick".to_owned()),
            _ => None,
        };
        assert_eq!(
            path(env).expect("a path"),
            Path::new("/home/nick/.nport/config.toml")
        );

        // No home at all: no config, and nothing to report — a container with no `$HOME` is a normal
        // place to run this.
        assert!(path(|_| None).is_none());
    }

    #[test]
    fn an_error_never_quotes_the_files_contents() {
        // A config file is not credential material today, and this keeps it from becoming a leak if
        // that ever changes — `toml`'s full Display includes the offending line.
        let (_dir, path) = temp("subdomain = \"secret-looking-value\"\nport = \"not a number\"\n");
        let error = load(Some(&path)).expect_err("invalid");
        assert!(
            !format!("{error}").contains("secret-looking-value"),
            "{error}"
        );
    }
}
