#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled queue binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-stray.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

state="$work_dir/state"
mkdir -p "$state/dispatches/queue/messages" "$state/dispatches/queue/deliveries"
printf '%s\n' '{"dispatchId":"queue","parentSessionId":"parent-terminal","parentHost":"superset","state":"running"}' >"$state/dispatches/queue/meta.json"
printf '%s\n' '{"seq":3,"from":"child","type":"ask","text":"question","createdAt":"2020-01-01T00:00:00Z"}' >"$state/dispatches/queue/messages/0003-child-ask.json"
printf '%s\n' '{"seq":7,"from":"parent","type":"reply","text":"old","createdAt":"2020-01-01T00:00:00Z"}' >"$state/dispatches/queue/messages/0007-parent-reply.json"
printf '%s\n' '{}' >"$state/dispatches/queue/messages/editor-backup.json"
printf '%s\n' '{broken json' >"$state/dispatches/queue/messages/malformed-message.json"

set +e
import_output="$("$root/.build/megabrain" db import "$state" --json 2>&1)"
import_status=$?
set -e
[ "$import_status" -ne 0 ] || fail 'malformed fixture files were not reported'
case "$import_output" in *editor-backup.json*'message requires integer seq'*'malformed-message.json'*'Expected property name or '*) ;; *) fail "import did not explain both skipped files: $import_output" ;; esac

# Only the two valid message rows were imported. The first reply uses max(seq)+1.
MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=parent-terminal \
  "$root/.build/megabrain" orchestrate reply queue --text answer >/dev/null
queue="$(MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" db show queue --json)"
[ "$(printf '%s' "$queue" | jq '[.messages[].seq]')" = '[3,7,8]' ] || fail 'database allocation did not follow the highest imported sequence'

# Files created after import cannot affect database sequence allocation.
printf '%s\n' 'ignored editor content' >"$state/dispatches/queue/messages/stray-after-import.json"
printf '%s\n' '{"seq":10000,"from":"parent","type":"reply","text":"not imported","createdAt":"2020-01-01T00:00:00Z"}' >"$state/dispatches/queue/messages/10000-parent-reply.json"
MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=parent-terminal \
  "$root/.build/megabrain" orchestrate reply queue --text second-answer >/dev/null
queue="$(MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" db show queue --json)"
[ "$(printf '%s' "$queue" | jq '[.messages[].seq]')" = '[3,7,8,9]' ] || fail 'post-import stray files changed database sequence allocation'
[ "$(printf '%s' "$queue" | jq -r '.messages[-1].text')" = second-answer ] || fail 'second reply was not preserved'
printf 'ok: malformed import rows are skipped and stray files cannot affect database sequences\n'
