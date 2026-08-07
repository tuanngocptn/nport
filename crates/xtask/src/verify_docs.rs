//! `cargo xtask verify-docs` — checks that the documentation describes the repository as it is.
//!
//! Until now this was a no-op that exited zero, which is worse than absent: CI displayed a
//! passing check that checked nothing. It missed `crates/protocol/src/h2.rs` being documented in
//! two places and existing in none.
//!
//! Four checks, each catching a class of rot that reviewers reliably miss:
//!
//! 1. **Paths in fenced layout blocks exist.** A `CLAUDE.md` that names a file which was renamed
//!    or never written sends the next reader — human or agent — looking for something imaginary.
//! 2. **Error codes round-trip.** Every code in `docs/ERRORS.md` is in the registry and vice
//!    versa, so the generated table and the authority cannot disagree.
//! 3. **Relative markdown links resolve.** A dead link in contributor docs is a dead end.
//! 4. **Every ADR is in the decision index, and every index row is an ADR.** `docs/DECISIONS.md`
//!    asks for the row itself and seven had gone missing, which makes settled decisions look
//!    unmade — the one thing that file exists to prevent.
//!
//! 5. **`CLAUDE.md` files stay inside their line caps.** Root `CLAUDE.md` states them as hard limits
//!    — "Root ≤130 lines, per-app ≤90" — and this docblock used to list them as *deliberately not
//!    checked*. That was the wrong call: when the check was finally written, **three files were over**,
//!    two of them long before anyone noticed. A stated limit nobody measures is the shape every defect
//!    in `docs/ROADMAP.md`'s list shares, and the cost of measuring it is a line count.
//!
//! 6. **`docs/SELF_HOSTING.md`'s tuning table matches `apps/node/wrangler.jsonc`.** Both that a var
//!    exists and that its documented default is the real one. Five of that table's eight rows named vars
//!    that had never existed, and one recommended a value the code rejects at runtime (defect 39). It is
//!    the narrowest check here on purpose — see [`check_self_hosting_vars`] for the general version that
//!    was prototyped and rejected.
//!
//! Deliberately not checked: prose accuracy, and external URLs (a network call would make CI flaky
//! and fail on someone else's outage).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Files whose fenced blocks are treated as repository layout, beyond every `CLAUDE.md`.
///
/// Only one, and it earns its place: `docs/ARCHITECTURE.md` carries a layout block and is not a
/// `CLAUDE.md`. Anything else added here should be asked the same question — is it *discoverable*
/// instead?
const EXTRA_LAYOUT_DOCS: [&str; 1] = ["docs/ARCHITECTURE.md"];

