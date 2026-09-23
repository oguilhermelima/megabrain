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
  MEGABRAIN_STATE_DIR="$state" "$binary" orchestrate spawn --repo "$repo_dir" "$@" --json 2>&1 || true
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

# FINDING (rule 4, not a test defect — did not touch src/, did not weaken the assertion): the
# shell's megabrain_resolve_spawn_runtime auto-detected the runtime when --tmux was omitted (read
# the tmux-runtime module's installed flag from state.json, checked tmux availability, and
# detected an already-managed tmux pane), so a spawn issued from inside a live tmux session picked
# up "tmux" automatically. The port's runtime decision (orchestrate-spawn.ts:475) is:
# `options.tmux ?? (environment.MEGABRAIN_SPAWN_RUNTIME === "tmux") ? "tmux" : "host"` — and
# MEGABRAIN_SPAWN_RUNTIME is never set anywhere in the whole codebase (grep across src/, lib/,
# megabrain: only that one read site). So omitting --tmux always resolves to "host" now, even from
# inside an active tmux pane: this assertion expects a tmux pane operation and gets a host
# terminal attempt instead. Left failing on purpose; the lead decides whether auto-detection needs
# to come back or --tmux is meant to be required going forward.
auto_output="$(TMUX=fake-server TMUX_PANE=%1 run_spawn "$state_root/auto" --branch feat/auto --agent codex --model m --prompt p)"
assert_not_contains "$auto_output" 'orca terminal create'
printf 'omitting --tmux from an active tmux pane still auto-detects the tmux runtime\n'

printf 'ok: spawn runtime resolution (one open finding, see report)\n'
