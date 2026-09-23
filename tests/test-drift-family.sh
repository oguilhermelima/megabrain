#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-drift-family.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected path to be absent: $1"
}

installer_source="$work/install-functions.sh"
sed '$d' "$root/install.sh" >"$installer_source"
# shellcheck disable=SC1090
source "$installer_source"
SOURCE_ROOT="$root"

pointer_file="$work/AGENTS.md"
printf '%s\n' '# megabrain recipes (old)' >"$pointer_file"
installer_append_pointer "$pointer_file" '# megabrain recipes (new)' >/dev/null
assert_equal "$(grep -Fxc '# megabrain recipes (old)' "$pointer_file")" 0
assert_equal "$(grep -Fxc '# megabrain recipes (new)' "$pointer_file")" 1
printf 'scenario 1: changed AGENTS pointer replaces the old generated line\n'

agy() {
  case "${1:-}:${2:-}" in
    plugin:list) jq -n '{imports:[{name:"megabrain",source:"claude-code",components:["skills"]}]}' ;;
    *) return 1 ;;
  esac
}
if ! installer_verify_plugin agy; then
  fail 'matching agy import metadata was reported stale'
fi
agy() {
  jq -n '{imports:[{name:"megabrain",source:"other",components:["skills"]}]}'
}
if installer_verify_plugin agy; then
  fail 'drifted agy import source was reported current'
fi
printf 'scenario 2: agy plugin validates import source and components\n'

chain_state="$work/chain-state"
mkdir -p "$chain_state"
chain_file="$chain_state/chains.json"
printf '%s\n' '{"chains":{},"defaultSteps":[],"usageLimits":{"liveProviders":["claude"],"notice":{"enabled":true}}}' >"$chain_file"
# megabrain_chain_init (lib/module-chain.sh) is gone from the reachable call graph: command_chain
# execs the binary unconditionally for every subcommand (verified, no shell fallback whatsoever),
# so this drives the compiled binary's own reconciliation instead. readConfig
# (src/cli/commands/chain.ts) rewrites the same defaults into the chain file on read, which
# `chain list` exercises for free.
MEGABRAIN_STATE_DIR="$chain_state" MEGABRAIN_CHAIN_FILE="$chain_file" "$root/.build/megabrain" chain list --json >/dev/null
assert_equal "$(jq -r '.usageLimits.cacheTtlSeconds' "$chain_file")" 30
assert_equal "$(jq -r '.usageLimits.timeoutSeconds' "$chain_file")" 5
assert_equal "$(jq -r '.usageLimits.notice.intervalSeconds' "$chain_file")" 3600
assert_equal "$(jq -r '.usageLimits.notice.enabled' "$chain_file")" true
printf 'scenario 3: chain list reconciles newly seeded usage-limit fields into the chain file\n'

# WHY: scenario 4 ("malformed session registry makes tmux doctor non-ok") is deleted, not
# rewritten. It drove megabrain_tmux_session_registry_drift and module_tmux_runtime_doctor,
# both removed once install routed to the binary (module_tmux_runtime_doctor was reachable
# only through the deleted shell install path; megabrain_tmux_session_registry_drift's only
# caller was that doctor, so it had no remaining production caller either). Unlike the other
# scenarios ported off deleted shell functions in this lane, this one has no binary equivalent
# to redirect to: the compiled doctor's tmux-runtime report (src/cli/commands/install-doctor.ts)
# checks tuning/wrapper block state, enabled state, and running-server state, but never reads
# the tmux session registry at all, so a malformed registry record cannot be shown to change its
# output. This is a real, pre-existing coverage gap in already-merged TypeScript (not introduced
# by this lane, and not fixed here — DECIDED scoped this lane to `install`, reusing the existing
# doctor for detection rather than extending it), surfaced by this migration and reported rather
# than silently dropped.

manifest="$work/install-manifest.json"
INSTALL_MANIFEST="$manifest"
SELECTED_AGENTS=claude
SELECTED_MODULES=tmux-runtime
SKILL_MODE=global
AGENTS_MODE=global
jq -n '{agents:["codex"],modules:["tmux-runtime"],skill:"global",agentsMd:"global"}' >"$manifest"
if installer_manifest_matches_selection; then
  fail 'drifted install manifest was reported current'
fi
printf '%s\n' '{"agents":["claude"],"modules":["tmux-runtime"],"skill":"global","agentsMd":"global"}' >"$manifest"
if ! installer_manifest_matches_selection; then
  fail 'matching install manifest was reported stale'
fi
printf 'scenario 5: install manifest compares selected configuration fields\n'

# megabrain_dispatch_reconcile_one (lib/module-orchestrate.sh) has no production caller left
# (orchestrate reconcile already execs the binary unconditionally), so this drives
# `orchestrate reconcile`/`orchestrate prune` on the compiled binary instead, with a fake tmux on
# PATH standing in for "this terminal no longer exists" (has-session refuses every session).
dispatch_state="$work/dispatch-state"
dispatch_dir="$dispatch_state/dispatches"
tmux_missing_bin="$work/tmux-missing-bin"
mkdir -p "$tmux_missing_bin"
cat >"$tmux_missing_bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  has-session) exit 1 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmux_missing_bin/tmux"

write_scenario6_meta() {
  local dispatch_id="$1" state="$2" process_state="$3" terminal_state="$4" dir="$dispatch_dir/$1"
  mkdir -p "$dir/messages" "$dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" --arg state "$state" \
    --arg processState "$process_state" --arg terminalState "$terminal_state" '{
    dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "superset",
    childHost: "superset", workspaceId: "workspace", terminalId: "child-terminal",
    worktreePath: $worktreePath, branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", modelHonored: true, label: "label", state: $state,
    processState: $processState, terminalState: $terminalState,
    runtime: "tmux", spawnRuntime: "tmux", tmuxSession: $dispatchId, tmuxPane: "%99",
    createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dir/meta.json"
}

write_scenario6_meta missing-terminal running start-unproven retained
reconcile_result="$(env PATH="$tmux_missing_bin:$PATH" MEGABRAIN_STATE_DIR="$dispatch_state" \
  "$root/.build/megabrain" orchestrate reconcile missing-terminal --json)"
assert_equal "$(printf '%s' "$reconcile_result" | jq -r '.terminalState')" missing
assert_equal "$(printf '%s' "$reconcile_result" | jq -r '.state')" failed
# reconcile just stamped updatedAt to now; backdate it again so prune's age check treats this
# record as old debris rather than a fresh change.
jq '.updatedAt = "2020-01-01T00:00:00Z"' "$dispatch_dir/missing-terminal/meta.json" >"$work/missing-terminal.json"
mv "$work/missing-terminal.json" "$dispatch_dir/missing-terminal/meta.json"

write_scenario6_meta running-live running running owned
dry_run="$(env PATH="$tmux_missing_bin:$PATH" MEGABRAIN_STATE_DIR="$dispatch_state" \
  "$root/.build/megabrain" orchestrate prune --dry-run --json)"
assert_equal "$(jq -r '.archived' <<<"$dry_run")" 1
assert_equal "$(jq -r '.dryRun' <<<"$dry_run")" true
assert_contains "$dry_run" 'missing-terminal'
assert_missing "$dispatch_dir/archive"
assert_equal "$(jq -r '.state' "$dispatch_dir/running-live/meta.json")" running
printf 'scenario 6: reconcile settles missing terminals, dry-run lists only terminal debris, and running stays\n'

printf 'ok: drift family scenarios\n'
