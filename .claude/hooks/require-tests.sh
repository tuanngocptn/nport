#!/usr/bin/env bash
# Stop hook: refuse to end a turn that changed source without touching tests.
#
# Policy and rationale: .claude/skills/testing-policy/SKILL.md and docs/TESTING.md.
#
# Granularity is deliberately per-area (one crate, one package), not per-file. Requiring
# a test edit for every individual file produces constant false positives on module
# declarations and re-exports, and a hook people learn to ignore is worse than no hook.
#
# Blocks at most once per unique set of untested areas per session, so a change that
# genuinely needs no test costs one message rather than an unbreakable loop.

set -uo pipefail

payload=$(cat 2>/dev/null || echo '{}')
session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null || echo unknown)

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" 2>/dev/null || exit 0

changed=$(git status --porcelain --untracked-files=all 2>/dev/null | sed -e 's/^...//' -e 's/^.* -> //')
[ -z "$changed" ] && exit 0

# Paths that never require a test of their own.
never_needs_test() {
  case "$1" in
    *.md | *.json | *.jsonc | *.toml | *.yml | *.yaml | *.css | *.pem | *.capnp | *.lock) return 0 ;;
    */generated/* | schema/*.json | *worker-configuration.d.ts) return 0 ;;
    */build.rs | */examples/* | .claude/*) return 0 ;;
    # Generated from packages/contract; hand-written tests do not belong here.
    crates/contract/*) return 0 ;;
    # Repo automation, not shipped behaviour.
    crates/xtask/*) return 0 ;;
    packages/design-tokens/* | packages/tsconfig/*) return 0 ;;
  esac
  return 1
}

# Which area a path belongs to, or empty if it is not source we track.
area_of() {
  case "$1" in
    apps/desktop/src-tauri/src/*.rs | apps/desktop/src-tauri/src/*/*.rs) echo "apps/desktop/src-tauri" ;;
    crates/*/src/*) echo "$1" | cut -d/ -f1-2 ;;
    apps/node/src/*) echo "apps/node" ;;
    apps/web/src/*) echo "apps/web" ;;
    apps/desktop/src/*) echo "apps/desktop" ;;
    packages/*/src/*) echo "$1" | cut -d/ -f1-2 ;;
    *) echo "" ;;
  esac
}

# Does this changed path count as a test for its area?
is_test_artifact() {
  case "$1" in
    */tests/* | */test/* | */e2e/*) return 0 ;;
    *.test.ts | *.test.tsx | *.spec.ts | *.spec.tsx) return 0 ;;
    *-snapshots/* | *.snap) return 0 ;;
  esac
  # A Rust source file carrying inline tests is itself the test artifact.
  case "$1" in
    *.rs) [ -f "$1" ] && grep -q '#\[cfg(test)\]' "$1" 2>/dev/null && return 0 ;;
  esac
  return 1
}

source_areas=""
tested_areas=""

while IFS= read -r path; do
  [ -z "$path" ] && continue
  never_needs_test "$path" && continue

  area=$(area_of "$path")
  [ -z "$area" ] && continue

  if is_test_artifact "$path"; then
    tested_areas="$tested_areas $area"
  else
    source_areas="$source_areas $area"
  fi
done <<EOF
$changed
EOF

# An area under crates/<c>/tests/ or apps/<a>/{test,e2e}/ maps to the same area name.
while IFS= read -r path; do
  case "$path" in
    crates/*/tests/*) tested_areas="$tested_areas $(echo "$path" | cut -d/ -f1-2)" ;;
    apps/node/test/*) tested_areas="$tested_areas apps/node" ;;
    apps/web/e2e/* | apps/web/test/*) tested_areas="$tested_areas apps/web" ;;
    apps/desktop/e2e/* | apps/desktop/test/*) tested_areas="$tested_areas apps/desktop" ;;
    apps/desktop/src-tauri/tests/*) tested_areas="$tested_areas apps/desktop/src-tauri" ;;
    packages/*/test/*) tested_areas="$tested_areas $(echo "$path" | cut -d/ -f1-2)" ;;
  esac
done <<EOF
$changed
EOF

untested=""
for area in $(printf '%s\n' $source_areas | sort -u); do
  case " $(printf '%s\n' $tested_areas | sort -u | tr '\n' ' ') " in
    *" $area "*) ;;
    *) untested="$untested $area" ;;
  esac
done

untested=$(printf '%s\n' $untested | sort -u | tr '\n' ' ' | sed 's/  */ /g;s/^ //;s/ $//')
[ -z "$untested" ] && exit 0

# Block once per unique violation set, per session.
marker="${TMPDIR:-/tmp}/claude-require-tests-${session}.seen"
fingerprint=$(printf '%s' "$untested" | shasum -a 256 | cut -d' ' -f1)
if [ -f "$marker" ] && grep -qx "$fingerprint" "$marker" 2>/dev/null; then
  exit 0
fi
printf '%s\n' "$fingerprint" >>"$marker" 2>/dev/null || true

expectation() {
  case "$1" in
    apps/node) echo "Vitest with @cloudflare/vitest-pool-workers in apps/node/test/ — Durable Object storage and alarms must run in real workerd, not a mock" ;;
    apps/web) echo "Playwright in apps/web/e2e/ — behavioural assertions plus a visual snapshot (ADR-0023)" ;;
    apps/desktop) echo "a test under apps/desktop/e2e/" ;;
    apps/desktop/src-tauri) echo "inline #[cfg(test)] tests, or apps/desktop/src-tauri/tests/" ;;
    crates/protocol) echo "inline #[cfg(test)] tests plus, for any wire-format change, an insta snapshot and a golden fixture captured from cloudflared" ;;
    crates/*) echo "inline #[cfg(test)] tests, or a test under $1/tests/" ;;
    packages/*) echo "a colocated *.test.ts" ;;
    *) echo "a test covering the change" ;;
  esac
}

detail=""
for area in $untested; do
  detail="${detail}
  - ${area}: $(expectation "$area")"
done

reason="Source changed in these areas with no corresponding test change:${detail}

Delegate to the test-writer subagent (pinned to Sonnet by project policy) with the
specific files and behaviour to cover, or state explicitly why this change needs no
test — a vendored file, a pure rename, or something docs/TESTING.md lists as
deliberately untested. See .claude/skills/testing-policy/SKILL.md."

jq -n --arg reason "$reason" --arg areas "$untested" \
  '{decision: "block", reason: $reason, systemMessage: ("Untested source changes in:" + $areas)}'
