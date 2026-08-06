//! Generates `schema/cli.json` from the CLI's own clap definition.
//!
//! ```text
//! crates/cli/src/args.rs  →  Args::command()  →  schema/cli.json
//! ```
//!
//! **Read from clap, not from prose.** Three `CLAUDE.md` files claimed this file existed long before it
//! did (defect 38), and the reason it was worth building rather than deleting the claim is that a flag
//! reference is the definition of something a human and a program must agree on — invariant 5. A table
//! someone retypes drifts the first time a flag's help text changes, and it drifts silently, because
//! nothing reads a table.
//!
//! The two rejected alternatives are worth naming. **Parsing `--help`** would be matching on formatted
//! text to recover structure that clap already has typed — the mistake ADR-0018 exists to forbid, one
//! layer down. **A `FLAGS` table beside the struct with a test asserting the two agree** would work, and
//! costs a second place to edit forever, to avoid a dependency edge that turned out to be cheap.
//!
//! What this deliberately does **not** capture: the help text's *wording* per language. `--help` is
//! English from the derive, and `crates/cli/src/i18n.rs` translates the runtime messages rather than the
//! flag reference. If the reference is ever localised, the strings belong in `i18n.rs` and this file
//! stays the structure.

use std::fmt::Write as _;

use clap::CommandFactory as _;
use nport::args::Args;
use serde_json::{Map, Value, json};

/// Builds the document. Pure, so the test below can assert its shape without touching the tree.
pub fn document() -> Value {
    // **`build()` matters, and two of this module's tests exist because of it.** Before it runs, clap has
    // not yet injected its own `--help` and `--version`, and it has not resolved each argument's
    // `num_args` — so an unbuilt `Args` reports `--quiet` as taking a value called `QUIET`, which would
    // have put `--quiet QUIET` in the published reference. Reading a builder mid-construction gives you
    // the shape the author wrote, not the shape the binary parses.
    let mut command = Args::command();
    command.build();

    let mut flags = Vec::new();
    let mut positionals = Vec::new();

    for argument in command.get_arguments() {
        let id = argument.get_id().as_str();
        let takes_value = argument
            .get_num_args()
            .is_some_and(|range| range.takes_values());
        let entry = json!({
            "id": id,
            "short": argument.get_short().map(|c| c.to_string()),
            "long": argument.get_long(),
            // Only meaningful when the argument takes one. clap keeps a derived name on switches too,
            // and emitting it would document a value `--quiet` rejects.
            "valueName": takes_value
                .then(|| {
                    argument
                        .get_value_names()
                        .and_then(|names| names.first())
                        .map(|name| name.as_str())
                })
                .flatten(),
            "help": argument.get_help().map(ToString::to_string),
            "takesValue": takes_value,
            "required": argument.is_required_set(),
            // `--help` and `--version` are clap's, not ours: they belong in the reference because the
            // binary accepts them, but their text is clap's to change, so a renderer can group or omit
            // them without hardcoding the two names itself.
            "builtin": matches!(id, "help" | "version"),
        });

        if argument.is_positional() {
            positionals.push(entry);
        } else {
            flags.push(entry);
        }
    }

    let mut document = Map::new();
    document.insert(
        "$generated".to_owned(),
        json!("by `cargo xtask codegen` from crates/cli/src/args.rs — do not edit"),
    );
    document.insert("name".to_owned(), json!(command.get_name()));
    document.insert(
        "about".to_owned(),
        json!(command.get_about().map(ToString::to_string)),
    );
    // Deliberately no version field. `crates/cli/Cargo.toml` owns the version, `apps/web` may not
    // hardcode one (its rule 8), and a number baked in here would be a third copy going stale between
    // releases. The reference describes the *shape* of the interface, which is what does not move.
    document.insert("positionals".to_owned(), json!(positionals));
    document.insert("flags".to_owned(), json!(flags));

    Value::Object(document)
}

