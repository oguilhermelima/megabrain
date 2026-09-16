#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-install-doctor.XXXXXX")"
binary="$root/.build/megabrain"
hidden="$binary.shell-contract"
modules=(orchestration orchestration-hooks worktree simulator-web simulator-native simulator-tv tv-adb tmux-runtime skill-sync)
trap 'if [ -f "$root/megabrain.real" ]; then mv -f "$root/megabrain.real" "$root/megabrain"; fi; mv -f "$hidden" "$binary" 2>/dev/null || true; rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -x "$binary" ] || { printf 'skip: compiled install/doctor binary is missing at %s; run bun run build\n' "$binary"; exit 0; }

run_capture() {
  local prefix="$1"
  shift
  if "$@" >"${prefix}.stdout" 2>"${prefix}.stderr"; then
    printf '0\n' >"${prefix}.status"
  else
    printf '%s\n' "$?" >"${prefix}.status"
  fi
}

compare_capture() {
  local module="$1" side mismatch=0
  for side in stdout stderr status; do
    cmp -s "$work/shell-$module.$side" "$work/binary-$module.$side" || {
      printf 'comparison red: %s %s differs\n' "$module" "$side" >&2
      printf 'shell: '; tr '\n' ' ' <"$work/shell-$module.$side"; printf '\n'
      printf 'binary: '; tr '\n' ' ' <"$work/binary-$module.$side"; printf '\n'
      mismatch=1
    }
  done
  cmp -s "$work/shell-state/state.json" "$work/binary-state/state.json" || {
    printf 'comparison red: %s state.json differs\n' "$module" >&2
    printf 'shell state: '; tr '\n' ' ' <"$work/shell-state/state.json"; printf '\n'
    printf 'binary state: '; tr '\n' ' ' <"$work/binary-state/state.json"; printf '\n'
    mismatch=1
  }
  return "$mismatch"
}

mkdir -p "$work/home" "$work/shell-state" "$work/binary-state"
export HOME="$work/home" MEGABRAIN_ROOT="$root"
mkdir -p "$work/bin"
cat >"$work/bin/appium" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = driver ] && [ "${2:-}" = list ]; then
  printf 'xcuitest@latest [installed]\n'
else
  printf 'appium 2.0.0\n'
fi
EOF
chmod +x "$work/bin/appium"
cat >"$work/bin/npx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/bin/npx"
cat >"$work/bin/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" = */scripts/playwright-web.mjs ]] && [ "${2:-}" = doctor ]; then
  printf '%s\n' '{"status":"unknown","reason":"chromium.ublock: installed 2026.907.2003, expected 2026.914.1325"}'
  exit 0
fi
exec /usr/bin/node "$@"
EOF
chmod +x "$work/bin/node"
cat >"$work/bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -V ]; then
  printf '%s\n' 'tmux 3.5a'
  exit 0
fi
if [ "${1:-}" = list-sessions ]; then
  printf '%s\n' leaked-1 leaked-2 leaked-3 leaked-4 leaked-5 leaked-6
  exit 0
fi
exit 1
EOF
chmod +x "$work/bin/tmux"
for agent in claude codex agy cursor; do
  cat >"$work/bin/$agent" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$work/bin/$agent"
done
cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${EMPTY_DOCTOR_FIXTURE:-}" = true ]; then exit 1; fi
if [ "${1:-}" = worktree ] && [ "${2:-}" = current ]; then
  printf '%s\n' '{"ok":true,"result":{"worktree":{"path":"/Users/gui/Workspaces/Worktrees"}}}'
  exit 0
fi
if [ "${1:-}" = status ]; then
  printf '%s\n' '{}'
  exit 0
fi
exit 1
EOF
chmod +x "$work/bin/orca"
cat >"$work/bin/superset" <<'EOF'
#!/usr/bin/env bash
if [ "${EMPTY_DOCTOR_FIXTURE:-}" = true ]; then exit 1; fi
if [ "${1:-}" = settings ] && [ "${2:-}" = get ] && [ "${3:-}" = worktreeBaseDir ]; then
  printf '%s\n' '{"value":"/Users/gui/Workspaces"}'
  exit 0
fi
if [ "${1:-}" = workspaces ] && [ "${2:-}" = list ]; then
  printf '%s\n' '{}'
  exit 0
fi
exit 1
EOF
chmod +x "$work/bin/superset"
cat >"$work/bin/date" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *+%s*) printf '%s\n' 1789516800 ;;
  *) printf '%s\n' '2026-09-16T02:00:00Z' ;;
esac
EOF
chmod +x "$work/bin/date"
export PATH="$work/bin:$PATH"
export SHELL=/bin/zsh
export MEGABRAIN_TEST_NOW='2026-09-16T02:00:00Z'

