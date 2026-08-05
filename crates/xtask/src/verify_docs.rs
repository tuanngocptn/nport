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

/// Directory names never walked when collecting markdown to check.
///
/// `docs/mockup` is reference-only and excluded from every check by design (root `CLAUDE.md`).
/// `.claude/worktrees` holds live git worktrees of *other* branches — checking those would report
/// another branch's problems here, which is the "fail on someone else's outage" failure this module
/// is otherwise careful to avoid.
const SKIPPED_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    ".next",
    ".open-next",
    "dist",
    "mockup",
    "worktrees",
];

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
        // Every extension this repository actually keeps in a layout block. The list had five and
        // missed `.tsx`, `.mjs`, `.jsonc`, `.html` and `.capnp`, so a bare filename with one of those
        // was skipped rather than checked — `index.html` in `apps/desktop/CLAUDE.md` was the only live
        // instance and it happens to exist, so this closes a latent gap rather than a current lie. It
        // is the same hand-maintained-list-behind-a-guarantee shape as `LAYOUT_DOCS` and `LINKED_DOCS`.
        const CHECKED_EXTENSIONS: [&str; 10] = [
            ".rs", ".ts", ".tsx", ".mjs", ".md", ".toml", ".json", ".jsonc", ".html", ".capnp",
        ];
        let looks_like_path = token.contains('/')
            || CHECKED_EXTENSIONS
                .iter()
                .any(|extension| token.ends_with(extension));
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

/// A repository-relative path with forward slashes, whatever the platform uses natively.
///
/// Both the problem messages and the tests speak in the form the docs themselves use, so neither has
/// to translate. The first version let `to_string_lossy` through raw and the Windows job failed on
/// `docs\\ROADMAP.md` while macOS and Linux passed — a test-only break, since the checker itself was
/// correct, but a real one and only the matrix could see it.
fn repo_relative(repo: &Path, path: &Path) -> String {
    path.strip_prefix(repo)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Every markdown file in the repository, minus [`SKIPPED_DIRS`].
///
/// Discovered rather than listed. The predecessor was a three-entry `LINKED_DOCS` const standing
/// behind root `CLAUDE.md`'s claim that "every markdown link resolves" — it covered three of
/// thirty-five files, because a list is only as current as the last person who added a doc. There is
/// no per-file judgement to make here: a relative link either resolves or it does not, so the set is
/// derivable and a const was the wrong shape for it.
fn markdown_files(repo: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    let mut stack = vec![repo.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();

            if path.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".md") {
                found.push(path);
            }
        }
    }

    found.sort();
    Ok(found)
}

