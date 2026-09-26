#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export MEGABRAIN_ROOT="$root"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-real-use.XXXXXX")"
node_bin="$state_dir/node-bin"
mkdir -p "$node_bin"
ln -s "$(command -v node)" "$node_bin/node"

cleanup() {
  local rc=$?
  [ -z "${container_fixture:-}" ] || rm -f "$container_fixture"
  rm -rf "$state_dir"
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
    *) fail "$3" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3" ;;
    *) ;;
  esac
}

# Scenario 1: a module prerequisite failure must reach the command exit status.
install_home="$state_dir/install-home"
install_state="$state_dir/install-state"
mkdir -p "$install_home" "$install_state"
if HOME="$install_home" MEGABRAIN_STATE_DIR="$install_state" PATH=/usr/bin:/bin \
  "$root/.build/megabrain" install tv-adb --yes >"$state_dir/install.out" 2>&1; then
  fail 'a failed tv-adb install exited successfully'
fi
printf 'scenario 1: failed module install is non-zero\n'

# Scenario 2: reported tmux drift must make the doctor non-ok.
# WHY: module_tmux_runtime_doctor is gone (deleted with the rest of the shell install path once
# install routed to the binary); the compiled doctor implements this exact tuning/wrapper drift
# check (src/cli/commands/install-doctor.ts's tmux-runtime branch), so this drives it as a black
# box instead, with a PATH offering only a fake tmux and no tuning/wrapper files installed.
export MEGABRAIN_STATE_DIR="$state_dir/tmux-state"
tmux_drift_home="$state_dir/tmux-drift-home"
tmux_drift_bin="$state_dir/tmux-drift-bin"
mkdir -p "$MEGABRAIN_STATE_DIR" "$tmux_drift_home" "$tmux_drift_bin"
cat >"$tmux_drift_bin/tmux" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -V ] && { printf 'tmux 3.5a\n'; exit 0; }
exit 1
EOF
chmod +x "$tmux_drift_bin/tmux"
printf '%s\n' '{"tmux-runtime":{"installed":true}}' >"$MEGABRAIN_STATE_DIR/state.json"
# WHY: the compiled doctor exits non-zero for a non-ok report (executeDoctor's unhealthy exit
# code), and that is exactly what this scenario expects — under this file's `set -e`, a plain
# `var="$(cmd)"` assignment aborts the whole script the instant `cmd` returns non-zero, silently,
# with no FAIL message. `|| true` keeps the expected non-zero exit from being fatal.
tmux_drift_json="$(PATH="$tmux_drift_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" HOME="$tmux_drift_home" "$root/.build/megabrain" doctor tmux-runtime --json 2>/dev/null || true)"
[ "$(printf '%s' "$tmux_drift_json" | jq -r '.status')" != ok ] || fail 'tmux doctor reported ok while all drift fields were false'
printf 'scenario 2: tmux drift is non-ok\n'

