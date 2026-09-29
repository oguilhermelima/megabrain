#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
node_bin="$(dirname "$(command -v node)")"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-stop-reconcile.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/.megabrain-test-state"
require_megabrain_test_state

export HOME="$work/home"
mkdir -p "$HOME"
trap 'rm -rf "$work"' EXIT

source "$root/tests/fixtures/entrypoint-routing.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_json() { printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"; }
assert_safe_state_dir() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || fail 'MEGABRAIN_STATE_DIR is unset'
  local state_path home_path home_candidate
  state_path="$(cd "$MEGABRAIN_STATE_DIR" && pwd -P)"
  for home_candidate in "$test_real_home" "$HOME"; do
    [ -n "$home_candidate" ] && [ -d "$home_candidate" ] || continue
    home_path="$(cd "$home_candidate" && pwd -P)"
    case "$state_path/" in "$home_path/.megabrain/"*) fail 'refusing real-home megabrain state directory' ;; esac
  done
}
import_state() { export MEGABRAIN_STATE_DIR="$1"; assert_safe_state_dir; "$root/.build/megabrain" db import "$1" --replace --json >/dev/null; }
db_show() { MEGABRAIN_STATE_DIR="$1" "$root/.build/megabrain" db show "$2" --json; }

write_route_binary() {
  local fixture="$1" marker="$2"
  printf '#!/usr/bin/env bash\nprintf '\''%%s\\n'\'' %q\nexit 73\n' "$marker" >"$fixture/.build/megabrain"
  chmod +x "$fixture/.build/megabrain"
}

scenario_route_reaches_compiled_binary() {
  local verb="$1" marker="$2" fixture output status
  fixture="$work/route-$verb"
  shift 2
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_route_binary "$fixture" "$marker"
  set +e
  output="$(env MEGABRAIN_STATE_DIR="$work/route-state-$verb" "$fixture/.build/megabrain" "$@" 2>"$work/route-$verb.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" "$marker"
  printf '%s route reaches the compiled binary and preserves its marker\n' "$verb"
}

scenario_routes() {
  scenario_route_reaches_compiled_binary stop stop-route orchestrate stop route-dispatch --json
  scenario_route_reaches_compiled_binary read read-route orchestrate read route-dispatch --json
  scenario_route_reaches_compiled_binary reconcile reconcile-route orchestrate reconcile route-dispatch --json
}

write_meta() {
  local state="$1" dispatch="$2" json="$3"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  json="$(jq -c 'if has("state") then . else .state = "running" end' <<<"$json")"
  printf '%s\n' "$json" >"$state/dispatches/$dispatch/meta.json"
  import_state "$state"
}

run_binary() {
  local state="$1"; shift
  mkdir -p "$state"
  export MEGABRAIN_STATE_DIR="$state"
  assert_safe_state_dir
  env -i HOME="$work/home" PATH="$work/bin:$node_bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" \
    MEGABRAIN_STATE_DIR="$state" MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=parent \
    ORCA_TERMINAL_HANDLE=parent PS_IDENTITY="${PS_IDENTITY:-missing}" \
    MEGABRAIN_TEST_DISPATCH="${MEGABRAIN_TEST_DISPATCH:-dispatch}" TMUX_CALLS="${TMUX_CALLS:-/dev/null}" \
    "$root/.build/megabrain" "$@"
}

write_tmux_fixture() {
  cat >"$work/bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) printf '%%1\n' ;;
  display-message)
    case "$*" in
      *pane_pid*) printf '999\n' ;;
      *) printf 'session\n' ;;
    esac
    ;;
  capture-pane) printf 'Working (1s)\nesc to interrupt\n' ;;
  send-keys) printf '%s\n' "$*" >>"$TMUX_CALLS" ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$work/bin/tmux"
  cat >"$work/bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -p ]; then
  printf 'pts/1\n'
elif [ "${PS_IDENTITY:-missing}" = proven ]; then
  printf '999 1 worker MEGABRAIN_DISPATCH_ID=%s\n' "${MEGABRAIN_TEST_DISPATCH:-dispatch}"
elif [ "${PS_IDENTITY:-missing}" = unrelated ]; then
  printf '999 1 unrelated-worker\n'
  printf '1000 1 other-worker MEGABRAIN_DISPATCH_ID=%s\n' "${MEGABRAIN_TEST_DISPATCH:-dispatch}"