/// Checks `[text](relative/path.md)` links resolve. External URLs and anchors are skipped.
fn check_relative_links(repo: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();

    for path in markdown_files(repo)? {
        let doc = repo_relative(repo, &path);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let base: PathBuf = path.parent().unwrap_or(repo).to_path_buf();

        for target in link_targets(&without_code(&text)) {
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

/// Blanks fenced blocks and inline code spans, preserving every byte position.
///
/// A `](` inside code is not a link, and the checker now reads thirty-five files rather than three, so
/// the odds of meeting one went up with it. The first was a regex in `docs/ARCHITECTURE.md`:
/// `` `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$` `` — the `]` closing the first character class sits
/// against the `(` opening the group, which is `](` exactly. Reporting that as a broken link is the
/// crying-wolf failure this module is built to avoid, and the fix belongs in the scanner rather than
/// in the prose that happened to trip it.
///
/// Blanking rather than deleting, so a target's own text is untouched — `` [`foo`](bar.md) `` still
/// yields `bar.md`, because only the span between the backticks is replaced.
fn without_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_fence = false;

    for line in text.split_inclusive('\n') {
        let fence = line.trim_start().starts_with("```");
        if fence {
            in_fence = !in_fence;
        }
        if fence || in_fence {
            out.extend(line.chars().map(|c| if c == '\n' { '\n' } else { ' ' }));
            continue;
        }

        // Backtick *runs*, not single backticks. CommonMark opens a span with a run of N and closes it
        // with a run of exactly N, which is how you write a span containing a backtick — and this
        // repository's docs use that form constantly (``` `` `code` `` ```). Toggling per character made
        // a two-backtick opener cancel itself, so the span stayed visible and a placeholder inside one
        // was reported as a broken link. Caught by this checker on the very commit that added it.
        let chars: Vec<char> = line.chars().collect();
        let mut at = 0;
        while at < chars.len() {
            if chars[at] != '`' {
                out.push(chars[at]);
                at += 1;
                continue;
            }

            let run = run_length(&chars, at);
            let close = closing_run(&chars, at + run, run);
            let blank_to = close.map_or(at + run, |found| found + run);
            for c in &chars[at..blank_to] {
                out.push(if *c == '\n' { '\n' } else { ' ' });
            }
            at = blank_to;
        }
    }

    out
}

/// How many backticks start at `at`.
fn run_length(chars: &[char], at: usize) -> usize {
    chars[at..].iter().take_while(|c| **c == '`').count()
}

/// Index of the next run of *exactly* `wanted` backticks at or after `from`.
fn closing_run(chars: &[char], from: usize, wanted: usize) -> Option<usize> {
    let mut at = from;
    while at < chars.len() {
        if chars[at] == '`' {
            let run = run_length(chars, at);
            if run == wanted {
                return Some(at);
            }
            at += run;
        } else {
            at += 1;
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The false positive that expanding the file set turned up.
    ///
    /// `[a-z0-9](` is `](` as far as a naive scan is concerned. This is the regex from
    /// `docs/ARCHITECTURE.md` §subdomain validation, verbatim.
    #[test]
    fn a_regex_in_a_code_span_is_not_a_link() {
        let text = "Validate: `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$`, 3–63 characters.";

        assert!(
            link_targets(&without_code(text)).is_empty(),
            "{:?}",
            link_targets(&without_code(text))
        );
    }

    /// A double-backtick span is the idiomatic way to write code containing a backtick, and this
    /// repository's docs use it constantly. Toggling per character made the opener cancel itself.
    #[test]
    fn a_double_backtick_span_is_blanked_like_any_other() {
        let text = "the form `` [`Name`](placeholder) `` shows the syntax";

        assert!(
            link_targets(&without_code(text)).is_empty(),
            "{:?}",
            link_targets(&without_code(text))
        );
    }

    #[test]
    fn an_unterminated_backtick_does_not_swallow_the_rest_of_the_line() {
        // A stray backtick is a typo, not a licence to stop checking. Only the tick is blanked.
        let text = "oops ` and then [real](README.md)";

        assert_eq!(
            link_targets(&without_code(text)),
            vec!["README.md".to_owned()]
        );
    }

    #[test]
    fn a_link_whose_text_is_code_still_resolves() {
        // Blanking rather than deleting is what keeps this working: only the span between the
        // backticks is replaced, so the `](` that follows is still where it was.
        let text = "see [`TunnelManager`](crates/core/src/tunnel.rs) for the loop";

        assert_eq!(
            link_targets(&without_code(text)),
            vec!["crates/core/src/tunnel.rs".to_owned()]
        );
    }

    #[test]
    fn a_link_inside_a_fenced_block_is_not_checked() {
        // A fence often holds sample markdown or shell output; neither is a claim about this repo.
        let text = "before\n```\n[sample](does/not/exist.md)\n```\nafter [real](README.md)\n";

        assert_eq!(
            link_targets(&without_code(text)),
            vec!["README.md".to_owned()]
        );
    }

    #[test]
    fn external_links_and_anchors_are_skipped() {
        let text = "[a](https://x.test) [b](mailto:x@y.test) [c](#section) [d](docs/API.md)";

        assert_eq!(
            link_targets(&without_code(text)),
            vec!["docs/API.md".to_owned()]
        );
    }

    /// Proves `check_relative_links` reads the *discovered* set, not a hardcoded few.
    ///
    /// The helper test below only shows `markdown_files` walks correctly; reverting the call site to a
    /// three-entry list left it green, which is the same trap as testing a buffer's wire path and not
    /// its record. This drives the real function against a tree whose files are named nothing like the
    /// old list, so a return to one would report zero problems and fail here.
    #[test]
    fn link_checking_covers_every_discovered_file() {
        let root = std::env::temp_dir().join("nport-verify-docs-link-coverage");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules")).expect("mkdir");
        std::fs::write(root.join("top.md"), "[x](gone-a.md)").expect("write");
        std::fs::write(root.join("nested/deep.md"), "[y](gone-b.md)").expect("write");
        std::fs::write(root.join("node_modules/dep.md"), "[z](gone-c.md)").expect("write");

        let problems = check_relative_links(&root).expect("check");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(
            problems.iter().any(|p| p.contains("gone-a.md")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("gone-b.md")),
            "a file below the root was not checked: {problems:?}"
        );
        assert!(
            !problems.iter().any(|p| p.contains("gone-c.md")),
            "node_modules was walked: {problems:?}"
        );
    }

    /// Built with `join` so the input uses whatever separator the platform does, asserted with
    /// forward slashes because that is the form the docs are written in.
    ///
    /// This is the assertion the previous commit got wrong. It compared a `to_string_lossy` path
    /// against a forward-slash literal, which holds on macOS and Linux and fails on Windows — and the
    /// three-OS matrix is the only thing that could see it, since `cargo test` locally exercises one
    /// separator. The checker was fine; the test was not.
    #[test]
    fn a_repo_relative_path_always_uses_forward_slashes() {
        let repo = Path::new("/tmp/repo");
        let nested = repo.join("docs").join("conventions").join("rust.md");

        assert_eq!(repo_relative(repo, &nested), "docs/conventions/rust.md");
        assert_eq!(repo_relative(repo, &repo.join("README.md")), "README.md");
    }

    #[test]
    fn markdown_discovery_finds_the_docs_and_skips_the_noise() {
        // The whole point of replacing `LINKED_DOCS`: a doc added tomorrow is covered without anyone
        // remembering to list it. Asserted against the real tree, since that is what ships.
        let repo = crate::codegen::repo_root().expect("repo root");
        let found = markdown_files(&repo).expect("walk");
        let relative: Vec<String> = found.iter().map(|p| repo_relative(&repo, p)).collect();

        for expected in ["README.md", "docs/ROADMAP.md", "crates/CLAUDE.md"] {
            assert!(relative.iter().any(|p| p == expected), "missing {expected}");
        }
        assert!(
            relative.len() > 20,
            "found only {} — the walk is not reaching the tree",
            relative.len()
        );
        // Compared component by component, not as a substring: `.github/pull_request_template.md`
        // contains `.git` and is a file the walk *should* find. A substring test here would have
        // demanded the walk skip it — the same boundary mistake this checker's own path rules avoid.
        for path in &found {
            for component in path.components() {
                let name = component.as_os_str().to_string_lossy();
                assert!(
                    !SKIPPED_DIRS.contains(&name.as_ref()),
                    "walked into {name}: {}",
                    path.display()
                );
            }
        }
        assert!(
            relative
                .iter()
                .any(|p| p == ".github/pull_request_template.md"),
            "the walk should still reach .github, which merely starts with `.git`"
        );
    }
}