# Scenario 3: agent CLIs must receive the argument separator (defect B from the install lane).
# WHY: megabrain_register_playwright and module_simulator_web_install are gone (module-web.sh
# now only keeps command_web, a binary passthrough); this drives the compiled `install
# simulator-web` as a black box instead, with a fake claude CLI that rejects `-y` unless it
# arrives after `--`, exactly like the real Claude CLI. install-doctor.ts's registerPlaywright
# builds that command with `--` before `npx -y ...`, so this proves the binary carries the fix
# forward end to end, not just at the unit level (see tests/unit/install.test.ts for the
# unit-level proof, including the failure-propagation half of defect B).
scenario3_playwright_root="$state_dir/scenario3-playwright-root"
scenario3_bin="$state_dir/scenario3-bin"
mkdir -p "$scenario3_bin"
scenario3_playwright_script="$state_dir/scenario3-playwright-web.mjs"
cat >"$scenario3_playwright_script" <<'EOF'
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args[rootIndex + 1] : "";
if (args[0] === "install" && root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}/manifest.json`, JSON.stringify({
    activeBrowser: "chromium",
    profiles: { chromium: { configPath: `${root}/chromium.json` } },
  }));
} else if (args[0] === "doctor") {
  process.stdout.write(JSON.stringify({ status: "ok", reason: "browser fixture is ready" }));
} else {
  process.exitCode = 1;
}
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"$scenario3_bin/npm"
chmod +x "$scenario3_bin/npm"
printf '#!/usr/bin/env bash\nexit 0\n' >"$scenario3_bin/npx"
chmod +x "$scenario3_bin/npx"
cat >"$scenario3_bin/claude" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = mcp ] && { [ "${2:-}" = list ] || [ "${2:-}" = remove ]; }; then exit 0; fi
if [ "${1:-}" = mcp ] && [ "${2:-}" = add ]; then
  has_separator=false
  for arg in "$@"; do [ "$arg" = -- ] && has_separator=true; done
  [ "$has_separator" = true ] || { printf "error: unknown option '-y'\n" >&2; exit 2; }
  exit 0
fi
exit 1
EOF
chmod +x "$scenario3_bin/claude"
scenario3_home="$state_dir/scenario3-home"
mkdir -p "$scenario3_home"
if scenario3_output="$(PATH="$scenario3_bin:$node_bin:/usr/bin:/bin" HOME="$scenario3_home" \
  MEGABRAIN_STATE_DIR="$scenario3_home" MEGABRAIN_ROOT="$root" \
  MEGABRAIN_PLAYWRIGHT_ROOT="$scenario3_playwright_root" \
  MEGABRAIN_PLAYWRIGHT_SCRIPT="$scenario3_playwright_script" \
  "$root/.build/megabrain" install simulator-web --yes 2>&1)"; then
  :
else
  fail "install simulator-web did not accept the command separator: $scenario3_output"
fi
printf 'scenario 3: Claude registration is guarded\n'

# Scenario 6: the uncertain dispatch set reported by doctor must be selectable.
# WHY: command_orchestrate_list (lib/module-context.sh) has no production caller -- `orchestrate
# list` forwards unconditionally to the compiled binary (command_orchestrate's own dispatch
# table) -- so this drives that binary directly instead. filterDispatchRecords treats
# processState "start-unproven" as uncertain regardless of caller ownership when --uncertain is
# passed (src/core/dispatch.ts), matching this fixture.
dispatch_state="$state_dir/dispatch-state"
mkdir -p "$dispatch_state/dispatches/uncertain" "$dispatch_state/dispatches/healthy"
printf '%s\n' '{"dispatchId":"uncertain","parentSessionId":"","parentHost":"unknown","state":"running","processState":"start-unproven","terminalState":"owned","worktreePath":"/tmp/uncertain"}' >"$dispatch_state/dispatches/uncertain/meta.json"
printf '%s\n' '{"dispatchId":"healthy","parentSessionId":"","parentHost":"unknown","state":"running","processState":"running","terminalState":"owned","worktreePath":"/tmp/healthy"}' >"$dispatch_state/dispatches/healthy/meta.json"
uncertain_list="$(MEGABRAIN_STATE_DIR="$dispatch_state" "$root/.build/megabrain" orchestrate list --uncertain --json)"
assert_contains "$uncertain_list" 'uncertain'
assert_contains "$uncertain_list" 'uncertain' 'orchestrate list --uncertain omitted the doctor-counted dispatch'
assert_not_contains "$uncertain_list" 'healthy' 'orchestrate list --uncertain included a healthy dispatch'
printf 'scenario 6: uncertain dispatches are selectable\n'

# Scenario 7: the version command must be discoverable from top-level help.
help_output="$("$root/.build/megabrain" --help)"
assert_contains "$help_output" '--version' 'top-level help omitted the version flag'
printf 'scenario 7: help documents the version flag\n'

# Scenario 8: the install record must identify itself as historical rather than live status.
# WHY: megabrain_state_set (lib/common.sh) has no production caller -- `megabrain install`
# forwards unconditionally to the compiled binary, whose own writeInstalledState
# (src/cli/commands/install-doctor.ts) is the only place that still writes this record. Reuses
# scenario 3's real, successful `install simulator-web` run instead of hand-writing the record.
jq -e '._meta.kind == "installation-record" and ._meta.recordedAt != null and ._meta.liveStatusCommand == "megabrain doctor"' "$scenario3_home/state.json" >/dev/null ||
  fail 'state.json did not identify its timestamp and live-status command'
printf 'scenario 8: install record identifies its timestamp\n'

