#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then printf 'skip: compiled prune binary is missing; run bun run build\n'; exit 0; fi
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prune-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
make_fixture() { local base="$1"; mkdir -p "$base/state/dispatches/old/messages" "$base/state/dispatches/open" "$base/state/dispatches/future"; printf '%s\n' '{"dispatchId":"old","state":"done","runtime":"tmux","tmuxSession":"missing","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/old/meta.json"; printf '%s\n' '{"text":"survive"}' >"$base/state/dispatches/old/messages/1.json"; printf '%s\n' '{"dispatchId":"open","state":"running","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/open/meta.json"; printf '%s\n' '{"dispatchId":"future","state":"future_state","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/future/meta.json"; }
assert_equal() { local actual="$1" expected="$2" message="$3"; [ "$actual" = "$expected" ] || { printf 'FAIL: %s (expected: %s, got: %s)\n' "$message" "$expected" "$actual" >&2; exit 1; }; }
assert_path() { local path="$1" expected="$2" message="$3" actual=false; [ -e "$path" ] && actual=true; assert_equal "$actual" "$expected" "$message: $path"; }
make_fixture "$work/shell"; make_fixture "$work/binary"
shell="$(MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/shell/state" "$root/megabrain" orchestrate prune --dry-run --json | sed "s#$work/shell#STATE#g")"
binary="$(MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --dry-run --json | sed "s#$work/binary#STATE#g")"
assert_equal "$shell" "$binary" 'shell and binary dry-run output'
assert_path "$work/binary/state/dispatches/old/meta.json" true 'dry-run preserves eligible dispatch'
shell="$(MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/shell/state" "$root/megabrain" orchestrate prune --json | sed "s#$work/shell#STATE#g")"
binary="$(MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --json | sed "s#$work/binary#STATE#g")"
archive="$work/binary/state/dispatches/archive/$(date -u +%Y-%m)"
assert_path "$archive/old/messages/1.json" true 'real archive keeps eligible old dispatch'
assert_path "$work/binary/state/dispatches/open/meta.json" true 'real archive preserves open dispatch'
assert_path "$work/binary/state/dispatches/future/meta.json" true 'real archive preserves unrecognised future dispatch'
assert_path "$archive/open" false 'real archive does not archive open dispatch'
assert_path "$archive/future" false 'real archive does not archive unrecognised future dispatch'
assert_equal "$shell" "$binary" 'shell and binary archive output'
printf 'prune shell and binary agree on dry-run and archive move\n'

make_fixture "$work/shell-delete"; make_fixture "$work/binary-delete"
shell_delete="$(MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/shell-delete/state" "$root/megabrain" orchestrate prune --delete --json | sed "s#$work/shell-delete#STATE#g")"
binary_delete="$(MEGABRAIN_STATE_DIR="$work/binary-delete/state" "$root/.build/megabrain" orchestrate prune --delete --json | sed "s#$work/binary-delete#STATE#g")"
assert_equal "$shell_delete" "$binary_delete" 'shell and binary delete output'
assert_path "$work/binary-delete/state/dispatches/old" false 'delete removes eligible old dispatch'
assert_path "$work/binary-delete/state/dispatches/archive/old" false 'delete leaves no reachable archive for old dispatch'
assert_path "$work/binary-delete/state/dispatches/open/meta.json" true 'delete preserves open dispatch'
assert_path "$work/binary-delete/state/dispatches/future/meta.json" true 'delete preserves unrecognised future dispatch'
assert_path "$work/binary-delete/state/dispatches/archive/open" false 'delete does not archive open dispatch'
assert_path "$work/binary-delete/state/dispatches/archive/future" false 'delete does not archive unrecognised future dispatch'
printf 'prune delete removes only eligible dispatches\n'
