#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export MEGABRAIN_ROOT="$root"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-real-use.XXXXXX")"

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
  "$root/megabrain" install tv-adb --yes >"$state_dir/install.out" 2>&1; then
  fail 'a failed tv-adb install exited successfully'
fi
printf 'scenario 1: failed module install is non-zero\n'

# Scenario 2: reported tmux drift must make the doctor non-ok.
export MEGABRAIN_STATE_DIR="$state_dir/tmux-state"
mkdir -p "$MEGABRAIN_STATE_DIR"
source "$root/lib/common.sh"
for module in "$root"/lib/module-*.sh; do
  source "$module"
done
megabrain_tmux_available() { return 0; }
megabrain_tmux_version() { printf 'tmux 3.5\n'; }
megabrain_runtime_enabled() { return 0; }
megabrain_tmux_tuning_config_path() { printf '%s/tmux.conf\n' "$MEGABRAIN_STATE_DIR"; }
megabrain_tmux_wrapper_config_path() { printf '%s/.zshrc\n' "$MEGABRAIN_STATE_DIR"; }
megabrain_tmux_tuning_block_present() { return 1; }
megabrain_tmux_tuning_installed_current() { return 1; }
megabrain_tmux_wrapper_block_present() { return 1; }
megabrain_tmux_wrapper_installed_current() { return 1; }
megabrain_tmux_tuning_server_running() { return 1; }
megabrain_tmux_config_applied() { return 1; }
if module_tmux_runtime_doctor >/dev/null 2>&1; then
  fail 'tmux doctor reported ok while all drift fields were false'
fi
printf 'scenario 2: tmux drift is non-ok\n'

# Scenario 3: agent CLIs must receive the argument separator.
command_file="$state_dir/claude-args"
megabrain_agent_mcp_registered() { return 1; }
megabrain_remove_playwright() { return 0; }
claude() {
  local arg has_separator=false
  : >"$command_file"
  for arg in "$@"; do
    printf '%s\n' "$arg" >>"$command_file"
    [ "$arg" = -- ] && has_separator=true
  done
  if [ "$has_separator" != true ]; then
    printf "error: unknown option '-y'\n" >&2
    return 2
  fi
  return 0
}
if ! megabrain_register_playwright claude "$state_dir/chromium.json" >/dev/null 2>&1; then
  fail 'Claude MCP registration did not accept the command separator'
fi
grep -Fx -- '--' "$command_file" >/dev/null || fail 'Claude registration command omitted --'
printf 'scenario 3: Claude registration is guarded\n'

# Scenario 4: output from each agent must remain attributable, including the
# failing CLI's diagnostic text.
claude() {
  printf "error: unknown option '-y'\n" >&2
  return 1
}
codex() {
  printf 'codex CLI output\n'
  return 0
}
combined_registration_output="$(
  megabrain_register_playwright claude "$state_dir/chromium.json" 2>&1 || true
  megabrain_register_playwright codex "$state_dir/chromium.json" 2>&1
)"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    *claude*|*codex*) ;;
    *) fail "unattributed MCP registration output: $line" ;;
  esac
done <<< "$combined_registration_output"
assert_contains "$combined_registration_output" "claude: error: unknown option '-y'" \
  'the failing Claude CLI diagnostic was changed or omitted'
assert_contains "$combined_registration_output" 'codex: codex CLI output' \
  'the Codex CLI output was not attributed'
printf 'scenario 4: MCP registration output is attributable\n'

# Scenario 5: the loop must summarize registered and failed agents.
megabrain_present_agents() { printf 'claude\ncodex\n'; }
megabrain_web_local_ready() { return 0; }
megabrain_playwright_ready() { return 0; }
megabrain_playwright_active_browser() { printf 'chromium\n'; }
megabrain_playwright_config_path() { printf '%s/chromium.json\n' "$state_dir"; }
module_simulator_web_doctor() { return 0; }
node() { return 0; }
summary_output="$(module_simulator_web_install false chromium 2>&1 || true)"
assert_contains "$summary_output" \
  'Playwright MCP registration summary: registered codex; failed claude' \
  'MCP registration summary did not identify registered and failed agents'