/// Every doc whose fenced blocks are checked as repository layout.
///
/// **Discovered, not listed.** This was a seven-entry const, and defect 22 in `docs/ROADMAP.md` is
/// what it cost: the list omitted `apps/web/CLAUDE.md` and `apps/desktop/CLAUDE.md`, and eleven dead
/// paths had rotted behind the gap. Adding `apps/registry/CLAUDE.md` would have been the same story a
/// second time — the file would simply not have been checked, and nothing would have said so.
///
/// A `CLAUDE.md` with no layout block contributes nothing, so scanning them all costs only the read.
/// That is the whole argument the old comment made against discovery ("only some files have one") and
/// it was the wrong way round: a file without a block is free, and a file missing from a list is a
/// silent hole.
fn layout_docs(repo: &Path) -> Result<Vec<String>, String> {
    let mut docs: BTreeSet<String> = markdown_files(repo)?
        .iter()
        .filter(|path| path.file_name().is_some_and(|name| name == "CLAUDE.md"))
        .map(|path| repo_relative(repo, path))
        .collect();
    for extra in EXTRA_LAYOUT_DOCS {
        docs.insert(extra.to_owned());
    }
    Ok(docs.into_iter().collect())
}

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
    problems.extend(check_decision_index(&repo)?);
    problems.extend(check_line_caps(&repo)?);
    problems.extend(check_self_hosting_vars(&repo)?);
    problems.extend(check_adr_references(&repo)?);

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

    for doc in layout_docs(repo)? {
        let path = repo.join(&doc);
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
        //   `@`  — package names (`@nport/node`)
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
/// Root `CLAUDE.md` is at most [`ROOT_LINE_CAP`] lines and every other one at most [`NESTED_LINE_CAP`].
///
/// The caps come from root `CLAUDE.md`'s own documentation rules, and they exist because these files
/// are read *first* by every agent and every new contributor: past a screen or two they stop being
/// navigation and start being something to skim. Enforced here rather than trusted, because they were
/// stated as hard limits and quietly exceeded by three files.
///
/// `.claude/CLAUDE.md` needs no exemption — it is ten lines. If something ever legitimately needs
/// more, raise the cap here *and* in the rule, so the two cannot disagree.
fn check_line_caps(repo: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();

    for doc in markdown_files(repo)? {
        if doc.file_name().is_none_or(|name| name != "CLAUDE.md") {
            continue;
        }
        let relative = repo_relative(repo, &doc);
        let text = std::fs::read_to_string(&doc)
            .map_err(|error| format!("reading {relative}: {error}"))?;
        let lines = text.lines().count();
        let cap = if relative == "CLAUDE.md" {
            ROOT_LINE_CAP
        } else {
            NESTED_LINE_CAP
        };
        if lines > cap {
            problems.push(format!(
                "{relative}: {lines} lines, over the {cap}-line cap in root CLAUDE.md's documentation rules"
            ));
        }
    }

    Ok(problems)
}

/// From root `CLAUDE.md` § Documentation rules. Change both together or they disagree.
const ROOT_LINE_CAP: usize = 130;
const NESTED_LINE_CAP: usize = 90;

/// Every ADR in `docs/DECISIONS.md` has a row in that file's own index, and every row has an ADR.
///
/// The file states the rule itself — "New entries: next number, status `Accepted`, and a one-line
/// entry in the index" — and **seven entries had accumulated without one**, 0038 through 0044, before
/// this check existed. The index is what a reader scans to find whether a decision has been made, so
/// a decision missing from it is a decision that gets re-litigated.
///
/// Same family as the `LAYOUT_DOCS` and `LINKED_DOCS` gaps (`docs/ROADMAP.md`, defects 22 and 25),
/// and the same cure: a rule stated in prose is worth what its checker is worth. Both directions are
/// checked, because either alone rots — an index row with no ADR behind it is a promise of a decision
/// nobody wrote.
fn check_decision_index(repo: &Path) -> Result<Vec<String>, String> {
    let path = repo.join("docs/DECISIONS.md");
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("reading {}: {error}", repo_relative(repo, &path)))?;

    let mut headings: Vec<String> = Vec::new();
    let mut rows: Vec<String> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ADR-") {
            headings.push(number(rest));
        } else if let Some(rest) = line.strip_prefix("| 0") {
            // The index's own rows. `| 0` rather than `|` so the header separator and any other
            // table in the file are not mistaken for one.
            rows.push(number(&format!("0{rest}")));
        }
    }

    let mut problems = Vec::new();
    for adr in &headings {
        if !rows.contains(adr) {
            problems.push(format!(
                "docs/DECISIONS.md: ADR-{adr} has no row in the index — the file's own rule asks for one"
            ));
        }
    }
    for row in &rows {
        if !headings.contains(row) {
            problems.push(format!(
                "docs/DECISIONS.md: the index lists {row} but no `## ADR-{row}` entry exists"
            ));
        }
    }
    if headings.is_empty() {
        problems
            .push("docs/DECISIONS.md: no ADR headings found — has the format changed?".to_owned());
    }
    Ok(problems)
}

/// The leading digits of `0045 — Title` or `0045 | Title |`, which is all either form shares.
fn number(rest: &str) -> String {
    rest.chars().take_while(char::is_ascii_digit).collect()
}

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