/// Serializes with a trailing newline, matching what `pnpm codegen` writes for the other `schema/`
/// files — the drift gate diffs bytes, so a missing newline fails CI on a tree nobody touched.
pub fn render() -> Result<String, String> {
    let mut out = serde_json::to_string_pretty(&document())
        .map_err(|error| format!("serializing the CLI reference: {error}"))?;
    writeln!(out).unwrap();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flag(document: &Value, long: &str) -> Value {
        document["flags"]
            .as_array()
            .expect("flags is an array")
            .iter()
            .find(|entry| entry["long"] == long)
            .unwrap_or_else(|| panic!("no --{long} in the generated reference"))
            .clone()
    }

    #[test]
    fn describes_every_flag_the_binary_accepts() {
        let document = document();
        let longs: Vec<&str> = document["flags"]
            .as_array()
            .expect("flags is an array")
            .iter()
            .filter_map(|entry| entry["long"].as_str())
            .collect();

        // Every flag in `args.rs`, named literally. The point is not to restate the struct — it is that
        // adding a flag without regenerating fails here as well as in the drift gate, and this failure
        // says which flag.
        for expected in [
            "port",
            "subdomain",
            "backend",
            "registry",
            "node",
            "lang",
            "quiet",
            "help",
            "version",
        ] {
            assert!(longs.contains(&expected), "--{expected} missing: {longs:?}");
        }
    }

    #[test]
    fn carries_the_help_text_clap_shows() {
        // The help string comes from the doc comment on the field, so this is the check that the
        // reference and `--help` cannot disagree.
        //
        // **Note the missing full stop.** `args.rs` writes "…Omit to have one generated." and clap's
        // *short* help — what `--help` prints and what `get_help` returns — drops the trailing period.
        // Asserting clap's version rather than the source's is the whole point: the reference has to say
        // what the binary says, and if that ever diverges this is where it shows.
        assert_eq!(
            flag(&document(), "subdomain")["help"],
            json!("The subdomain to claim. Omit to have one generated")
        );
    }

    #[test]
    fn records_the_port_as_both_positional_and_a_flag() {
        // v2's central argument-parsing defect: `nport -s app 3000` silently tunnelled the default port
        // because only a position was accepted. The reference has to show both, or someone reading it
        // learns the shape v2 had.
        let document = document();
        let positionals = document["positionals"].as_array().expect("array");
        assert_eq!(positionals.len(), 1, "expected exactly one positional");
        assert_eq!(positionals[0]["valueName"], json!("PORT"));
        assert_eq!(flag(&document, "port")["valueName"], json!("PORT"));
    }

    #[test]
    fn distinguishes_a_switch_from_a_flag_that_takes_a_value() {
        // Without this the reference would render `--quiet NAME`, which is worse than no reference.
        assert_eq!(flag(&document(), "quiet")["takesValue"], json!(false));
        assert_eq!(flag(&document(), "subdomain")["takesValue"], json!(true));
    }

    #[test]
    fn marks_claps_own_flags_as_builtin() {
        // So a renderer can group them, or omit them, without hardcoding their names itself.
        assert_eq!(flag(&document(), "help")["builtin"], json!(true));
        assert_eq!(flag(&document(), "subdomain")["builtin"], json!(false));
    }

    #[test]
    fn requires_nothing() {
        // ADR-0019: nothing prompts, so nothing is required — `nport` with no arguments has to be able
        // to fail with a code rather than with clap's usage error. A required flag appearing here would
        // mean that guarantee had been broken somewhere in `args.rs`.
        let document = document();
        for entry in document["flags"]
            .as_array()
            .expect("array")
            .iter()
            .chain(document["positionals"].as_array().expect("array"))
        {
            assert_eq!(
                entry["required"],
                json!(false),
                "{} is required",
                entry["id"]
            );
        }
    }

    #[test]
    fn ends_with_a_newline() {
        // The drift gate diffs bytes against what the other `schema/` files look like.
        assert!(render().expect("renders").ends_with("}\n"));
    }
}
