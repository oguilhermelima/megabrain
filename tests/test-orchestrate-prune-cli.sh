#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then printf 'skip: compiled prune binary is missing; run bun run build\n'; exit 0; fi
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prune-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
make_fixture() { local base="$1"; mkdir -p "$base/state/dispatches/old/messages" "$base/state/dispatches/open" "$base/state/dispatches/future"; printf '%s\n' '{"dispatchId":"old","state":"done","runtime":"tmux","tmuxSession":"missing","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/old/meta.json"; printf '%s\n' '{"text":"survive"}' >"$base/state/dispatches/old/messages/1.json"; printf '%s\n' '{"dispatchId":"open","state":"running","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/open/meta.json"; printf '%s\n' '{"dispatchId":"future","state":"future_state","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/future/meta.json"; }
make_fixture "$work/shell"; make_fixture "$work/binary"
shell="$(MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/shell/state" "$root/megabrain" orchestrate prune --dry-run --json | sed "s#$work/shell#STATE#g")"
binary="$(MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --dry-run --json | sed "s#$work/binary#STATE#g")"
[ "$shell" = "$binary" ] || { printf 'FAIL: shell and binary dry-run differ\n' >&2; exit 1; }
[ -f "$work/binary/state/dispatches/old/meta.json" ] || exit 1
shell="$(MEGABRAIN_ORCHESTRATE_PRUNE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/shell/state" "$root/megabrain" orchestrate prune --json | sed "s#$work/shell#STATE#g")"
binary="$(MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --json | sed "s#$work/binary#STATE#g")"
[ "$shell" = "$binary" ] || { printf 'FAIL: shell and binary archive differ\n' >&2; exit 1; }
[ -f "$work/binary/state/dispatches/archive/$(date -u +%Y-%m)/old/messages/1.json" ] || exit 1
printf 'prune shell and binary agree on dry-run and archive move\n'