/// Every `ADR-NNNN` mentioned anywhere in the repository is an ADR that exists.
///
/// **Written because I broke it.** ADR-0049 was cited thirteen times across eight source files —
/// module docs, test rationales, schema comments — before a line of it was written. That is defect
/// 38's shape exactly (three files claiming a generated flag reference nothing generated), committed
/// while fixing that very class of bug, and nothing caught it: [`check_decision_index`] compares
/// `docs/DECISIONS.md` against itself, so a reference from *outside* that file is invisible to it.
///
/// Unlike the prose sweeps rejected in [`check_self_hosting_vars`], this one has no false positives to
/// weigh: `ADR-NNNN` is an identifier with exactly one spelling and one authority. Measured before
/// landing it — 49 distinct ADRs referenced across the tree, 48 written, and the single dangling one
/// was mine.
fn check_adr_references(repo: &Path) -> Result<Vec<String>, String> {
    let decisions = std::fs::read_to_string(repo.join("docs/DECISIONS.md"))
        .map_err(|error| format!("reading docs/DECISIONS.md: {error}"))?;

    let written: std::collections::BTreeSet<String> = decisions
        .lines()
        .filter_map(|line| line.strip_prefix("## ADR-"))
        .filter_map(|rest| rest.get(..4))
        .map(str::to_owned)
        .collect();

    let mut problems = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    for file in tracked_files(repo)? {
        // The mockup is a wholesale export and is excluded from every check (`docs/mockup/README.md`).
        if file.starts_with("docs/mockup") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(repo.join(&file)) else {
            continue;
        };
        for number in adr_numbers(&text) {
            if !written.contains(&number) && seen.insert((file.clone(), number.clone())) {
                problems.push(format!(
                    "{file} cites ADR-{number}, which is not in docs/DECISIONS.md"
                ));
            }
        }
    }
    Ok(problems)
}

/// The four digits after each `ADR-` in a body of text.
fn adr_numbers(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while let Some(offset) = text[index..].find("ADR-") {
        let start = index + offset + 4;
        let digits: String = bytes
            .get(start..start + 4)
            .and_then(|slice| std::str::from_utf8(slice).ok())
            .filter(|slice| slice.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or_default()
            .to_owned();
        if !digits.is_empty() {
            out.push(digits);
        }
        index = start;
    }
    out
}

/// Every file git tracks, so the check cannot be dodged by adding one.
fn tracked_files(repo: &Path) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-files"])
        .output()
        .map_err(|error| format!("running git ls-files: {error}"))?;
    if !output.status.success() {
        return Err("git ls-files failed".to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_owned)
        .collect())
}

/// Every var in `docs/SELF_HOSTING.md`'s tuning table exists in `apps/node/wrangler.jsonc`, with the
/// default the table claims.
///
/// **This table was wrong in five of its eight rows.** It named `TUNNEL_MAX_AGE_HOURS`,
/// `HEARTBEAT_TIMEOUT_SECONDS`, `MAX_LEASES_PER_SOURCE`, `MAX_CREATES_PER_HOUR` and `RESERVED_EXTRA` —
/// none of which has ever existed — and recommended `POW_DIFFICULTY_BITS = 0`, which `worker-kit`'s
/// `MIN_BITS = 1` rejects with a `RangeError`, so following the advice broke every provision. Defect 39.
///
/// The check is narrow on purpose. The obvious general version — *every* `SCREAMING_SNAKE` token in the
/// docs must appear somewhere in the source — was prototyped and rejected: it found 12 tokens, and 10 were
/// legitimate (Phase 3 CI secrets that do not exist yet, an HTTP/2 frame name, and this page's own new
/// prose saying two vars do *not* exist). Ten exceptions is an allowlist, and an allowlist behind a
/// guarantee is the thing this file already distrusts twice over. One table with a real authority behind
/// it is checkable without one.
fn check_self_hosting_vars(repo: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();

    let doc = std::fs::read_to_string(repo.join("docs/SELF_HOSTING.md"))
        .map_err(|error| format!("reading docs/SELF_HOSTING.md: {error}"))?;
    let wrangler = std::fs::read_to_string(repo.join("apps/node/wrangler.jsonc"))
        .map_err(|error| format!("reading apps/node/wrangler.jsonc: {error}"))?;

    let Some(table) = tuning_table(&doc) else {
        // Not "no rows, nothing to check": the section vanishing is how a check quietly stops checking.
        problems.push(
            "docs/SELF_HOSTING.md: no `## Tuning` section with a table — `check_self_hosting_vars` \
             is keyed on that heading and has just stopped verifying anything"
                .to_owned(),
        );
        return Ok(problems);
    };

    if table.is_empty() {
        problems.push("docs/SELF_HOSTING.md: the `## Tuning` table has no var rows".to_owned());
    }

    for (var, default) in table {
        // The top-level `vars` block is what a fresh deployment gets; `env.staging` overrides some of
        // them, which is why the documented default is compared against the top level only.
        match top_level_var(&wrangler, &var) {
            None => problems.push(format!(
                "docs/SELF_HOSTING.md § Tuning names `{var}`, which is not in apps/node/wrangler.jsonc"
            )),
            Some(actual) if actual != default => problems.push(format!(
                "docs/SELF_HOSTING.md § Tuning says `{var}` defaults to `{default}`, \
                 but apps/node/wrangler.jsonc says `{actual}`"
            )),
            Some(_) => {}
        }
    }

    Ok(problems)
}

