#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-runtime.XXXXXX")"

cleanup() {
  rm -rf "$state_root"
}
trap cleanup EXIT

[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}

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

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected '$1' not to contain '$2'" ;;
    *) ;;
  esac
}

# megabrain_resolve_spawn_runtime and megabrain_worktree_create (lib/module-worktree.sh) no
# longer exist anywhere in lib/ (grep: zero hits) — deleted with the worktree/spawn TypeScript
# port. `orchestrate spawn` is a full binary passthrough. A real end-to-end tmux dispatch needs a
# genuine live tmux session (panes, readiness polling), which is out of scope to fabricate here;
# instead these scenarios distinguish the host vs tmux code path by which host command the plan
# attempted next (orca terminal create for host, a tmux pane operation for tmux) before it
# necessarily fails on the fixture's minimal fakes — the routing decision is what is under test,
# not a full successful launch.
repo_dir="$state_root/repo"
shared_dir="$state_root/shared"
mkdir -p "$shared_dir"
git init -q "$repo_dir"
git -C "$repo_dir" config user.email tester@example.com
git -C "$repo_dir" config user.name tester
git -C "$repo_dir" config init.defaultBranch main
printf 'base\n' >"$repo_dir/base.txt"
git -C "$repo_dir" add base.txt
git -C "$repo_dir" commit -qm base

run_spawn() {
  local state="$1"
  shift
  mkdir -p "$state"
  printf '%s\n' "$shared_dir" >"$state/worktree-root"
  # An explicit caller identity is required: without one, orchestrate spawn refuses before it
  # ever reaches the host-vs-tmux routing decision under test here ("cannot launch agent from
  # unknown orchestration host: unknown"). Locally this went unnoticed because the ambient dev
  # environment happens to export ORCA_TERMINAL_HANDLE already; a clean container has neither.
  ORCA_TERMINAL_HANDLE="${ORCA_TERMINAL_HANDLE:-parent-terminal}" MEGABRAIN_STATE_DIR="$state" \
    "$binary" orchestrate spawn --repo "$repo_dir" "$@" --json 2>&1 || true
}

# Scenario: an explicit --tmux flag always wins, regardless of ambient context.
# Falsification: --tmux true attempts a host-only call (orca terminal create) instead of a tmux
# pane operation, or --tmux false does the reverse.
tmux_true_output="$(run_spawn "$state_root/tmux-true" --branch feat/tmux-true --agent codex --model m --prompt p --tmux true)"
assert_contains "$tmux_true_output" tmux
assert_not_contains "$tmux_true_output" 'orca terminal create'
printf 'explicit --tmux true routes to a tmux pane operation, not a host terminal\n'

tmux_false_output="$(run_spawn "$state_root/tmux-false" --branch feat/tmux-false --agent codex --model m --prompt p --tmux false)"
assert_contains "$tmux_false_output" 'orca terminal create'
printf 'explicit --tmux false routes to a host terminal (orca terminal create)\n'

# Scenario: with no --tmux flag, the auto default follows only the tmux-runtime module's
# installed flag in state.json (lib/common.sh's megabrain_runtime_enabled, read by
# lib/module-worktree.sh's megabrain_resolve_spawn_runtime) — never ambient tmux presence alone.
# This replaces an earlier version of this scenario that asserted the opposite (that an active
# TMUX/TMUX_PANE session by itself auto-selects tmux); that was wrong. Verified by extracting the
# actual last-standing shell implementation with `git archive 9d24366^` and running
# `orchestrate spawn` from it directly, outside this repo: with TMUX/TMUX_PANE and
# ORCA_TERMINAL_HANDLE all set and no tmux-runtime install flag in state.json, the real shell
# resolved to host and printed `orca terminal create failed for ...` — ambient tmux never flipped
# it. Only writing `{"tmux-runtime":{"installed":true}}` into that state dir's state.json made the
# same shell take the tmux path instead.
auto_installed_state="$state_root/auto-installed"
mkdir -p "$auto_installed_state"
printf '{"tmux-runtime":{"installed":true}}\n' >"$auto_installed_state/state.json"
auto_installed_output="$(run_spawn "$auto_installed_state" --branch feat/auto-installed --agent codex --model m --prompt p)"
assert_contains "$auto_installed_output" tmux
assert_not_contains "$auto_installed_output" 'orca terminal create'
printf 'omitting --tmux with the tmux-runtime module installed takes the tmux path\n'

auto_absent_state="$state_root/auto-absent"
mkdir -p "$auto_absent_state"
# No state.json at all: the module has never been installed for this state dir. TMUX/TMUX_PANE
# are set here too, to prove ambient tmux presence alone still does not flip the default.
auto_absent_output="$(TMUX=fake-server TMUX_PANE=%1 run_spawn "$auto_absent_state" --branch feat/auto-absent --agent codex --model m --prompt p)"
assert_contains "$auto_absent_output" 'orca terminal create'
printf 'omitting --tmux with the module not installed takes the host path, even from inside tmux\n'

printf 'ok: spawn runtime resolution\n'
