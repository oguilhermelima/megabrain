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
    ORCA_TERMINAL_HANDLE=parent-terminal \
    ORCA_WAIT_STATUS=1 PATH="$bin:/usr/bin:/bin" "$root/.build/megabrain" orchestrate spawn \
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
  # "agent launch failed" was the shell wording; the compiled spawn reports one of its own
  # eleven named prompt-state failure reasons instead (src/core/spawn-plan.ts) — here
  # readiness-timeout, since the fake orca's "terminal wait" is made to fail.
  assert_contains "$output" 'readiness-timeout'
  printf 'launch failure keeps the written file, worktree, and branch\n'
}

# scenario_metadata_read_failure_closes_host is dropped (rule 3): it drove megabrain_launch_agent
# directly, which no longer exists anywhere in lib/*.sh (issue 45 phases 6-7 replaced it outright
# with executeSpawn, src/cli/commands/orchestrate-spawn.ts; there was never a staged bash version
# to fall back to). Its class of failure — an internal step erroring out after the host terminal
# is created — is covered in TypeScript by the cleanup-on-failure tests under
# describe("executeSpawn") in tests/unit/spawn.test.ts, in particular "reports cleanup failure
# alongside the primary host command failure" and "uses host cleanup instead of tmux cleanup";
# the exact "re-read our own metadata mid-launch" step this scenario targeted does not exist in
# the compiled spawn (it does not re-read its own just-written meta.json before finishing).

case "${TEST_SCENARIO:-all}" in
  launch) scenario_launch_failure_keeps_worktree ;;
  all)
    scenario_launch_failure_keeps_worktree
    ;;
  *) fail "unknown TEST_SCENARIO: ${TEST_SCENARIO:-}" ;;
esac
