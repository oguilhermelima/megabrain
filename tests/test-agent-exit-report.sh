#!/usr/bin/env bash

set -euo pipefail

root="${MEGABRAIN_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
source "$root/tests/fixtures/a-dispatch-meta.sh"

state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-agent-exit-report.XXXXXX")"
bin_dir="$state_dir/bin"
mkdir -p "$bin_dir"
host_records_mode=missing

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_not_equal() {
  [ "$1" != "$2" ] || fail "expected values to differ, both were '$1'"
}

# Real orca/superset executables, matching what src/hosts/{orca,superset}.ts actually invoke
# (orca terminal list --json / superset terminals list --workspace <id> --json). An empty
# terminal list reports the dispatch's own terminal as missing; invalid JSON keeps it unproven.
cat >"$bin_dir/orca" <<EOF_ORCA
#!/usr/bin/env bash
if [ "\${1:-}" = terminal ] && [ "\${2:-}" = list ]; then
  if [ "\$MEGABRAIN_TEST_HOST_RECORDS" = invalid ]; then
    printf '%s\n' 'not json'
  else
    printf '%s\n' '{"result":{"terminals":[]}}'
  fi
  exit 0
fi
exit 1
EOF_ORCA
chmod +x "$bin_dir/orca"
cat >"$bin_dir/superset" <<EOF_SUPERSET
#!/usr/bin/env bash
if [ "\${1:-}" = terminals ] && [ "\${2:-}" = list ]; then
  if [ "\$MEGABRAIN_TEST_HOST_RECORDS" = invalid ]; then
    printf '%s\n' 'not json'
  else
    printf '%s\n' '{"sessions":[]}'
  fi
  exit 0
fi
exit 1
EOF_SUPERSET
chmod +x "$bin_dir/superset"
export PATH="$bin_dir:/usr/bin:/bin"

reconcile() {
  local dispatch_id="$1"
  MEGABRAIN_TEST_HOST_RECORDS="$host_records_mode" MEGABRAIN_STATE_DIR="$state_dir" \
    "$root/.build/megabrain" orchestrate reconcile "$dispatch_id" --json
}

# executeOrchestrateReconcile (src/cli/commands/orchestrate-stop-reconcile.ts) has no caller
# ownership gate, unlike reply/stop; the child's own runtime/childHost is what is reconciled,
# so no particular caller identity is required here.
create_dispatch() {
  local dispatch_id="$1" child_host="$2" runtime="$3"
  local tmux_session='' tmux_pane=''
  if [ "$runtime" = tmux ]; then
    tmux_session="megabrain-agent-exit-report-missing-$$"
    tmux_pane='%missing'
  fi
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    childHost="$child_host" workspaceId=workspace-test runtime="$runtime" \
    tmuxSession="$tmux_session" tmuxPane="$tmux_pane" state=running >/dev/null
}

assert_exit_record() {
  local dispatch_id="$1" meta
  meta="$(cat "$state_dir/dispatches/$dispatch_id/meta.json")"
  assert_equal "$(jq -r '.state' <<<"$meta")" running
  assert_equal "$(jq -r '.processState' <<<"$meta")" exited
  assert_equal "$(jq -r '.terminalState' <<<"$meta")" missing
  assert_equal "$(jq -r '.stage' <<<"$meta")" agent-exit
  assert_equal "$(jq -r '.reason' <<<"$meta")" 'agent exited without reporting'
  assert_equal "$(jq -r '.reconcileOutcome' <<<"$meta")" agent-exited
  assert_equal "$(jq -r '.failureCount' <<<"$meta")" 0
}

scenario_missing_terminal_records_exit() {
  local dispatch_id="$1" child_host="$2" runtime="$3"
  host_records_mode=missing
  create_dispatch "$dispatch_id" "$child_host" "$runtime"
  reconcile "$dispatch_id" >/dev/null
  assert_exit_record "$dispatch_id"
  printf 'proven terminal death records an exit without reporting (%s)\n' "$child_host"
}

scenario_missing_terminal_is_idempotent() {
  host_records_mode=missing
  create_dispatch duplicate tmux tmux
  reconcile duplicate >/dev/null
  first_meta="$(cat "$state_dir/dispatches/duplicate/meta.json")"
  reconcile duplicate >/dev/null
  second_meta="$(cat "$state_dir/dispatches/duplicate/meta.json")"
  assert_equal "$first_meta" "$second_meta"
  printf 'repeated terminal death observation is idempotent\n'
}

scenario_unproven_terminal_stays_unknown() {
  host_records_mode=invalid
  create_dispatch unproven superset host
  reconcile unproven >/dev/null
  meta="$(cat "$state_dir/dispatches/unproven/meta.json")"
  assert_equal "$(jq -r '.state' <<<"$meta")" running
  assert_equal "$(jq -r '.processState' <<<"$meta")" running
  assert_equal "$(jq -r '.terminalState' <<<"$meta")" retained
  assert_equal "$(jq -r '.reconcileOutcome' <<<"$meta")" identity-unproven
  assert_not_equal "$(jq -r '.reason' <<<"$meta")" 'agent exited without reporting'
  printf 'unproven terminal does not record an exit\n'
}

case "${1:-}" in
  '')
    for scenario in missing-tmux missing-superset missing-orca duplicate unproven; do
      bash "$0" "$scenario"
    done
    ;;
  missing-tmux) scenario_missing_terminal_records_exit missing-tmux tmux tmux ;;
  missing-superset) scenario_missing_terminal_records_exit missing-superset superset host ;;
  missing-orca) scenario_missing_terminal_records_exit missing-orca orca host ;;
  duplicate) scenario_missing_terminal_is_idempotent ;;
  unproven) scenario_unproven_terminal_stays_unknown ;;
  *)
    printf 'usage: %s {missing-tmux|missing-superset|missing-orca|duplicate|unproven}\n' "$0" >&2
    exit 2
    ;;
esac
