#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-vanished-pane.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state"
unset MEGABRAIN_DISPATCH_ID
mkdir -p "$HOME"
require_megabrain_test_state

real_tmux="$(command -v tmux)"
server="mb-pane-$RANDOM-$$"
cleanup() {
  "$real_tmux" -L "$server" kill-server >/dev/null 2>&1 || true
  remove_test_dir "$work"
}
trap cleanup EXIT

mkdir -p "$work/bin"
cat >"$work/bin/tmux" <<'SH'
#!/usr/bin/env bash
exec "$MEGABRAIN_TEST_REAL_TMUX" -L "$MEGABRAIN_TEST_TMUX_SERVER" "$@"
SH
chmod +x "$work/bin/tmux"
export PATH="$work/bin:$PATH" MEGABRAIN_TEST_REAL_TMUX="$real_tmux" MEGABRAIN_TEST_TMUX_SERVER="$server"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

session="protected"
survivor="$("$real_tmux" -L "$server" new-session -d -s "$session" -P -F '#{pane_id}' "cat >$work/survivor-input")"
vanished="$("$real_tmux" -L "$server" split-window -d -t "$survivor" -P -F '#{pane_id}' 'sleep 120')"
session_id="$("$real_tmux" -L "$server" display-message -p -t "$survivor" '#{session_id}')"
"$real_tmux" -L "$server" kill-pane -t "$vanished"

dispatch="vanished-pane"
mkdir -p "$work/legacy/dispatches/$dispatch"
cat >"$work/legacy/dispatches/$dispatch/meta.json" <<EOF
{"dispatchId":"$dispatch","parentHost":"orca","parentSessionId":"parent-terminal","runtime":"tmux","tmuxSession":"$session","tmuxSessionId":"$session_id","tmuxPane":"$vanished","agent":"codex","state":"running","processState":"running","terminalState":"owned","createdAt":"2026-10-11T00:00:00.000Z","updatedAt":"2026-10-11T00:00:00.000Z"}
EOF
"$root/.build/megabrain" db import "$work/legacy" --replace --json >/dev/null

for operation in "orchestrate reply $dispatch --text should-not-type --json" "orchestrate stop $dispatch --json" "orchestrate close $dispatch --json"; do
  output="$work/output" error="$work/error"
  set +e
  env MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=parent-terminal ORCA_TERMINAL_HANDLE=parent-terminal \
    "$root/.build/megabrain" $operation >"$output" 2>"$error"
  status=$?
  set -e
  message="$(cat "$output" "$error")"
  case "$operation" in
    orchestrate\ reply\ *)
      [ "$status" -eq 0 ] || fail "reply should remain queued when its pane is absent: $message"
      [ "$(jq -r '.nudge' "$output")" = not-typed ] || fail "reply reported a nudge to the absent pane: $message"
      ;;
    orchestrate\ close\ *)
      [ "$status" -eq 0 ] || fail "close should release the dispatch when its pane is absent: $message"
      ;;
    *)
      [ "$status" -ne 0 ] || fail "unexpected success for $operation with missing pane $vanished"
      case "$message" in *"$vanished"*|*"no longer available"*) ;; *) fail "unclear refusal for $operation: $message" ;; esac
      ;;
  esac
done

queue="$(env MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=parent-terminal ORCA_TERMINAL_HANDLE=parent-terminal \
  "$root/.build/megabrain" orchestrate queue --json)"
jq -e '.[] | select(.text == "should-not-type")' >/dev/null <<<"$queue" || fail "reply was not kept queued"
dispatches="$(env MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=parent-terminal ORCA_TERMINAL_HANDLE=parent-terminal \
  "$root/.build/megabrain" orchestrate list --all --json)"
jq -e --arg id "$dispatch" '.[] | select(.dispatchId == $id and .state == "closed")' >/dev/null <<<"$dispatches" || fail "dispatch was not marked closed"
[ -s "$work/survivor-input" ] && fail "a stale pane target typed into surviving pane $survivor"
[ "$("$real_tmux" -L "$server" list-panes -a -F '#{pane_id}' | grep -Fxc "$survivor")" -eq 1 ] || fail "surviving pane $survivor was removed"
printf '3 passed, 0 failed, 0 skipped\n'
