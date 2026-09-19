#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-spawn-rollback.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
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

make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git init -q "$repo"
  git -C "$repo" config user.email tester@example.com
  git -C "$repo" config user.name tester
  git -C "$repo" config init.defaultBranch main
  printf 'base\n' >"$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -qm base
}

write_launch_stubs() {
  local bin="$1" close_log="$2"
  mkdir -p "$bin"
  cat >"$bin/codex" <<'EOF'
#!/usr/bin/env bash
printf 'agent wrote this file\n' >agent-wrote.txt
EOF
  cat >"$bin/orca" <<EOF
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  'terminal create')
    printf '%s\n' '{"result":{"terminal":{"handle":"child-terminal"}}}'
    ;;
  'terminal read')
    printf '%s\n' '{"text":"ready"}'
    ;;
  'terminal send')
    text=""
    while [ "\$#" -gt 0 ]; do
      if [ "\$1" = --text ]; then
        text="\${2:-}"
        shift 2
      else
        shift
      fi
    done
    eval "\$text"
    ;;
  'terminal wait')
    exit "\${ORCA_WAIT_STATUS:-0}"
    ;;
  'terminal close')
    printf '%s\n' "\${4:-}" >>"$close_log"
    printf '%s\n' '{"ok":true}'
    ;;
  'terminal list')
    printf '%s\n' '{"result":{"terminals":[{"handle":"child-terminal"}]}}'
    ;;
  *)
    exit 1
    ;;
esac
EOF
  chmod +x "$bin/codex" "$bin/orca"
}

scenario_launch_failure_keeps_worktree() {
  local scenario="$work_dir/launch-failure" state="$work_dir/launch-failure/state" repo="$work_dir/launch-failure/repo"
  local shared="$work_dir/launch-failure/shared" bin="$work_dir/launch-failure/bin"
  local close_log branch worktree output launch_status
  branch='fix/launch-failure'
  worktree="$shared/fix-launch-failure"
  mkdir -p "$scenario" "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"
  close_log="$scenario/close.log"
  write_launch_stubs "$bin" "$close_log"

  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=shell ORCA_TERMINAL_HANDLE=parent-terminal \
    ORCA_WAIT_STATUS=1 PATH="$bin:/usr/bin:/bin" "$root/megabrain" orchestrate spawn \
    --repo "$repo" --branch "$branch" --agent codex --model gpt-5 --effort medium \
    --prompt 'write the fixture file' --tmux false --json 2>&1)"
  launch_status=$?
  set -e

  # The exit status is intentionally not the proof: both the broken and fixed
  # implementations return failure. The file and branch are the falsification.
  [ -f "$worktree/agent-wrote.txt" ] || fail "launch status $launch_status removed the agent file: $output"
  git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" ||
    fail "launch status $launch_status removed the branch: $output"
  [ -d "$worktree" ] || fail "launch status $launch_status removed the worktree: $output"
  assert_contains "$output" 'agent launch failed'
  printf 'launch failure keeps the written file, worktree, and branch\n'
}

scenario_metadata_read_failure_closes_host() {
  local scenario="$work_dir/metadata-read-failure" state="$work_dir/metadata-read-failure/state"
  local repo="$work_dir/metadata-read-failure/repo" shared="$work_dir/metadata-read-failure/shared"
  local close_log dispatch_id meta metadata_read_marker
  local launch_status
  mkdir -p "$scenario" "$state" "$shared"
  make_repo "$repo"
  close_log="$scenario/close.log"
  metadata_read_marker="$scenario/meta-read-count"

  export MEGABRAIN_ROOT="$root"
  export MEGABRAIN_STATE_DIR="$state"
  export ORCA_TERMINAL_HANDLE=parent-terminal
  unset SUPERSET_TERMINAL_ID TMUX TMUX_PANE
  source "$root/lib/common.sh"
  source "$root/lib/module-context.sh"
  source "$root/lib/module-orchestrate.sh"
  source "$root/lib/module-tmux-runtime.sh"
  source "$root/lib/module-worktree.sh"

  orca() {
    case "${1:-} ${2:-}" in
      'terminal create') printf '%s\n' '{"result":{"terminal":{"handle":"child-terminal"}}}' ;;
      'terminal read') printf '%s\n' '{"text":"ready"}' ;;
      'terminal wait') return 0 ;;
      'terminal close') printf '%s\n' "${4:-}" >>"$close_log" ;;
      'terminal list') printf '%s\n' '{"result":{"terminals":[{"handle":"child-terminal"}]}}' ;;
      *) return 1 ;;
    esac
  }
  megabrain_dispatch_native_send() {
    return 0
  }
  megabrain_dispatch_meta_read() {
    local dispatch_id="$1" path count
    count="$(cat "$metadata_read_marker" 2>/dev/null || printf '0')"
    count=$((count + 1))
    printf '%s\n' "$count" >"$metadata_read_marker"
    [ "$count" -ne 2 ] || return 1
    path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
    [ -f "$path" ] || return 1
    cat "$path"
  }

  MEGABRAIN_SPAWN_RUNTIME=host
  MEGABRAIN_SPAWN_CONTEXT=orca
  set +e
  megabrain_launch_agent "$repo" '' codex gpt-5 medium prompt label false >/dev/null 2>&1
  launch_status=$?
  set -e
  [ "$launch_status" -ne 0 ] || fail 'metadata read failure unexpectedly succeeded'

  dispatch_id="$(find "$state/dispatches" -name meta.json -print | sed 's#.*/dispatches/##; s#/meta.json$##' | head -n 1)"
  [ -n "$dispatch_id" ] || fail 'metadata read failure did not leave dispatch metadata'
  meta="$state/dispatches/$dispatch_id/meta.json"
  grep -Fx 'child-terminal' "$close_log" >/dev/null || fail 'metadata read failure left the host terminal open'
  [ "$(jq -r '.state' "$meta")" = failed ] || fail 'metadata read failure did not fail the dispatch'
  [ "$(jq -r '.stage' "$meta")" = prompt-delivery ] || fail 'metadata read failure did not record its failure stage'
  [ "$(jq -r '.reason' "$meta")" = metadata-read-failed ] || fail 'metadata read failure did not record its failure reason'
  printf 'metadata read failure closes the host and records its reason\n'
}

case "${TEST_SCENARIO:-all}" in
  launch) scenario_launch_failure_keeps_worktree ;;
  metadata) scenario_metadata_read_failure_closes_host ;;
  all)
    scenario_launch_failure_keeps_worktree
    scenario_metadata_read_failure_closes_host
    ;;
  *) fail "unknown TEST_SCENARIO: ${TEST_SCENARIO:-}" ;;
esac
