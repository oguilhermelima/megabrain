#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-shell-removal.XXXXXX")"
node_bin="$work/node-bin"
mkdir -p "$node_bin"
ln -s "$(command -v node)" "$node_bin/node"
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
  local name="$1" content="$2" implementation_name="$3" fixture="$work/route-$1" output status
  shift 3
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" "$content"
  set +e
  output="$(env MEGABRAIN_STATE_DIR="$work/state-$name" "$implementation_name=shell" "$fixture/.build/megabrain" "$@" 2>"$work/state-$name.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" "$content"
  printf '%s route reaches the compiled binary and preserves its content\n' "$name"
}

scenario_route_reaches_compiled_binary_default() {
  local name="$1" content="$2" fixture="$work/route-$1" output status
  shift 2
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" "$content"
  set +e
  output="$(env MEGABRAIN_STATE_DIR="$work/state-$name" "$fixture/.build/megabrain" "$@" 2>"$work/state-$name.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" "$content"
  printf '%s default route reaches the compiled binary and preserves its content\n' "$name"
}

scenario_route_markers() {
  scenario_route_reaches_compiled_binary queue-ask '{"verb":"ask"}' MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION ask route-question
  scenario_route_reaches_compiled_binary queue-received '{"verb":"received"}' MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION received
  scenario_route_reaches_compiled_binary queue-done '{"verb":"done"}' MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION done route-summary
  scenario_route_reaches_compiled_binary check '{"verb":"check"}' MEGABRAIN_CHECK_IMPLEMENTATION check --timeout 0 --json
  scenario_route_reaches_compiled_binary reply '{"verb":"reply"}' MEGABRAIN_ORCHESTRATE_REPLY_IMPLEMENTATION orchestrate reply route-dispatch --text route-answer --json
  scenario_route_reaches_compiled_binary read '{"verb":"read"}' MEGABRAIN_ORCHESTRATE_READ_IMPLEMENTATION orchestrate read route-dispatch --json
  scenario_route_reaches_compiled_binary liveness '{"verb":"liveness"}' MEGABRAIN_ORCHESTRATE_LIVENESS_IMPLEMENTATION orchestrate liveness route-dispatch --json
  scenario_route_reaches_compiled_binary orchestrate-list '{"verb":"orchestrate-list"}' MEGABRAIN_ORCHESTRATE_LIST_IMPLEMENTATION orchestrate list --json
  scenario_route_reaches_compiled_binary orchestrate-prune '{"verb":"orchestrate-prune"}' MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION orchestrate prune --dry-run --json
  scenario_route_reaches_compiled_binary orchestrate-change '{"verb":"orchestrate-change"}' MEGABRAIN_ORCHESTRATE_CHANGE_IMPLEMENTATION orchestrate change route-dispatch --text route-answer --json
  scenario_route_reaches_compiled_binary orchestrate-close '{"verb":"orchestrate-close"}' MEGABRAIN_ORCHESTRATE_CLOSE_IMPLEMENTATION orchestrate close route-dispatch --json
  scenario_route_reaches_compiled_binary orchestrate-reconcile '{"verb":"orchestrate-reconcile"}' MEGABRAIN_ORCHESTRATE_RECONCILE_IMPLEMENTATION orchestrate reconcile route-dispatch --json
  scenario_route_reaches_compiled_binary orchestrate-stop '{"verb":"orchestrate-stop"}' MEGABRAIN_ORCHESTRATE_STOP_IMPLEMENTATION orchestrate stop route-dispatch --json
  scenario_route_reaches_compiled_binary_default chain-list '{"verb":"chain-list"}' chain list --json
  scenario_route_reaches_compiled_binary_default chain-limits '{"verb":"chain-limits"}' chain limits --json
  scenario_route_reaches_compiled_binary_default chain-add '{"verb":"chain-add"}' chain add route --json
  scenario_route_reaches_compiled_binary_default chain-edit '{"verb":"chain-edit"}' chain edit route --json
  scenario_route_reaches_compiled_binary_default chain-delete '{"verb":"chain-delete"}' chain delete route --json
  scenario_route_reaches_compiled_binary_default chain-repair '{"verb":"chain-repair"}' chain repair route --json
}