# Scenario 9: compiled chain edit removes its editor directory on every path.
run_chain_edit_cleanup_case() {
  local case_name="$1" expected_status="$2"
  local case_home="$state_dir/chain-edit-$case_name-home"
  local case_state="$case_home/.megabrain"
  local case_tmp="$state_dir/chain-edit-$case_name-tmp"
  local case_editor="$case_home/editor.sh"
  mkdir -p "$case_state" "$case_tmp"
  printf '%s\n' '{"chains":{"demo":{"when":{},"steps":[{"agent":"codex","model":"gpt-5.6-luna","effort":"low"}]}},"defaultSteps":[]}' >"$case_state/chains.json"
  case "$case_name" in
    unchanged|failure)
      printf '%s\n' '#!/usr/bin/env bash' 'touch "$(dirname "$1")/.$(basename "$1").swp"' >"$case_editor"
      [ "$case_name" = failure ] && printf '%s\n' 'exit 1' >>"$case_editor"
      ;;
    edited)
      printf '%s\n' '#!/usr/bin/env bash' 'tmp="$1.next"' 'jq '\''.chains.demo.steps[0].effort = "high"'\'' "$1" >"$tmp"' 'mv "$tmp" "$1"' 'touch "$(dirname "$1")/.$(basename "$1").swp"' >"$case_editor"
      ;;
  esac
  chmod +x "$case_editor"
  local status
  if HOME="$case_home" TMPDIR="$case_tmp" MEGABRAIN_STATE_DIR="$case_state" \
    MEGABRAIN_CHAIN_FILE="$case_state/chains.json" EDITOR="$case_editor" \
    "$root/.build/megabrain" chain edit demo >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  [ "$status" -eq "$expected_status" ] || fail "chain edit $case_name returned status $status"
  local leftover
  leftover="$(find "$case_home" -mindepth 1 -maxdepth 1 -type d ! -name .megabrain -print -quit)"
  [ -z "$leftover" ] || fail "chain edit $case_name left temporary directory $leftover"
  leftover="$(find "$case_tmp" -mindepth 1 -print -quit)"
  [ -z "$leftover" ] || fail "chain edit $case_name left temporary path $leftover"
}
run_chain_edit_cleanup_case unchanged 0
run_chain_edit_cleanup_case edited 0
run_chain_edit_cleanup_case failure 1
printf 'scenario 9: chain editor temporary directories are cleaned on unchanged, edited, and failure paths\n'

# WHY: scenario 10 ("both browser profiles need an explicit active/inactive explanation") and
# the former scenario 4/5 (per-agent attributed MCP registration output; a "registered X; failed
# Y" summary line) are deleted, not rewritten. All three drove module_simulator_web_install and
# megabrain_register_playwright directly, both removed once install routed to the binary — those
# functions' user-facing text (an "active chromium; available for firefox-only runs" info line,
# a per-agent output-attribution prefix, a registered/failed summary line) has no equivalent in
# installSimulatorWeb (src/cli/commands/install-doctor.ts): it reports which agents failed on
# outright failure and otherwise returns the compiled doctor's own after-install status line, but
# it does not reproduce these three shell-only message shapes. This is an intentional
# simplification of this lane's port, not an accident — DECIDED B only requires that a failed
# external command is never reported as success, which installSimulatorWeb still satisfies (see
# tests/unit/install.test.ts and scenario 3 above) — but it is a real loss of message detail
# worth flagging rather than silently dropping.

# Scenario 11: a failing container test leaves named output outside the stdout pipe.
if [ "${MEGABRAIN_IN_CONTAINER:-false}" = true ]; then
  printf 'skip: scenario 11 skipped inside the container runner because Docker is host-owned\n'
else
  container_fixture="$root/tests/.container-failure-fixture.sh"
  container_output_dir="$state_dir/container-results"
  printf '#!/usr/bin/env bash\nprintf "deliberate fixture failure\\n"\nexit 1\n' >"$container_fixture"
  chmod +x "$container_fixture"
  container_run_output="$(MEGABRAIN_TEST_OUTPUT_DIR="$container_output_dir" \
    "$root/tests/container/run.sh" tests/.container-failure-fixture.sh 2>&1 | tail -3 || true)"
  failure_report="$(find "$container_output_dir" -name failures.log -print -quit 2>/dev/null || true)"
  [ -n "$failure_report" ] || fail 'container failure report was lost outside the stdout pipe'
  assert_contains "$(cat "$failure_report")" '.container-failure-fixture.sh' \
    'container failure report did not name the failing test'
  assert_contains "$(cat "$failure_report")" 'deliberate fixture failure' \
    'container failure report did not preserve the failing output'
  printf 'scenario 11: container failure output survives stdout piping (%s)\n' "$container_run_output"
fi

printf 'ok: real-use defect scenarios\n'