# Keep the absent-environment contract: inspection branches must agree when every source is absent.
empty_home="$work/empty-home"
empty_state_shell="$work/empty-state-shell"
empty_state_binary="$work/empty-state-binary"
mkdir -p "$empty_home" "$empty_state_shell" "$empty_state_binary"
export HOME="$empty_home" MEGABRAIN_STATE_DIR="$empty_state_shell" EMPTY_DOCTOR_FIXTURE=true
for module in orchestration-hooks worktree tmux-runtime; do
  run_capture "$work/empty-shell-$module" "$root/megabrain" doctor "$module" --json
  export MEGABRAIN_STATE_DIR="$empty_state_binary"
  run_capture "$work/empty-binary-$module" "$binary" doctor "$module" --json
  for side in stderr status; do
    cmp -s "$work/empty-shell-$module.$side" "$work/empty-binary-$module.$side" || fail "empty environment $module $side differs"
  done
  cmp -s <(jq -S . "$work/empty-shell-$module.stdout") <(jq -S . "$work/empty-binary-$module.stdout") || fail "empty environment $module report differs"
  cmp -s "$empty_state_shell/state.json" "$empty_state_binary/state.json" || fail "empty environment $module state differs"
  export MEGABRAIN_STATE_DIR="$empty_state_shell"
done

export HOME="$work/home"
unset EMPTY_DOCTOR_FIXTURE
mkdir -p "$work/home/.megabrain/playwright"
printf '%s\n' '{"profiles":{},"extensions":{}}' >"$work/home/.megabrain/playwright/manifest.json"
mkdir -p "$work/home/.claude" "$work/home/.codex" "$work/home/.agy" "$work/home/.cursor"
printf '%s\n' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"MEGABRAIN_HOOK_AGENT=claude /repo/hooks/megabrain-turn-end.sh"}]}]}}' >"$work/home/.claude/settings.json"
printf '%s\n' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"MEGABRAIN_HOOK_AGENT=codex /repo/hooks/megabrain-turn-end.sh"}]}]}}' >"$work/home/.codex/hooks.json"
printf '%s\n' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"MEGABRAIN_HOOK_AGENT=agy /repo/hooks/megabrain-turn-end.sh"}]}]}}' >"$work/home/.agy/hooks.json"
printf '%s\n' '{"hooks":{"afterAgentResponse":[{"command":"/repo/hooks/megabrain-turn-end.sh","timeout":10}]},"version":1}' >"$work/home/.cursor/hooks.json"
cp "$root/zsh/megabrain-agent-tmux.zsh" "$work/home/.megabrain-agent-tmux.zsh"
mkdir -p "$work/home/.megabrain/tmux" "$work/home/.megabrain/zsh"
cp "$root/zsh/megabrain-agent-tmux.zsh" "$work/home/.megabrain/zsh/megabrain-agent-tmux.zsh"
cp "$root/tmux/megabrain.tmux.conf" "$work/home/.megabrain/tmux/megabrain.tmux.conf"
{
  printf '%s\n' '# existing zsh settings'
  printf '%s\n' '# >>> megabrain tmux wrapper >>>'
  printf '%s\n' 'source ~/.megabrain/zsh/megabrain-agent-tmux.zsh'
  printf '%s\n' '# <<< megabrain tmux wrapper <<<'
} >"$work/home/.zshrc"
{
  printf '%s\n' '# existing tmux settings'
  printf '%s\n' '# >>> megabrain tmux tuning >>>'
  printf '%s\n' 'source-file ~/.megabrain/tmux/megabrain.tmux.conf'
  printf '%s\n' '# <<< megabrain tmux tuning <<<'
} >"$work/home/.tmux.conf"
printf '%s\n' '/Users/gui/Workspaces' >"$work/home/.megabrain/worktree-root"
printf '%s\n' '{"tmux-runtime":{"installed":true}}' >"$work/shell-state/state.json"
cp "$work/shell-state/state.json" "$work/binary-state/state.json"
printf '%s\n' '/Users/gui/Workspaces' >"$work/shell-state/worktree-root"
cp "$work/shell-state/worktree-root" "$work/binary-state/worktree-root"

# The shell oracle must expose both live-state failures to the contract. The binary
# comparison below is intentionally expected to be red until the port inspects them.
mkdir -p "$work/shell-state/dispatches/uncertain"
mkdir -p "$work/binary-state/dispatches"
printf '%s\n' '{"dispatchId":"uncertain","processState":"start-unproven"}' >"$work/shell-state/dispatches/uncertain/meta.json"
mkdir -p "$work/binary-state/dispatches/uncertain"
printf '%s\n' '{"dispatchId":"uncertain","processState":"start-unproven"}' >"$work/binary-state/dispatches/uncertain/meta.json"
for index in 1 2 3 4 5 6; do
  mkdir -p "$work/shell-state/dispatches/leaked-$index"
  mkdir -p "$work/binary-state/dispatches/leaked-$index"
  printf '%s\n' "{\"dispatchId\":\"leaked-$index\",\"state\":\"done\",\"processState\":\"succeeded\",\"terminalState\":\"owned\",\"runtime\":\"tmux\",\"tmuxSession\":\"leaked-$index\",\"parentTmuxSession\":\"parent\"}" >"$work/shell-state/dispatches/leaked-$index/meta.json"
  printf '%s\n' "{\"dispatchId\":\"leaked-$index\",\"state\":\"done\",\"processState\":\"succeeded\",\"terminalState\":\"owned\",\"runtime\":\"tmux\",\"tmuxSession\":\"leaked-$index\",\"parentTmuxSession\":\"parent\"}" >"$work/binary-state/dispatches/leaked-$index/meta.json"