scenario_worktree_list_route_marker() {
  local fixture="$work/route-worktree-list" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  set +e
  output="$(env MEGABRAIN_STATE_DIR="$work/route-worktree-list-state" \
    MEGABRAIN_WORKTREE_LIST_IMPLEMENTATION=binary "$fixture/.build/megabrain" worktree list --json 2>"$work/route-worktree-list.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" ''
  printf 'worktree-list route reaches the compiled binary and preserves its marker status\n'
}

scenario_worktree_write_route_marker() {
  local fixture="$work/route-worktree-write" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" WORKTREE_WRITE_BINARY
  set +e
  output="$(env MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary \
    MEGABRAIN_STATE_DIR="$work/route-worktree-write-state" "$fixture/.build/megabrain" \
    worktree create --repo fixture --branch feat/route --json 2>"$work/route-worktree-write.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" WORKTREE_WRITE_BINARY
  printf 'worktree-write route reaches the compiled binary and preserves its marker status\n'
}

scenario_spawn_route_marker() {
  local fixture="$work/route-spawn" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" SPAWN_BINARY
  set +e
  output="$(env MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary \
    MEGABRAIN_STATE_DIR="$work/route-spawn-state" "$fixture/.build/megabrain" \
    orchestrate spawn --repo fixture --branch feat/route --json 2>"$work/route-spawn.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" SPAWN_BINARY
  printf 'orchestrate-spawn route reaches the compiled binary and preserves its marker status\n'
}

write_dispatch_fixture() {
  local state="$1" dispatch="$2" parent_host="${3:-unknown}" runtime="${4:-host}"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"workspaceId\":\"workspace\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"$parent_host\",\"runtime\":\"$runtime\",\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
}

run_binary_content() {
  local state="$1" dispatch="$2" verb="$3" output
  shift 3
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" "$verb" "$@")"
  printf '%s' "$output"
}

scenario_compiled_content_contracts() {
  local state output

  state="$work/content-ask"
  write_dispatch_fixture "$state" ask
  output="$(run_binary_content "$state" ask ask 'question content')"
  assert_equal "$output" 'ask sent: ask'
  assert_equal "$(jq -r '.state' "$state/dispatches/ask/meta.json")" waiting_for_reply
  printf 'ask content is produced by the compiled command\n'

  state="$work/content-received"
  write_dispatch_fixture "$state" received
  output="$(run_binary_content "$state" received received)"
  assert_equal "$output" 'received sent: received'
  assert_equal "$(jq -r '.promptReceipt' "$state/dispatches/received/meta.json")" received
  printf 'received content is produced by the compiled command\n'

  state="$work/content-done"
  write_dispatch_fixture "$state" done
  output="$(run_binary_content "$state" done done 'summary content')"
  assert_equal "$output" 'done sent: done'
  assert_equal "$(jq -r '.state' "$state/dispatches/done/meta.json")" done
  printf 'done content is produced by the compiled command\n'

  state="$work/content-check"
  write_dispatch_fixture "$state" check
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" check --timeout 0 --poll-interval 0 --consumer content --generation 2 --full --json)"
  assert_json "$output" '.dispatchId == "check" and .status == "empty" and .messages == []'
  printf 'check content includes the compiled empty-mailbox result\n'

  state="$work/content-reply"
  write_dispatch_fixture "$state" reply unknown
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_SESSION_HOST=unknown MEGABRAIN_SESSION_ID=parent-terminal "$root/.build/megabrain" orchestrate reply reply --text 'reply content' --json)"
  assert_json "$output" '.dispatchId == "reply" and .status == "queued" and .nudge == "not-typed"'
  assert_equal "$(jq -r '.text' "$state/dispatches/reply/messages"/*.json)" 'reply content'
  printf 'reply content includes the queued response and status\n'

  state="$work/content-liveness"
  write_dispatch_fixture "$state" liveness unknown
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_SESSION_HOST=unknown MEGABRAIN_SESSION_ID=parent-terminal "$root/.build/megabrain" orchestrate liveness liveness --json)"
  assert_json "$output" '.dispatchId == "liveness" and .dispatchState == "running" and .terminalLiveness == "unknown" and .source == "unknown"'
  printf 'liveness content includes the compiled state result\n'
}

