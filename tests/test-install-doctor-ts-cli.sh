#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-install-doctor.XXXXXX")"
binary="$root/.build/megabrain"
modules=(orchestration orchestration-hooks worktree simulator-web simulator-native simulator-tv tv-adb tmux-runtime skill-sync)
trap 'rm -rf "$work"' EXIT

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

mkdir -p "$work/home" "$work/shell-state" "$work/binary-state"
export HOME="$work/home" MEGABRAIN_ROOT="$root"
source "$root/tests/fixtures/entrypoint-routing.sh"
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
cat >"$work/bin/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/bin/npm"
cat >"$work/bin/adb" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = version ]; then
  printf '%s\n' 'Android Debug Bridge version 1.0.41'
  exit 0
fi
exit 1
EOF
chmod +x "$work/bin/adb"
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

# The operator-facing shell entrypoint must route these verbs to the compiled
# implementation. A failing binary makes an accidental shell fallback visible.
routing_fixture="$work/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 42
run_capture "$work/routed-doctor" env MEGABRAIN_STATE_DIR="$work/routed-state" "$routing_fixture/.build/megabrain" doctor orchestration
[ "$(cat "$work/routed-doctor.status")" -eq 42 ] || fail 'operator doctor was not served by the binary'

# Keep the absent-environment contract: inspection branches must report their own content when every source is absent.
empty_home="$work/empty-home"
empty_state_shell="$work/empty-state-shell"
empty_state_binary="$work/empty-state-binary"
mkdir -p "$empty_home" "$empty_state_shell" "$empty_state_binary"
export HOME="$empty_home" MEGABRAIN_STATE_DIR="$empty_state_shell" EMPTY_DOCTOR_FIXTURE=true
for module in orchestration-hooks worktree tmux-runtime; do
  export MEGABRAIN_STATE_DIR="$empty_state_binary"
  run_capture "$work/empty-binary-$module" "$binary" doctor "$module" --json
  jq -e --arg moduleName "$module" '.module == $moduleName and (.reason | type) == "string"' \
    "$work/empty-binary-$module.stdout" >/dev/null || fail "empty environment $module report was incomplete"
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

# Populate the two registered skill copies consumed by the shell inspection. The
# TypeScript implementation must read the same targets, rather than reporting the
# absence of copies from an empty fixture.
for skill_target in \
  "$work/home/.claude/plugins/cache/megabrain-local/megabrain/fixture/skills/megabrain/SKILL.md" \
  "$work/home/.codex/plugins/cache/megabrain-local/megabrain/fixture/skills/megabrain/SKILL.md"; do
  mkdir -p "$(dirname "$skill_target")"
  cp "$root/skills/megabrain/SKILL.md" "$skill_target"
done

# The fixture exposes both live-state failures to the compiled doctor contract.
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

# WHY: MEGABRAIN_INSTALL_IMPLEMENTATION never gated command_install (no such override existed in
# lib/module-install.sh), and now there is no shell install body left to compare against at all —
# command_install is an unconditional passthrough to the binary, the same shape as command_native
# and command_web. So this now proves routing fidelity instead of shell/binary parity: the
# operator-facing wrapper ($root/.build/megabrain) must answer identically to the binary it forwards to.
routed_unknown="$work/routed-unknown"
run_capture "$routed_unknown" "$root/.build/megabrain" install unknown-module

binary_unknown="$work/binary-unknown"
run_capture "$binary_unknown" "$binary" install unknown-module
for side in stdout stderr status; do
  cmp -s "$routed_unknown.$side" "$binary_unknown.$side" || fail "install unknown-module $side differs between the wrapper and the binary"
done
[ "$(cat "$binary_unknown.status")" -eq 2 ] || fail 'unknown module status was not 2'
grep -q 'unknown module: unknown-module' "$binary_unknown.stderr" || fail 'unknown module omitted its error'

# WHY: GitHub issue 43 ("executeInstall reports status and never installs") is fixed — install
# now performs a real install, module by module (src/cli/commands/install-doctor.ts's
# executeInstall). An unhealthy hooks fixture must be backed up and repaired by an --yes install,
# proven end to end through the operator-facing wrapper.
install_contract_home="$work/install-contract-home"
mkdir -p "$install_contract_home/.claude"
printf '%s\n' '{"hooks":{"Stop":[]}}' >"$install_contract_home/.claude/settings.json"
cp "$install_contract_home/.claude/settings.json" "$work/install-contract-original.json"
export HOME="$install_contract_home"
run_capture "$work/install-contract" "$root/.build/megabrain" install orchestration-hooks --yes
[ "$(cat "$work/install-contract.status")" -eq 0 ] || fail "install orchestration-hooks --yes did not exit 0: $(cat "$work/install-contract.stdout") $(cat "$work/install-contract.stderr")"
assert_backup_matches() {
  local path="$1" original="$2" backup
  backup="$(find "$(dirname "$path")" -maxdepth 1 -name "$(basename "$path").megabrain-backup-*" -type f -print -quit)"
  [ -n "$backup" ] || fail "expected backup for $path"
  cmp -s "$original" "$backup" || fail "backup for $path differs from original"
}
assert_backup_matches "$install_contract_home/.claude/settings.json" "$work/install-contract-original.json"
grep -q "MEGABRAIN_HOOK_AGENT=claude '$root/.build/megabrain' hook turn-end" "$install_contract_home/.claude/settings.json" \
  || fail 'install did not write the direct binary hook command'
printf 'install contract: a real install backs up and repairs the operator config (issue 43)\n'
export HOME="$work/home"

# A minimal installation record is input to the compiled doctor, which must report content
# without changing the state of record.
read_only_state="$work/read-only-state"
mkdir -p "$read_only_state"
printf '%s\n' '{"orchestration":{"installed":true}}' >"$read_only_state/state.json"
read_only_before="$work/read-only-before.json"
cp "$read_only_state/state.json" "$read_only_before"
export MEGABRAIN_STATE_DIR="$read_only_state"
run_capture "$work/read-only-run" "$binary" doctor orchestration --json
cmp -s "$read_only_before" "$read_only_state/state.json" || fail 'doctor changed the installation state'
jq -e '.module == "orchestration" and (.status | type) == "string" and (.reason | type) == "string"' \
  "$work/read-only-run.stdout" >/dev/null || fail 'doctor did not report module content'
if grep -F 'state reconciled' "$work/read-only-run.stdout" >/dev/null; then
  fail 'doctor still reported a state reconciliation'
fi
printf 'doctor contract: compiled report preserves the state of record\n'

# Establish a state record once, then exercise every module through the compiled doctor.
export MEGABRAIN_STATE_DIR="$work/shell-state"
for module in "${modules[@]}"; do
  run_capture "$work/seed-$module" "$binary" doctor "$module" --json
done

for module in "${modules[@]}"; do
  export MEGABRAIN_STATE_DIR="$work/shell-state"
  run_capture "$work/binary-$module" "$binary" doctor "$module" --json
  jq -e --arg moduleName "$module" '.module == $moduleName and (.status | type) == "string" and (.reason | type) == "string"' \
    "$work/binary-$module.stdout" >/dev/null || fail "compiled doctor report was incomplete for $module"
  if [ "$module" = skill-sync ]; then
    jq -e '.status == "ok" and .reason == "skill copies current: 2"' "$work/binary-$module.stdout" >/dev/null || fail 'compiled skill-sync fixture did not report two current copies'
  fi
  printf 'module=%s binary=%s\n' "$module" "$(jq -r '.status' "$work/binary-$module.stdout")"
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

printf 'install remains shell-owned; compiled doctor reports all nine modules\n'
