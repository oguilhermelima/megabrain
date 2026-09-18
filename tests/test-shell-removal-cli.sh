#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-shell-removal.XXXXXX")"
trap 'rm -rf "$work"' EXIT

source "$root/tests/fixtures/entrypoint-routing.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_json() { printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"; }

write_fixture_binary() {
  local fixture="$1" content="$2"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\nexit 73\n' "$content" >"$fixture/.build/megabrain"
  chmod +x "$fixture/.build/megabrain"
}

scenario_route_reaches_compiled_binary() {
  local name="$1" content="$2" fixture="$work/route-$1" output status
  shift 2
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" "$content"
  set +e
  output="$(MEGABRAIN_STATE_DIR="$work/state-$name" "$fixture/megabrain" "$@" 2>"$work/state-$name.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" "$content"
  printf '%s route reaches the compiled binary and preserves its content\n' "$name"
}

scenario_route_markers() {
  scenario_route_reaches_compiled_binary worktree-pr '{"verb":"worktree-pr"}' worktree pr fixture --json
  scenario_route_reaches_compiled_binary worktree-adopt '{"verb":"worktree-adopt"}' worktree adopt fixture --json
  scenario_route_reaches_compiled_binary terminal-list '{"verb":"terminal-list"}' terminal list --json
}

setup_repo() {
  local repo="$1"
  git init -q "$repo"
  git -C "$repo" config user.email tester@example.com
  git -C "$repo" config user.name tester
  git -C "$repo" branch -M main
  printf 'base\n' >"$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -qm base
}

scenario_worktree_pr_content() {
  local repo="$work/pr-repo" shared="$work/pr-shared" state="$work/pr-state" bin="$work/pr-bin" output
  mkdir -p "$shared" "$state" "$bin"
  shared="$(cd "$shared" && pwd -P)"
  setup_repo "$repo"
  git -C "$repo" worktree add -q "$shared/feature" -b feature/pr
  printf change >"$shared/feature/change"
  git -C "$shared/feature" add change
  git -C "$shared/feature" commit -qm change
  printf '%s\n' "$shared" >"$state/worktree-root"
  printf '#!/usr/bin/env bash\nprintf "https://example.test/pull/7\\n"\n' >"$bin/gh"
  chmod +x "$bin/gh"
  output="$(env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" worktree pr "$shared/feature" --json)"
  assert_json "$output" '.branch == "feature/pr" and .base == "main" and .url == "https://example.test/pull/7"'
  printf 'worktree pr content reports the created pull request\n'
}

write_superset_fixture() {
  local path="$1" repo="$2"
  cat >"$path" <<EOF
#!/usr/bin/env bash
case "\$1 \${2:-}" in
  "workspaces list") printf '%s\\n' '{"workspaces":[]}' ;;
  "projects list") printf '%s\\n' '{"projects":[]}' ;;
  "projects create") printf '%s\\n' '{"result":{"project":{"id":"project-7"}}}' ;;
  "workspaces create") printf '%s\\n' '{"result":{"workspace":{"id":"workspace-7"}}}' ;;
  "terminals list") printf '%s\\n' '{"terminals":[]}' ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$path"
}

scenario_worktree_adopt_content() {
  local repo="$work/adopt-repo" shared="$work/adopt-shared" state="$work/adopt-state" bin="$work/adopt-bin" output
  mkdir -p "$shared" "$state" "$bin"
  shared="$(cd "$shared" && pwd -P)"
  setup_repo "$repo"
  git -C "$repo" worktree add -q "$shared/adopted" -b feature/adopt
  printf '%s\n' "$shared" >"$state/worktree-root"
  write_superset_fixture "$bin/superset" "$repo"
  output="$(env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" worktree adopt "$shared/adopted" --json)"
  assert_json "$output" '.worktree == "'"$shared/adopted"'" and .branch == "feature/adopt" and .workspace == "workspace-7"'
  printf 'worktree adopt content registers the fixture worktree\n'
}

scenario_terminal_list_content() {
  local state="$work/terminal-state" bin="$work/terminal-bin" output
  mkdir -p "$state/terminals" "$bin"
  cat >"$state/terminals/terminal-7.json" <<EOF
{"terminalId":"terminal-7","host":"superset","workspaceId":"workspace-7","worktree":"$work/worktree","title":"DEV content","command":"run content","createdAt":"now","pid":777,"rootPid":777,"port":8082,"status":"active"}
EOF
  cat >"$bin/superset" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"terminals":[{"terminalId":"terminal-7","pid":777,"status":"active"}]}'