scenario_compiled_argument_forms() {
  local output status
  output="$($root/.build/megabrain ask --help)"
  assert_contains "$output" 'Usage: megabrain ask'
  output="$($root/.build/megabrain received --help)"
  assert_contains "$output" 'Usage: megabrain received'
  output="$($root/.build/megabrain done --help)"
  assert_contains "$output" 'Usage: megabrain done'
  output="$($root/.build/megabrain check --help)"
  assert_contains "$output" 'Usage: megabrain check'
  output="$($root/.build/megabrain orchestrate reply --help)"
  assert_contains "$output" 'Usage: megabrain orchestrate reply'
  output="$($root/.build/megabrain orchestrate liveness --help)"
  assert_contains "$output" 'Usage: megabrain orchestrate liveness'

  set +e
  "$root/.build/megabrain" received unexpected >"$work/received-invalid" 2>&1; status=$?
  set -e
  assert_equal "$status" 2
  assert_contains "$(cat "$work/received-invalid")" 'Usage: megabrain received'
  printf 'compiled commands preserve help and invalid-argument forms\n'
}

scenario_change_reports_actual_interrupt_outcome() {
  local state="$work/content-change" output
  write_dispatch_fixture "$state" change superset
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=parent-terminal \
    "$root/.build/megabrain" orchestrate change change --text 'replacement content' --json)"
  assert_json "$output" '.dispatchId == "change" and .queueChanged == true and .interrupted == false and (.reason | contains("Superset"))'
  printf 'change content reports the actual unavailable interrupt outcome\n'
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
  output="$(env -i HOME="$work/home" PATH="$bin:$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" worktree pr "$shared/feature" --json)"
  assert_json "$output" '.branch == "feature/pr" and .base == "main" and .url == "https://example.test/pull/7"'
  printf 'worktree pr content reports the created pull request\n'
}

scenario_worktree_list_content() {
  local repo="$work/list-repo" shared="$work/list-shared" state="$work/list-state" output
  mkdir -p "$shared" "$state"
  shared="$(cd "$shared" && pwd -P)"
  setup_repo "$repo"
  git -C "$repo" worktree add -q "$shared/feature" -b feature/list
  printf '%s\n' "$shared" >"$state/worktree-root"
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" worktree list --json)"
  printf '%s' "$output" | jq -e --arg path "$shared/feature" \
    'length == 1 and .[0].path == $path and .[0].branch == "feature/list" and .[0].pullRequest == null' >/dev/null ||
    fail "compiled worktree list content was not preserved: $output"
  printf 'worktree list content reports the fixture worktree\n'
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
  output="$(env -i HOME="$work/home" PATH="$bin:$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    "$root/.build/megabrain" worktree adopt "$shared/adopted" --json)"
  assert_json "$output" '.worktree == "'"$shared/adopted"'" and .branch == "feature/adopt" and .workspace == "workspace-7"'
  printf 'worktree adopt content registers the fixture worktree\n'
}

write_json_editor() {
  local path="$1" expression="$2"
  printf '#!/usr/bin/env bash\ntmp="$1.tmp"\njq %q "$1" >"$tmp"\nmv "$tmp" "$1"\n' "$expression" >"$path"
  chmod +x "$path"
}