else
  printf '999 1 unrelated-worker\n'
fi
EOF
  chmod +x "$work/bin/ps"
}

scenario_stop_requires_identity_proof() {
  local state="$work/stop-identity" output status
  write_tmux_fixture
  write_meta "$state" stop-identity '{"dispatchId":"stop-identity","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","agent":"codex","tmuxSession":"session","tmuxPane":"%1","state":"running","processState":"running","terminalState":"owned"}'
  : >"$work/tmux.calls"
  set +e
  output="$(TMUX_CALLS="$work/tmux.calls" MEGABRAIN_TEST_DISPATCH=stop-identity PS_IDENTITY=missing run_binary "$state" orchestrate stop stop-identity --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'stop interrupted a pane without dispatch identity proof'
  assert_contains "$output" 'terminal identity is unproven'
  assert_equal "$(wc -l <"$work/tmux.calls" | tr -d ' ')" 0
  assert_equal "$(db_show "$state" stop-identity | jq '.messages | length')" 0
  printf 'stop refuses an unproven tmux identity before sending Escape\n'
}

scenario_stop_rejects_unrelated_identity_proof() {
  local state="$work/stop-unrelated-identity" output status
  write_tmux_fixture
  write_meta "$state" stop-unrelated-identity '{"dispatchId":"stop-unrelated-identity","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","agent":"codex","tmuxSession":"session","tmuxPane":"%1","state":"running","processState":"running","terminalState":"owned"}'
  : >"$work/tmux.calls"
  set +e
  output="$(TMUX_CALLS="$work/tmux.calls" MEGABRAIN_TEST_DISPATCH=stop-unrelated-identity PS_IDENTITY=unrelated run_binary "$state" orchestrate stop stop-unrelated-identity --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'stop trusted an identity marker from an unrelated process tree'
  assert_contains "$output" 'terminal identity is unproven'
  assert_equal "$(wc -l <"$work/tmux.calls" | tr -d ' ')" 0
  printf 'stop rejects a marker that belongs to an unrelated process tree\n'
}

scenario_stop_interrupts_proven_working_agent() {
  local state="$work/stop-proven" output
  write_tmux_fixture
  write_meta "$state" stop-proven '{"dispatchId":"stop-proven","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","agent":"codex","tmuxSession":"session","tmuxPane":"%1","state":"running","processState":"running","terminalState":"owned"}'
  : >"$work/tmux.calls"
  output="$(TMUX_CALLS="$work/tmux.calls" MEGABRAIN_TEST_DISPATCH=stop-proven PS_IDENTITY=proven run_binary "$state" orchestrate stop stop-proven --json)"
  assert_safe_state_dir
  assert_json "$output" '.dispatchId == "stop-proven" and .status == "interrupted" and .result == "landed" and .interrupted == true'
  assert_contains "$(cat "$work/tmux.calls")" 'send-keys -t %1 Escape'
  assert_equal "$(db_show "$state" stop-proven | jq -r '[.messages[].type] | join(" ")')" 'interrupt interrupt-result'
  printf 'stop records and lands an interrupt only after identity and working checks\n'
}

write_orca_fixture() {
  cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2" = 'terminal list' ]; then
  printf '%s\n' '{"result":{"terminals":[{"handle":"parent"}]}}'
elif [ "$1 $2" = 'terminal read' ]; then
  printf '%s\n' '{"terminal":{"output":"host terminal output"}}'
else
  exit 0
fi
EOF
  chmod +x "$work/bin/orca"
}

scenario_read_preserves_host_content() {
  local state="$work/read-host" output
  write_orca_fixture
  write_meta "$state" read-host '{"dispatchId":"read-host","parentSessionId":"parent","parentHost":"orca","runtime":"host","childHost":"orca","terminalId":"child"}'
  output="$(run_binary "$state" orchestrate read read-host --json)"
  assert_json "$output" '.dispatchId == "read-host" and .source == "host" and .text == "host terminal output"'
  printf 'read preserves nested host terminal output in compiled content\n'
}