/// The `(var, documented default)` pairs from the `## Tuning` table, or `None` if there is no such table.
///
/// Rows look like `| `LEASE_TTL_SECONDS` | `14400` | notes |`. Only the first two cells matter, and a row
/// whose first cell is not a backticked identifier is a header or a separator.
fn tuning_table(doc: &str) -> Option<Vec<(String, String)>> {
    let start = doc.find("\n## Tuning")?;
    let rest = &doc[start + 1..];
    // Stop at the next heading of the same level, so a var named in a later section is not swept in.
    let end = rest[1..]
        .find("\n## ")
        .map_or(rest.len(), |offset| offset + 1);
    let section = &rest[..end];

    let mut rows = Vec::new();
    for line in section.lines().filter(|line| line.starts_with('|')) {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        // `["", first, second, ...]` — a leading empty cell from the opening pipe.
        let (Some(first), Some(second)) = (cells.get(1), cells.get(2)) else {
            continue;
        };
        if let (Some(var), Some(default)) = (backticked(first), backticked(second)) {
            rows.push((var, default));
        }
    }
    Some(rows)
}

/// The contents of a cell that is exactly one backticked span, or `None`.
fn backticked(cell: &str) -> Option<String> {
    let inner = cell.strip_prefix('`')?.strip_suffix('`')?;
    if inner.is_empty() || inner.contains('`') {
        return None;
    }
    Some(inner.to_owned())
}