run_from_unrelated_directory() {
  local directory="$1"
  shift
  mkdir -p "$directory"
  (cd "$directory" && env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" "$@")
}

scenario_chain_content_contracts() {
  local state="$work/chain-content-state" output editor
  mkdir -p "$state/codex" "$work/unrelated-chain"

  output="$(run_from_unrelated_directory "$work/unrelated-chain" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_CODEX_SESSIONS_DIR="$state/codex" "$root/.build/megabrain" chain list --json)"
  assert_json "$output" '.chains | length == 0 and .[0] == null'
  printf 'chain list content is produced by the compiled command\n'

  output="$(run_from_unrelated_directory "$work/unrelated-chain" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_CODEX_SESSIONS_DIR="$state/codex" "$root/.build/megabrain" chain limits --json)"
  assert_json "$output" 'length == 6 and all(.[]; .status == "unknown")'
  printf 'chain limits content is produced by the compiled command\n'

  rm -f "$state/chains.json"
  output="$(run_from_unrelated_directory "$work/unrelated-chain" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" chain add added --when '{"parentAgent":"codex"}' --steps '[{"agent":"codex","model":"gpt-6-astra","effort":"medium"}]' --json)"
  assert_json "$output" '.name == "added" and .steps[0].model == "gpt-6-astra"'
  assert_json "$(cat "$state/chains.json")" '.chains.added.steps[0].agent == "codex"'
  printf 'chain add content is produced by the compiled command\n'

  editor="$work/chain-editor"
  write_json_editor "$editor" '.chains.added.steps[0].effort = "high"'
  output="$(run_from_unrelated_directory "$work/unrelated-chain" MEGABRAIN_STATE_DIR="$state" EDITOR="$editor" "$root/.build/megabrain" chain edit added --json)"
  assert_json "$output" '.name == "added" and .changed == true and .steps[0].effort == "high"'
  printf 'chain edit content is produced by the compiled command\n'

  output="$(run_from_unrelated_directory "$work/unrelated-chain" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" chain repair added --step 1 --model gpt-5.6-luna --effort medium --json)"
  assert_json "$output" '.repaired == true and .value.model == "gpt-5.6-luna" and .value.effort == "medium"'
  printf 'chain repair content is produced by the compiled command\n'

  output="$(run_from_unrelated_directory "$work/unrelated-chain" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" chain delete added --json)"
  assert_json "$output" '.deleted == true and .name == "added"'
  assert_json "$(cat "$state/chains.json")" '.chains | length == 0'
  printf 'chain delete content is produced by the compiled command\n'
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
  output="$(env -i HOME="$work/home" PATH="$bin:$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
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
  output="$(env -i HOME="$work/home" PATH="$bin:$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_TERMINAL_MODE=identity "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'any(.[]; .terminalId == "terminal-unverified" and .status == "unknown") and any(.[]; .terminalId == "terminal-proven" and .status == "alive")'
  output="$(env -i HOME="$work/home" PATH="$bin:$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_TERMINAL_MODE=dead "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'any(.[]; .terminalId == "terminal-proven" and .status == "dead")'
  output="$(env -i HOME="$work/home" PATH="$bin:$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_TERMINAL_MODE=stale "$root/.build/megabrain" terminal list --json)"
  assert_json "$output" 'all(.[]; .status == "stale")'
  printf 'terminal list content distinguishes identity mismatch, dead, and stale terminals\n'
}

scenario_terminal_list_rejects_subdirectory_selector() {
  local repo="$work/terminal-selector-repo" subdir="$work/terminal-selector-repo/apps/web" state="$work/terminal-selector-state" output status
  mkdir -p "$subdir" "$state"
  setup_repo "$repo"
  set +e
  output="$(env -i HOME="$work/home" PATH="$node_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
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
  output="$(MEGABRAIN_STATE_DIR="$work/falsification-state-$name" "$fixture/.build/megabrain" "$@" 2>"$work/falsification-$name.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  [ "$output" != "$expected" ] || fail "$name contract stayed green with a broken compiled implementation"
  assert_equal "$output" BROKEN
  printf '%s falsification is RED: compiled output BROKEN is rejected\n' "$name"
}

scenario_removed_route_falsification() {
  local name="$1" implementation_name="$2" expected="$3" fixture="$work/falsification-removed-$1" output status
  shift 3
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" BROKEN
  set +e
  output="$(env "$implementation_name=shell" MEGABRAIN_STATE_DIR="$work/falsification-removed-state-$name" "$fixture/.build/megabrain" "$@" 2>"$work/falsification-removed-$name.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" BROKEN
  [ "$output" != "$expected" ] || fail "$name contract stayed green with a broken compiled implementation"
  printf '%s falsification remains RED after shell deletion\n' "$name"
}

