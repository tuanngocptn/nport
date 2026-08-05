//! `cargo xtask verify-docs` — checks that the documentation describes the repository as it is.
//!
//! Until now this was a no-op that exited zero, which is worse than absent: CI displayed a
//! passing check that checked nothing. It missed `crates/protocol/src/h2.rs` being documented in
//! two places and existing in none.
//!
//! Three checks, each catching a class of rot that reviewers reliably miss:
//!
//! 1. **Paths in fenced layout blocks exist.** A `CLAUDE.md` that names a file which was renamed
//!    or never written sends the next reader — human or agent — looking for something imaginary.
//! 2. **Error codes round-trip.** Every code in `docs/ERRORS.md` is in the registry and vice
//!    versa, so the generated table and the authority cannot disagree.
//! 3. **Relative markdown links resolve.** A dead link in contributor docs is a dead end.
//!
//! Deliberately not checked: prose accuracy, external URLs (a network call would make CI flaky
//! and fail on someone else's outage), and line-count limits on `CLAUDE.md` files.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Files whose fenced blocks are treated as repository layout.
const LAYOUT_DOCS: [&str; 7] = [
    "CLAUDE.md",
    "crates/CLAUDE.md",
    "crates/protocol/CLAUDE.md",
    "apps/api/CLAUDE.md",
    "apps/web/CLAUDE.md",
    "apps/desktop/CLAUDE.md",
    "docs/ARCHITECTURE.md",
];

/// Markdown files whose relative links are checked.
const LINKED_DOCS: [&str; 3] = ["README.md", "docs/CONTRIBUTING.md", "docs/ROADMAP.md"];

pub fn run() -> Result<(), String> {
    let repo = crate::codegen::repo_root()?;
    let mut problems: Vec<String> = Vec::new();

    problems.extend(check_layout_paths(&repo)?);
    problems.extend(check_error_codes(&repo)?);
    problems.extend(check_relative_links(&repo)?);

    if problems.is_empty() {
        println!("verify-docs: documentation matches the repository");
        return Ok(());
    }

    for problem in &problems {
        println!("  {problem}");
    }
    Err(format!("{} documentation problem(s)", problems.len()))
}

/// Extracts path-shaped tokens from fenced code blocks and checks each one exists.
///
/// Conservative by design: a token counts as a path only if it contains a `/` or a known source
/// extension, and trailing punctuation and inline comments are stripped. The failure mode to avoid
/// is a checker nobody trusts because it cries wolf.
fn check_layout_paths(repo: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();

    for doc in LAYOUT_DOCS {
        let path = repo.join(doc);
        let Ok(text) = std::fs::read_to_string(&path) else {
            problems.push(format!("{doc}: listed in verify-docs but does not exist"));
            continue;
        };
        // Layout blocks are relative to the doc's own directory, which is what makes
        // `src/h2.rs` in `crates/protocol/CLAUDE.md` mean `crates/protocol/src/h2.rs`.
        let base = path.parent().unwrap_or(repo).to_path_buf();

        // Three states, not two. A boolean gets this wrong: the *closing* fence of a ```bash block
        // also has an empty info string, so toggling on "is this a layout fence" turns scanning ON
        // at the end of a command block and treats the prose that follows as a file tree. That is
        // exactly what the first attempt did.
        let mut fence: Option<bool> = None;
        for line in text.lines() {
            if let Some(info) = line.trim_start().strip_prefix("```") {
                fence = match fence {
                    // Any fence marker closes an open fence, whatever its info string.
                    Some(_) => None,
                    // Only unlabelled and `text` fences hold layout; a ```bash fence holds
                    // commands whose arguments are not repository paths.
                    None => Some(matches!(info.trim(), "" | "text")),
                };
                continue;
            }
            if fence != Some(true) || is_command_line(line) || is_annotation(line) {
                continue;
            }
            for candidate in path_candidates(line) {
                if !exists(repo, &base, &candidate) {
                    problems.push(format!("{doc}: `{candidate}` does not exist"));
                }
            }
        }
    }

    Ok(problems)
}

/// Pulls plausible repository paths out of one line of a layout block.
/// Whether a layout line is an annotation about a file that does not exist yet.
///
/// The convention is mechanical rather than phrase-based: **wrap the path in parentheses.** A
/// planned file is worth naming in a layout block — it tells the next reader where it will go — but
/// it must be visibly distinct from a file that is there, or the block lies. Phrase-matching on
/// "not yet written" would be a checker that fails the moment someone words it differently.
fn is_annotation(line: &str) -> bool {
    line.trim_start().starts_with('(')
}

/// Whether a line is a shell command rather than a tree entry.
///
/// Layout fences and command fences both appear unlabelled in this repo, so the discriminator has
/// to be the line itself.
fn is_command_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    const COMMANDS: [&str; 12] = [
        "git", "pnpm", "npm", "npx", "cargo", "curl", "node", "corepack", "rustup", "wrangler",
        "export", "cp",
    ];
    trimmed.starts_with('$')
        || trimmed.starts_with('#')
        || COMMANDS
            .iter()
            .any(|command| trimmed.starts_with(&format!("{command} ")))
}