printf 'scenario 5: MCP registration summary identifies outcomes\n'

# Scenario 6: the uncertain dispatch set reported by doctor must be selectable.
dispatch_state="$state_dir/dispatch-state"
export MEGABRAIN_STATE_DIR="$dispatch_state"
export MEGABRAIN_DISPATCH_DIR="$dispatch_state/dispatches"
mkdir -p "$MEGABRAIN_DISPATCH_DIR/uncertain/meta" "$MEGABRAIN_DISPATCH_DIR/healthy"
printf '%s\n' '{"dispatchId":"uncertain","parentSessionId":"","parentHost":"unknown","state":"running","processState":"start-unproven","terminalState":"owned","worktreePath":"/tmp/uncertain"}' >"$MEGABRAIN_DISPATCH_DIR/uncertain/meta.json"
printf '%s\n' '{"dispatchId":"healthy","parentSessionId":"","parentHost":"unknown","state":"running","processState":"running","terminalState":"owned","worktreePath":"/tmp/healthy"}' >"$MEGABRAIN_DISPATCH_DIR/healthy/meta.json"
uncertain_list="$(command_orchestrate_list --uncertain --json)"
assert_contains "$uncertain_list" 'uncertain'
assert_contains "$uncertain_list" 'uncertain' 'orchestrate list --uncertain omitted the doctor-counted dispatch'
assert_not_contains "$uncertain_list" 'healthy' 'orchestrate list --uncertain included a healthy dispatch'
printf 'scenario 6: uncertain dispatches are selectable\n'

# Scenario 7: the version command must be discoverable from top-level help.
help_output="$("$root/megabrain" --help)"
assert_contains "$help_output" '--version' 'top-level help omitted the version flag'
printf 'scenario 7: help documents the version flag\n'

# Scenario 8: the install record must identify itself as historical rather than live status.
record_state="$state_dir/record-state"
export MEGABRAIN_STATE_DIR="$record_state"
export MEGABRAIN_STATE_FILE="$record_state/state.json"
megabrain_state_set simulator-web true 'installed' || fail 'could not write installation record'
jq -e '._meta.kind == "installation-record" and ._meta.recordedAt != null and ._meta.liveStatusCommand == "megabrain doctor"' "$MEGABRAIN_STATE_FILE" >/dev/null ||
  fail 'state.json did not identify its timestamp and live-status command'
printf 'scenario 8: install record identifies its timestamp\n'

# Scenario 9: compiled chain edit removes its editor directory on every path.
run_chain_edit_cleanup_case() {
  local case_name="$1" expected_status="$2"
  local case_home="$state_dir/chain-edit-$case_name-home"
  local case_state="$case_home/.megabrain"
  local case_tmp="$case_home/tmp"
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

# Scenario 10: both browser profiles need an explicit active/inactive explanation.
export MEGABRAIN_STATE_DIR="$state_dir/browser-state"
MEGABRAIN_PLAYWRIGHT_ROOT="$state_dir/browser-root"
megabrain_web_local_ready() { return 0; }
megabrain_playwright_ready() { return 0; }
megabrain_playwright_active_browser() { printf 'chromium\n'; }
megabrain_playwright_config_path() { printf '%s/chromium.json\n' "$MEGABRAIN_PLAYWRIGHT_ROOT"; }
megabrain_present_agents() { return 1; }
module_simulator_web_doctor() { megabrain_set_status ok 'browser fixture is ready'; return 0; }
node() { return 0; }
browser_output="$(module_simulator_web_install false both)"
assert_contains "$browser_output" 'chromium' 'browser install did not identify the active Chromium profile'
assert_contains "$browser_output" 'firefox' 'browser install did not explain the Firefox profile'
printf 'scenario 10: browser profile roles are explicit\n'

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