scenario_worktree_list_falsification() {
  local fixture="$work/falsification-removed-worktree-list" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" BROKEN
  set +e
  output="$(env MEGABRAIN_WORKTREE_LIST_IMPLEMENTATION=binary \
    MEGABRAIN_STATE_DIR="$work/falsification-removed-worktree-list-state" \
    "$fixture/.build/megabrain" worktree list --json 2>"$work/falsification-removed-worktree-list.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" BROKEN
  printf 'worktree-list falsification remains RED after shell deletion\n'
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
scenario_worktree_list_route_marker
scenario_worktree_write_route_marker
scenario_spawn_route_marker
scenario_removed_route_falsification queue-ask MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION '{"verb":"ask"}' ask route-question
scenario_removed_route_falsification queue-received MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION '{"verb":"received"}' received
scenario_removed_route_falsification queue-done MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION '{"verb":"done"}' done route-summary
scenario_removed_route_falsification check MEGABRAIN_CHECK_IMPLEMENTATION '{"verb":"check"}' check --timeout 0 --json
scenario_removed_route_falsification reply MEGABRAIN_ORCHESTRATE_REPLY_IMPLEMENTATION '{"verb":"reply"}' orchestrate reply route-dispatch --text route-answer --json
scenario_removed_route_falsification read MEGABRAIN_ORCHESTRATE_READ_IMPLEMENTATION '{"verb":"read"}' orchestrate read route-dispatch --json
scenario_removed_route_falsification liveness MEGABRAIN_ORCHESTRATE_LIVENESS_IMPLEMENTATION '{"verb":"liveness"}' orchestrate liveness route-dispatch --json
scenario_removed_route_falsification orchestrate-list MEGABRAIN_ORCHESTRATE_LIST_IMPLEMENTATION '{"verb":"orchestrate-list"}' orchestrate list --json
scenario_removed_route_falsification orchestrate-prune MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION '{"verb":"orchestrate-prune"}' orchestrate prune --dry-run --json
scenario_removed_route_falsification orchestrate-change MEGABRAIN_ORCHESTRATE_CHANGE_IMPLEMENTATION '{"verb":"orchestrate-change"}' orchestrate change route-dispatch --text route-answer --json
scenario_removed_route_falsification orchestrate-close MEGABRAIN_ORCHESTRATE_CLOSE_IMPLEMENTATION '{"verb":"orchestrate-close"}' orchestrate close route-dispatch --json
scenario_removed_route_falsification orchestrate-reconcile MEGABRAIN_ORCHESTRATE_RECONCILE_IMPLEMENTATION '{"verb":"orchestrate-reconcile"}' orchestrate reconcile route-dispatch --json
scenario_removed_route_falsification orchestrate-stop MEGABRAIN_ORCHESTRATE_STOP_IMPLEMENTATION '{"verb":"orchestrate-stop"}' orchestrate stop route-dispatch --json
scenario_falsification_is_red_for_each_route chain-list '{"verb":"chain-list"}' chain list --json
scenario_falsification_is_red_for_each_route chain-limits '{"verb":"chain-limits"}' chain limits --json
scenario_falsification_is_red_for_each_route chain-add '{"verb":"chain-add"}' chain add route --json
scenario_falsification_is_red_for_each_route chain-edit '{"verb":"chain-edit"}' chain edit route --json
scenario_falsification_is_red_for_each_route chain-delete '{"verb":"chain-delete"}' chain delete route --json
scenario_falsification_is_red_for_each_route chain-repair '{"verb":"chain-repair"}' chain repair route --json
scenario_worktree_list_falsification
scenario_compiled_content_contracts
scenario_compiled_argument_forms
scenario_change_reports_actual_interrupt_outcome
scenario_worktree_list_content
scenario_chain_content_contracts
printf 'ok: compiled routes and content contracts cover the active verbs\n'
