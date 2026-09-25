#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-skill-sync.XXXXXX")"
cleanup() {
  local rc=$?
  chmod -R u+rwX "$work" 2>/dev/null || true
  rm -rf "$work"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

# WHY: skill reconcile now lives in the compiled binary (src/core/skill.ts, unit-tested in
# tests/unit/skill.test.ts); this file drives the megabrain entry script as a black box to
# prove the runtime hygiene contract survives the move, not the shell functions that used to
# implement it.
[ -x "$binary" ] || { printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"; exit 0; }

export HOME="$work/home"
export MEGABRAIN_STATE_DIR="$work/state"
export MEGABRAIN_ROOT="$root"
mkdir -p "$HOME/.claude/plugins/cache/megabrain-local/megabrain/0.1.0/skills/megabrain"

source_skill="$root/skills/megabrain/SKILL.md"
cached_skill="$HOME/.claude/plugins/cache/megabrain-local/megabrain/0.1.0/skills/megabrain/SKILL.md"
cp "$source_skill" "$cached_skill"
printf '\nold cached content\n' >>"$cached_skill"

"$root/.build/megabrain" context --json >"$work/context1.out" 2>"$work/context1.err"
cmp -s "$source_skill" "$cached_skill" || fail 'an unrelated command did not repair skill drift at startup'
jq -e '.host != null' "$work/context1.out" >/dev/null || fail 'the reconciled command did not return its normal output'
printf 'scenario 1: an unrelated command repairs skill drift at startup\n'

"$root/.build/megabrain" context --json >"$work/context2.out" 2>"$work/context2.err"
cmp -s "$source_skill" "$cached_skill" || fail 'a current skill target was unexpectedly modified'
[ ! -s "$work/context2.err" ] || fail 'a current skill target produced unexpected diagnostics'
printf 'scenario 2: a current skill target is a no-op\n'

printf '\nnew cached content\n' >>"$cached_skill"
chmod 0555 "$(dirname "$cached_skill")"
"$root/.build/megabrain" context --json >"$work/context3.out" 2>"$work/context3.err"
jq -e '.host != null' "$work/context3.out" >/dev/null || fail 'an unrelated command failed because of an unwritable skill target'
assert_contains "$(cat "$work/context3.err")" 'skill target is not writable'
chmod 0755 "$(dirname "$cached_skill")"
printf 'scenario 3: an unwritable target reports clearly and never fails an unrelated command\n'

printf '\nuncorrected drift\n' >>"$cached_skill"
doctor_json="$("$root/.build/megabrain" doctor skill-sync --json 2>/dev/null)" || true
printf '%s' "$doctor_json" | jq -e '.module == "skill-sync" and .status == "misconfigured" and (.reason | contains("skill drift"))' >/dev/null ||
  fail "doctor did not report skill drift as its own condition: $doctor_json"
cmp -s "$source_skill" "$cached_skill" && fail 'doctor silently repaired drift before reporting it'
printf 'scenario 4: doctor reports skill drift independently and never repairs it\n'

printf 'ok: skill synchronization scenarios\n'
