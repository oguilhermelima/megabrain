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
export HOME="$work_dir/home"
export MEGABRAIN_STATE_DIR="$state"
guard_db_state() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  case "$MEGABRAIN_STATE_DIR" in "$HOME/.megabrain"|"$HOME/.megabrain/"*) printf 'FAIL: refusing real HOME database\n' >&2; exit 1 ;; esac
}
guard_db_state
mkdir -p "$state/dispatches/queue/messages" "$state/dispatches/queue/deliveries"
printf '%s\n' '{"dispatchId":"queue","parentSessionId":"parent-terminal","parentHost":"superset","state":"running"}' >"$state/dispatches/queue/meta.json"
printf '%s\n' '{"seq":3,"from":"child","type":"ask","text":"question","createdAt":"2020-01-01T00:00:00Z"}' >"$state/dispatches/queue/messages/0003-child-ask.json"
printf '%s\n' '{"seq":7,"from":"parent","type":"reply","text":"old","createdAt":"2020-01-01T00:00:00Z"}' >"$state/dispatches/queue/messages/0007-parent-reply.json"
printf '%s\n' '{}' >"$state/dispatches/queue/messages/editor-backup.json"
printf '%s\n' '{broken json' >"$state/dispatches/queue/messages/malformed-message.json"

set +e
import_output="$(MEGABRAIN_STATE_DIR="$state" HOME="$HOME" "$root/.build/megabrain" db import "$state" --json 2>&1)"
import_status=$?
set -e
[ "$import_status" -ne 0 ] || fail 'malformed fixture files were not reported'
case "$import_output" in *editor-backup.json*'message requires integer seq'*) ;; *) fail "import did not explain the invalid editor backup: $import_output" ;; esac
case "$import_output" in *malformed-message.json*'Expected property name or '*) ;; *) fail "import did not explain the malformed message: $import_output" ;; esac

set +e
missing_dispatch="$(MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" db show queue --json 2>&1)"
missing_status=$?
set -e
[ "$missing_status" -ne 0 ] || fail 'invalid import partially inserted the dispatch'
case "$missing_dispatch" in *'dispatch not found: queue'*) ;; *) fail "invalid import left an unexpected database state: $missing_dispatch" ;; esac

# A clean import seeds the valid rows. Files created after it, including invalid JSON, are
# outside the database and cannot influence sequence allocation.
mkdir "$work_dir/rejected-import-rows"
mv "$state/dispatches/queue/messages/editor-backup.json" "$work_dir/rejected-import-rows/"
mv "$state/dispatches/queue/messages/malformed-message.json" "$work_dir/rejected-import-rows/"
MEGABRAIN_STATE_DIR="$state" HOME="$HOME" "$root/.build/megabrain" db import "$state" >/dev/null

# The first reply uses max(seq)+1 from the two valid imported message rows.
MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=parent-terminal \
  "$root/.build/megabrain" orchestrate reply queue --text answer >/dev/null
queue="$(MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" db show queue --json)"
[ "$(printf '%s' "$queue" | jq -c '[.messages[].seq]')" = '[3,7,8]' ] || fail 'database allocation did not follow the highest imported sequence'

# Files created after import cannot affect database sequence allocation.
printf '%s\n' 'ignored editor content' >"$state/dispatches/queue/messages/stray-after-import.json"
printf '%s\n' '{"seq":10000,"from":"parent","type":"reply","text":"not imported","createdAt":"2020-01-01T00:00:00Z"}' >"$state/dispatches/queue/messages/10000-parent-reply.json"
MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=parent-terminal \
  "$root/.build/megabrain" orchestrate reply queue --text second-answer >/dev/null
queue="$(MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" db show queue --json)"
[ "$(printf '%s' "$queue" | jq -c '[.messages[].seq]')" = '[3,7,8,9]' ] || fail 'post-import stray files changed database sequence allocation'
[ "$(printf '%s' "$queue" | jq -r '.messages[-1].text')" = second-answer ] || fail 'second reply was not preserved'
printf 'ok: malformed import rows are skipped and stray files cannot affect database sequences\n'