/// A var's value in `wrangler.jsonc`'s **first** `"vars"` block, rendered the way the table writes it.
///
/// Hand-parsed rather than deserialized because the file is JSONC — comments and trailing commas — and
/// pulling in a JSONC parser for one lookup is a dependency this crate does not otherwise need.
fn top_level_var(wrangler: &str, var: &str) -> Option<String> {
    let vars_at = wrangler.find("\"vars\"")?;
    let open = wrangler[vars_at..].find('{')? + vars_at;

    let mut depth = 0usize;
    let mut close = None;
    for (offset, character) in wrangler[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let block = &wrangler[open..close?];

    let needle = format!("\"{var}\"");
    for line in block.lines() {
        // Strip a trailing `// comment` so a value is not confused with prose about it.
        let code = line.split("//").next().unwrap_or(line);
        let Some(rest) = code.split_once(&needle).map(|(_, rest)| rest) else {
            continue;
        };
        // Quotes are kept, so the table shows the JSON literal: `14400` is a number and `"3.0.0"` is a
        // string, and a reader copying a value into `wrangler.jsonc` needs to know which.
        let value = rest
            .trim_start()
            .strip_prefix(':')?
            .trim()
            .trim_end_matches(',')
            .trim();
        return Some(value.to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    /// The tuning-table parsers, on input this crate does not have to read off disk.
    ///
    /// Worth unit-testing rather than trusting the one real file: the parsers decide whether the check
    /// *runs*, and a parser that silently returns nothing is a check that silently passes — which is the
    /// failure mode `check_self_hosting_vars` exists to prevent in the first place.
    mod tuning {
        use super::super::{backticked, top_level_var, tuning_table};

        // A raw multi-line string, not a `\\`-continued one: `cargo fmt` collapses continuations onto a
        // single line and keeps their indentation, which left every table row starting with spaces
        // instead of a pipe. The parser was right and the fixture was wrong.
        const DOC: &str = r#"# Self-hosting

## Tuning

| Var | Public default | Notes |
| --- | --- | --- |
| `LEASE_TTL_SECONDS` | `14400` | four hours |
| `MIN_CLIENT_VERSION` | `"3.0.0"` | a string |

## Operating it

| `NOT_A_VAR` | `1` | in a later section |
"#;

        #[test]
        fn reads_the_var_and_its_documented_default() {
            let rows = tuning_table(DOC).expect("section found");
            assert_eq!(
                rows,
                vec![
                    ("LEASE_TTL_SECONDS".to_owned(), "14400".to_owned()),
                    ("MIN_CLIENT_VERSION".to_owned(), "\"3.0.0\"".to_owned()),
                ]
            );
        }

        #[test]
        fn stops_at_the_next_heading() {
            // A table in a later section is a different claim about a different thing. Sweeping it in
            // would make the check fail on rows it was never meant to police.
            let rows = tuning_table(DOC).expect("section found");
            assert!(!rows.iter().any(|(var, _)| var == "NOT_A_VAR"));
        }

        #[test]
        fn reports_a_missing_section_rather_than_an_empty_table() {
            assert!(tuning_table("# Self-hosting\n\n## Configuration\n").is_none());
        }

        #[test]
        fn ignores_a_header_row() {
            // `| Var | Public default |` has no backticks, so it is not a var row.
            assert_eq!(backticked("Var"), None);
            assert_eq!(
                backticked("`LEASE_TTL_SECONDS`"),
                Some("LEASE_TTL_SECONDS".to_owned())
            );
            assert_eq!(backticked("`a` and `b`"), None);
        }

        #[test]
        fn keeps_the_json_literal_so_a_string_is_distinguishable_from_a_number() {
            let wrangler = "{\n  \"vars\": {\n    \"A\": 14400,\n    \"B\": \"3.0.0\"\n  }\n}";
            assert_eq!(top_level_var(wrangler, "A"), Some("14400".to_owned()));
            assert_eq!(top_level_var(wrangler, "B"), Some("\"3.0.0\"".to_owned()));
            assert_eq!(top_level_var(wrangler, "MISSING"), None);
        }

        #[test]
        fn reads_only_the_first_vars_block() {
            // `wrangler.jsonc` has an `env.staging` block with its own `vars`, overriding some of them.
            // The documented default is what a fresh deployment gets, which is the top level.
            let wrangler = "{\n  \"vars\": { \"A\": 1 },\n  \"env\": { \"staging\": { \"vars\": { \"A\": 2 } } }\n}";
            assert_eq!(top_level_var(wrangler, "A"), Some("1".to_owned()));
        }

        #[test]
        fn ignores_a_trailing_comment() {
            let wrangler = "{\n  \"vars\": {\n    \"A\": 20, // starting difficulty\n  }\n}";
            assert_eq!(top_level_var(wrangler, "A"), Some("20".to_owned()));
        }
    }

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

    /// The line caps are enforced, in both directions.
    ///
    /// Written after finding three files over the limit — two of them long-standing — because a cap
    /// stated as hard and measured by nobody is the shape every entry in `docs/ROADMAP.md`'s defect
    /// list shares.
    #[test]
    fn the_line_caps_are_measured_not_assumed() {
        let root = std::env::temp_dir().join("nport-verify-docs-line-caps");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("apps/wordy")).expect("mkdir");
        std::fs::create_dir_all(root.join("apps/terse")).expect("mkdir");

        // Root is allowed more than a nested one, so a file that is fine at the root is not fine
        // below it — the assertion that the two caps are actually different.
        let hundred = "x
"
        .repeat(100);
        std::fs::write(root.join("CLAUDE.md"), &hundred).expect("write");
        std::fs::write(root.join("apps/wordy/CLAUDE.md"), &hundred).expect("write");
        std::fs::write(
            root.join("apps/terse/CLAUDE.md"),
            "x
",
        )
        .expect("write");

        let problems = check_line_caps(&root).expect("check");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("apps/wordy/CLAUDE.md"), "{problems:?}");
        assert!(problems[0].contains("100 lines"), "{problems:?}");
    }

    /// And the repository itself is inside them.
    #[test]
    fn the_repositorys_claude_files_are_inside_their_caps() {
        let repo = crate::codegen::repo_root().expect("repo root");
        assert_eq!(check_line_caps(&repo).expect("check"), Vec::<String>::new());
    }

    /// Layout checking reaches every `CLAUDE.md`, not a list of them.
    ///
    /// Defect 22 was this list omitting two files, with eleven dead paths rotted in behind the gap.
    /// Asserting discovery rather than the const is what stops a third app being added and silently
    /// going unchecked — so this drives `layout_docs` against a tree whose files are named nothing
    /// like the old seven entries.
    #[test]
    fn layout_checking_covers_every_claude_md() {
        let root = std::env::temp_dir().join("nport-verify-docs-layout-discovery");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("apps/brand-new")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules/dep")).expect("mkdir");
        std::fs::write(root.join("CLAUDE.md"), "root").expect("write");
        std::fs::write(root.join("apps/brand-new/CLAUDE.md"), "app").expect("write");
        std::fs::write(root.join("node_modules/dep/CLAUDE.md"), "dep").expect("write");

        let docs = layout_docs(&root).expect("discover");
        let _ = std::fs::remove_dir_all(&root);

        assert!(docs.contains(&"CLAUDE.md".to_owned()), "{docs:?}");
        assert!(
            docs.contains(&"apps/brand-new/CLAUDE.md".to_owned()),
            "a new app's guide must be checked without anyone editing this file: {docs:?}"
        );
        assert!(
            !docs.iter().any(|doc| doc.contains("node_modules")),
            "{docs:?}"
        );
    }

    /// The repository's own set, so the discovery cannot quietly find nothing.
    #[test]
    fn the_repositorys_layout_docs_include_every_app() {
        let repo = crate::codegen::repo_root().expect("repo root");
        let docs = layout_docs(&repo).expect("discover");

        for expected in [
            "CLAUDE.md",
            "crates/CLAUDE.md",
            "apps/node/CLAUDE.md",
            "apps/registry/CLAUDE.md",
            "docs/ARCHITECTURE.md",
        ] {
            assert!(
                docs.contains(&expected.to_owned()),
                "{expected} missing: {docs:?}"
            );
        }
    }

    /// Both directions of the decision-index check, against a tree built for it.
    ///
    /// Driving the real function rather than `number`, for the reason the link-coverage test above
    /// gives: a helper that parses correctly proves nothing about whether anything calls it.
    #[test]
    fn the_decision_index_check_catches_a_gap_in_either_direction() {
        let root = std::env::temp_dir().join("nport-verify-docs-decision-index");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("docs")).expect("mkdir");
        std::fs::write(
            root.join("docs/DECISIONS.md"),
            "| # | Decision | Status |\n\
             | --- | --- | --- |\n\
             | 0001 | Listed and written | Accepted |\n\
             | 0003 | Listed but never written | Accepted |\n\
             \n\
             ## ADR-0001 — Listed and written\n\
             \n\
             ## ADR-0002 — Written but never listed\n",
        )
        .expect("write");

        let problems = check_decision_index(&root).expect("check");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(
            problems.iter().any(|p| p.contains("ADR-0002")),
            "an unlisted ADR should be reported: {problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("0003")),
            "an index row with no ADR should be reported: {problems:?}"
        );
        assert!(
            !problems.iter().any(|p| p.contains("0001")),
            "the one correct entry should be silent: {problems:?}"
        );
    }

    /// The real `docs/DECISIONS.md` agrees with its own index.
    ///
    /// The check above proves the function works; this proves the repository passes it, which is the
    /// assertion that would have failed for ADRs 0038–0044.
    #[test]
    fn the_repositorys_own_decision_index_is_complete() {
        let repo = crate::codegen::repo_root().expect("repo root");
        assert_eq!(
            check_decision_index(&repo).expect("check"),
            Vec::<String>::new()
        );
    }
}