EOF
  chmod +x "$bin/superset"
  output="$(env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'length == 1 and .[0].terminalId == "terminal-7" and .[0].status == "alive" and .[0].command == "run content"'
  printf 'terminal list content classifies the recorded live terminal\n'
}

scenario_terminal_list_identity_and_stale_content() {
  local state="$work/terminal-identity-state" bin="$work/terminal-identity-bin" output
  mkdir -p "$state/terminals" "$bin"
  cat >"$state/terminals/terminal-unverified.json" <<EOF
{"terminalId":"terminal-unverified","host":"superset","workspaceId":"workspace-7","worktree":"$work/worktree","title":"DEV unverified","command":"run unverified","createdAt":"now","pid":777,"rootPid":777,"port":null,"status":"active"}
EOF
  cat >"$state/terminals/terminal-proven.json" <<EOF
{"terminalId":"terminal-proven","host":"superset","workspaceId":"workspace-7","worktree":"$work/worktree","title":"DEV proven","command":"run proven","createdAt":"now","pid":999,"rootPid":999,"port":null,"status":"active"}
EOF
  cat >"$bin/superset" <<'EOF'
#!/usr/bin/env bash
case "${MEGABRAIN_TEST_TERMINAL_MODE:-identity}" in
  identity) printf '%s\n' '{"terminals":[{"terminalId":"terminal-unverified","pid":888,"status":"active"},{"terminalId":"terminal-proven","pid":999,"status":"active"}]}' ;;
  dead) printf '%s\n' '{"terminals":[{"terminalId":"terminal-proven","pid":999,"status":"exited"}]}' ;;
  stale) printf '%s\n' '{"terminals":[]}' ;;
esac
EOF
  chmod +x "$bin/superset"
  output="$(env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_TERMINAL_MODE=identity "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'any(.[]; .terminalId == "terminal-unverified" and .status == "unknown") and any(.[]; .terminalId == "terminal-proven" and .status == "alive")'
  output="$(env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_TERMINAL_MODE=dead "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'any(.[]; .terminalId == "terminal-proven" and .status == "dead")'
  output="$(env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_TERMINAL_MODE=stale "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'all(.[]; .status == "stale")'
  printf 'terminal list content distinguishes identity mismatch, dead, and stale terminals\n'
}

scenario_terminal_list_rejects_subdirectory_selector() {
  local repo="$work/terminal-selector-repo" subdir="$work/terminal-selector-repo/apps/web" state="$work/terminal-selector-state" output status
  mkdir -p "$subdir" "$state"
  setup_repo "$repo"
  set +e
  output="$(env -i HOME="$work/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" terminal list --worktree "$subdir" --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'terminal list accepted a subdirectory selector'
  assert_contains "$output" 'worktree selector points to subdirectory'
  printf 'terminal list rejects a subdirectory selector with an actionable hint\n'
}

scenario_falsification_is_red_for_each_route() {
  local name="$1" expected="$2" fixture="$work/falsification-$1" output status
  shift 2
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" BROKEN
  set +e
  output="$(MEGABRAIN_STATE_DIR="$work/falsification-state-$name" "$fixture/megabrain" "$@" 2>"$work/falsification-$name.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  [ "$output" != "$expected" ] || fail "$name contract stayed green with a broken compiled implementation"
  assert_equal "$output" BROKEN
  printf '%s falsification is RED: compiled output BROKEN is rejected\n' "$name"
}

scenario_route_markers
scenario_worktree_pr_content
scenario_worktree_adopt_content
scenario_terminal_list_content
scenario_terminal_list_identity_and_stale_content
scenario_terminal_list_rejects_subdirectory_selector
scenario_falsification_is_red_for_each_route worktree-pr '{"verb":"worktree-pr"}' worktree pr fixture --json
scenario_falsification_is_red_for_each_route worktree-adopt '{"verb":"worktree-adopt"}' worktree adopt fixture --json
scenario_falsification_is_red_for_each_route terminal-list '{"verb":"terminal-list"}' terminal list --json
printf 'ok: compiled routes and content contracts cover all removal verbs\n'