fn path_candidates(line: &str) -> Vec<String> {
    // Tree-drawing characters and comments are noise; a layout line is typically
    // `src/quic.rs      QUIC transport (primary)`.
    let cleaned = line.replace(['│', '├', '└', '─'], " ");
    let mut out = Vec::new();

    for raw in cleaned.split_whitespace() {
        let token = raw.trim_matches(|c: char| matches!(c, '`' | ',' | ';' | ')' | '(' | '"'));
        if token.is_empty() || token.starts_with('#') || token.starts_with("//") {
            continue;
        }
        // Must look like a path, not like prose.
        let looks_like_path = token.contains('/')
            || token.ends_with(".rs")
            || token.ends_with(".ts")
            || token.ends_with(".md")
            || token.ends_with(".toml")
            || token.ends_with(".json");
        if !looks_like_path {
            continue;
        }
        // Globs and placeholders are not checkable.
        if token.contains('*') || token.contains('<') || token.contains('{') {
            continue;
        }
        // Not repository paths, and each of these produced a false positive on the first run:
        //   `:`  — URLs (`http://localhost:8787`) and git revisions (`main:src/tunnel.ts`)
        //   `@`  — package names (`@nport/api`)
        //   `/…` — absolute routes in a diagram (`/v1/tunnels`)
        //   `.go`— cloudflared source, which lives in another repository
        //   `.`  — a leading dot is a relative marker in prose, not a tree entry
        if token.contains(':')
            || token.starts_with('@')
            || token.starts_with('/')
            || token.starts_with('.')
            || token.ends_with(".go")
        {
            continue;
        }
        // Prose with a slash: "HTTP/2", "and/or", "TCP/UDP".
        if token
            .split('/')
            .all(|part| part.chars().next().is_some_and(char::is_uppercase))
        {
            continue;
        }
        out.push(token.to_owned());
    }

    // Only the first token on a line is the path; the rest is its description.
    out.truncate(1);
    out
}

fn exists(repo: &Path, base: &Path, candidate: &str) -> bool {
    let trimmed = candidate.trim_end_matches('/');
    base.join(trimmed).exists() || repo.join(trimmed).exists()
}

/// Every code in `docs/ERRORS.md` is in `schema/errors.json`, and every code in the registry is
/// documented. Both directions, because either gap is a lie to a client author.
fn check_error_codes(repo: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();

    let doc_path = repo.join("docs/ERRORS.md");
    let registry_path = repo.join("schema/errors.json");

    let doc =
        std::fs::read_to_string(&doc_path).map_err(|e| format!("reading docs/ERRORS.md: {e}"))?;
    let registry_text = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("reading schema/errors.json: {e} — run `pnpm codegen`"))?;
    let registry: serde_json::Value = serde_json::from_str(&registry_text)
        .map_err(|e| format!("parsing schema/errors.json: {e}"))?;

    let registered: BTreeSet<String> = registry
        .get("errors")
        .and_then(serde_json::Value::as_object)
        .ok_or("schema/errors.json has no `errors` object")?
        .keys()
        .cloned()
        .collect();

    // Table rows look like `| `CODE` | 409 | ...`.
    let documented: BTreeSet<String> = doc
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("| `")?;
            let code = rest.split('`').next()?;
            code.chars()
                .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
                .then(|| code.to_owned())
        })
        .filter(|code| !code.is_empty())
        .collect();

    for code in registered.difference(&documented) {
        problems.push(format!(
            "docs/ERRORS.md: `{code}` is registered but undocumented"
        ));
    }
    for code in documented.difference(&registered) {
        problems.push(format!(
            "docs/ERRORS.md: `{code}` is documented but not in the registry"
        ));
    }

    Ok(problems)
}

/// Checks `[text](relative/path.md)` links resolve. External URLs and anchors are skipped.
fn check_relative_links(repo: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();

    for doc in LINKED_DOCS {
        let path = repo.join(doc);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let base: PathBuf = path.parent().unwrap_or(repo).to_path_buf();

        for target in link_targets(&text) {
            // Strip an anchor; the file is what is checkable.
            let file = target.split('#').next().unwrap_or(&target);
            if file.is_empty() {
                continue;
            }
            if !base.join(file).exists() && !repo.join(file).exists() {
                problems.push(format!("{doc}: link `{target}` does not resolve"));
            }
        }
    }

    Ok(problems)
}

fn link_targets(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == ']' && index + 1 < bytes.len() && bytes[index + 1] == '(' {
            let mut end = index + 2;
            while end < bytes.len() && bytes[end] != ')' {
                end += 1;
            }
            let target: String = bytes[index + 2..end.min(bytes.len())].iter().collect();
            let target = target.trim().to_owned();
            let external = target.starts_with("http://")
                || target.starts_with("https://")
                || target.starts_with("mailto:")
                || target.starts_with('#');
            if !external && !target.is_empty() {
                out.push(target);
            }
            index = end + 1;
            continue;
        }
        index += 1;
    }

    out
}
