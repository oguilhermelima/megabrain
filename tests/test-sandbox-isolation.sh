#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-sandbox.XXXXXX")"

cleanup() {
  rm -rf "$sandbox"
  return 0
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# WHY: two variables are what it takes to run megabrain without touching anything the
# operator owns, and getting one of them wrong is silent. HOME covers the agent configs,
# the shell files and the install manifest; MEGABRAIN_STATE_DIR covers dispatches, chains
# and module state.
mkdir -p "$sandbox/home" "$sandbox/state"
run_sandboxed() {
  env HOME="$sandbox/home" \
    MEGABRAIN_STATE_DIR="$sandbox/state" \
    "$root/.build/megabrain" "$@"
}

# Everything outside the sandbox that megabrain is known to write to. A command that
# escapes shows up as a changed digest, whatever the mechanism was.
outside_paths=(
  "$root/.megabrain/models.json"
  "$HOME/.megabrain"
  "$HOME/.megabrain-local"
  "$HOME/.claude/settings.json"
  "$HOME/.codex/hooks.json"
  "$HOME/.agy/hooks.json"
  "$HOME/.cursor/hooks.json"
  "$HOME/.tmux.conf"
  "$HOME/.zshrc"
)

digest_outside() {
  local path
  for path in "${outside_paths[@]}"; do
    if [ -d "$path" ]; then
      printf '%s dir %s\n' "$path" "$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')"
    elif [ -f "$path" ]; then
      # Modification time as well as content: rewriting a config with the same bytes is
      # still an escape, and a digest alone cannot see an idempotent write.
      printf '%s file %s %s\n' "$path" \
        "$(shasum "$path" 2>/dev/null | awk '{print $1}')" \
        "$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || printf '?')"
    else
      printf '%s absent\n' "$path"
    fi
  done
}

before="$(digest_outside)"

# Reads first, then the writes that actually create state. model add is here by name
# because it escaped a hand-written sandbox today.
run_sandboxed context --json >/dev/null 2>&1 || true
run_sandboxed orchestrate list --json >/dev/null 2>&1 || true
run_sandboxed orchestrate prune --dry-run --json >/dev/null 2>&1 || true
run_sandboxed chain list --json >/dev/null 2>&1 || true
run_sandboxed model list --json >/dev/null 2>&1 || true
run_sandboxed model add codex sandbox-model --reasoning low >/dev/null 2>&1 || true
# WHY this one specifically: nothing above writes under HOME, so without it the test
# passed just as well with HOME left pointing at the operator's own directory, and the
# name of this file claimed an isolation it never exercised. Installing the hook module
# writes the agent config files and touches nothing but files.
run_sandboxed install orchestration-hooks --yes >/dev/null 2>&1 || true

after="$(digest_outside)"

if [ "$before" != "$after" ]; then
  printf 'FAIL: a sandboxed run changed something outside the sandbox\n' >&2
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 1
fi
printf 'a sandboxed run leaves every operator-owned path untouched\n'

# The other half: the writes have to have landed somewhere, or this test would pass just
# as well against a megabrain that does nothing at all.
[ -f "$sandbox/state/models.json" ] || fail 'the sandboxed model registry was not written inside the sandbox'
grep -q sandbox-model "$sandbox/state/models.json" || fail 'the sandboxed model registry has no requested model'
printf 'and the writes it was asked for landed inside it\n'

printf 'ok: HOME and MEGABRAIN_STATE_DIR isolate a run completely\n'
