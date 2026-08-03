# nport (CLI)

The `nport` binary. Argument parsing, terminal rendering, config file, i18n, and signal handling — a thin, human-facing shell around `crates/core`.

**Not implemented.** Phase 2b in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).

Conventions and the CLI-specific rules are in [`crates/CLAUDE.md`](../CLAUDE.md). The rules there matter: several of them exist because the v2 CLI got the basics wrong — no `--help`, no `-p/--port`, and a first-run prompt that hung CI.

This is the only crate allowed to format text for humans.