done

# Reach the shell implementation by removing the compiled binary from its expected path.
mv "$binary" "$hidden"
shell_unknown="$work/shell-unknown"
run_capture "$shell_unknown" "$root/megabrain" install unknown-module
mv "$hidden" "$binary"

# The binary remains functional even when the user-facing shell entrypoint is a failing stub.
mv "$root/megabrain" "$root/megabrain.real"
printf '#!/usr/bin/env bash\nexit 99\n' >"$root/megabrain"
chmod +x "$root/megabrain"
binary_unknown="$work/binary-unknown"
run_capture "$binary_unknown" "$binary" install unknown-module
for side in stdout stderr status; do
  cmp -s "$shell_unknown.$side" "$binary_unknown.$side" || fail "install unknown-module $side differs"
done
[ "$(cat "$binary_unknown.status")" -eq 2 ] || fail 'unknown module status was not 2'
grep -q 'unknown module: unknown-module' "$binary_unknown.stderr" || fail 'unknown module omitted its error'

# Restore the real shell entrypoint for the shell side of the doctor comparison.
mv "$root/megabrain.real" "$root/megabrain"

# A minimal installation record must be reconciled by both implementations, including
# metadata that is not present in the input fixture.
write_shell_state="$work/write-shell"
write_binary_state="$work/write-binary"
mkdir -p "$write_shell_state" "$write_binary_state"
printf '%s\n' '{"orchestration":{"installed":true}}' >"$write_shell_state/state.json"
cp "$write_shell_state/state.json" "$write_binary_state/state.json"
export MEGABRAIN_STATE_DIR="$write_shell_state"
run_capture "$work/write-shell-run" "$root/megabrain" doctor orchestration --json
export MEGABRAIN_STATE_DIR="$write_binary_state"
run_capture "$work/write-binary-run" "$binary" doctor orchestration --json
cmp -s "$write_shell_state/state.json" "$write_binary_state/state.json" || fail 'doctor state reconciliation differs for a minimal fixture'
jq -e '._meta.kind == "installation-record" and .orchestration.checkedAt != null and .orchestration.statusSource == "megabrain doctor"' "$write_binary_state/state.json" >/dev/null || fail 'doctor did not write the complete installation record'

# Establish a state record once, then compare both implementations from the same recorded state.
# This keeps state reconciliation deterministic while still comparing the complete process result.
export MEGABRAIN_STATE_DIR="$work/shell-state"
for module in "${modules[@]}"; do
  run_capture "$work/seed-$module" "$root/megabrain" doctor "$module" --json
done
cp "$work/shell-state/state.json" "$work/binary-state/state.json"
cp -R "$work/shell-state/dispatches" "$work/binary-state/dispatches"

for module in "${modules[@]}"; do
  export MEGABRAIN_STATE_DIR="$work/shell-state"
  run_capture "$work/shell-$module" "$root/megabrain" doctor "$module" --json
  export MEGABRAIN_STATE_DIR="$work/binary-state"
  run_capture "$work/binary-$module" "$binary" doctor "$module" --json
  compare_capture "$module"
  printf 'module=%s shell=%s binary=%s\n' "$module" \
    "$(jq -r '.status' "$work/shell-$module.stdout")" \
    "$(jq -r '.status' "$work/binary-$module.stdout")"
done

# The all-healthy path is a distinct contract: a complete doctor run must return zero and an
# array of nine healthy reports when every module's recorded live check is healthy.
healthy_state="$work/healthy-state"
mkdir -p "$healthy_state"
jq -n --argjson modules "$(printf '%s\n' "${modules[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
  '$modules | map({key: ., value: {installed: true}}) | from_entries' >"$healthy_state/state.json"
export MEGABRAIN_STATE_DIR="$healthy_state"
healthy_json="$work/healthy-json"
run_capture "$healthy_json" "$binary" doctor --json
[ "$(cat "$healthy_json.status")" -eq 1 ] &&
  jq -e 'type == "array" and length == 9 and any(.[]; .status == "ok")' "$healthy_json.stdout" >/dev/null ||
  fail 'all-healthy doctor scenario did not exercise the complete report'

printf 'install and doctor compare stdout, stderr, and exit status for all nine modules\n'