scenario_read_renders_transcript_fallback() {
  local state="$work/read-transcript" output
  cat >"$work/bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = capture-pane ]; then exit 1; fi
exit 0
EOF
  chmod +x "$work/bin/tmux"
  write_meta "$state" read-transcript '{"dispatchId":"read-transcript","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","tmuxSession":"missing","tmuxPane":"%9","state":"done"}'
  mkdir -p "$state/transcripts"
  printf 'old one\nold two\033[2A\033[2K\033]0;ignored\007\033[1mfinal one\033[0m\033[1B\033[1G\033[2Kfinal two\nplain three\n' >"$state/transcripts/read-transcript.txt"
  output="$(run_binary "$state" orchestrate read read-transcript --lines 3 --json)"
  assert_json "$output" '.source == "file" and .text == "final one\nfinal two\nplain three" and .truncated == false'
  printf 'read renders terminal controls from the persisted transcript\n'
}

scenario_reconcile_syncs_receipt_and_parent_identity() {
  local state="$work/reconcile-adopted" output
  write_tmux_fixture
  write_orca_fixture
  write_meta "$state" reconcile-adopted '{"dispatchId":"reconcile-adopted","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","agent":"codex","tmuxSession":"session","tmuxPane":"%1","state":"spawning","processState":"starting","terminalState":"retained","promptDelivery":"pending","promptReceipt":"pending","promptState":"awaiting-publication"}'
  printf '%s\n' '{"seq":1,"from":"child","type":"received","text":"received"}' >"$state/dispatches/reconcile-adopted/messages/00001-child-received.json"
  import_state "$state"
  output="$(TMUX_CALLS="$work/tmux.calls" MEGABRAIN_TEST_DISPATCH=reconcile-adopted PS_IDENTITY=proven run_binary "$state" orchestrate reconcile reconcile-adopted --json)"
  assert_json "$output" '.reconcileResult == "adopted" and .state == "running" and .processState == "running" and .terminalState == "owned" and .promptReceipt == "received" and .promptState == "confirmed"'
  printf 'reconcile syncs a child receipt and adopts a proven live terminal\n'
}

scenario_reconcile_refuses_unproven_terminal() {
  local state="$work/reconcile-unproven" output
  write_tmux_fixture
  write_meta "$state" reconcile-unproven '{"dispatchId":"reconcile-unproven","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","agent":"codex","tmuxSession":"session","tmuxPane":"%1","state":"running","processState":"running","terminalState":"owned"}'
  output="$(TMUX_CALLS="$work/tmux.calls" MEGABRAIN_TEST_DISPATCH=reconcile-unproven PS_IDENTITY=missing run_binary "$state" orchestrate reconcile reconcile-unproven --json)"
  assert_json "$output" '.reconcileResult == "identity-unproven" and .terminalState == "retained" and .stage == "identity-unproven"'
  printf 'reconcile retains a terminal whose process identity is unproven\n'
}

scenario_reconcile_keeps_waiting_for_reply() {
  local state="$work/reconcile-waiting" output
  write_tmux_fixture
  write_meta "$state" reconcile-waiting '{"dispatchId":"reconcile-waiting","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","agent":"codex","tmuxSession":"session","tmuxPane":"%1","state":"waiting_for_reply","processState":"running","terminalState":"owned"}'
  printf '%s\n' '{"seq":1,"from":"child","type":"ask","text":"question"}' >"$state/dispatches/reconcile-waiting/messages/00001-child-ask.json"
  import_state "$state"
  output="$(TMUX_CALLS="$work/tmux.calls" MEGABRAIN_TEST_DISPATCH=reconcile-waiting PS_IDENTITY=proven run_binary "$state" orchestrate reconcile reconcile-waiting --json)"
  assert_json "$output" '.reconcileResult == "adopted" and .state == "waiting_for_reply" and .processState == "running"'
  printf 'reconcile keeps a live dispatch waiting for its unanswered child question\n'
}

scenario_routes

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled dispatch binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

mkdir -p "$work/home" "$work/bin"
scenario_stop_requires_identity_proof
scenario_stop_rejects_unrelated_identity_proof
scenario_stop_interrupts_proven_working_agent
scenario_read_preserves_host_content
scenario_read_renders_transcript_fallback
scenario_reconcile_syncs_receipt_and_parent_identity
scenario_reconcile_refuses_unproven_terminal
scenario_reconcile_keeps_waiting_for_reply
printf 'ok: stop, read, and reconcile routing and content contracts\n'
