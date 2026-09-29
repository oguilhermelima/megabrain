#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-db-cutover.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
binary="$root/.build/megabrain"

fail() { printf 'not ok: %s\n' "$1" >&2; exit 1; }
assert_marker() {
  local state="$1" expected="$2"
  NODE_NO_WARNINGS=1 node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("cutover"); let marker; try { marker = JSON.parse(row?.value ?? "{}"); } catch {} if (marker?.method !== process.argv[2]) process.exit(1);' "$state/megabrain.db" "$expected"
}
assert_no_marker() {
  local state="$1"
  NODE_NO_WARNINGS=1 node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("cutover"); if (row !== undefined) process.exit(1);' "$state/megabrain.db" || fail 'unexpected cutover marker'
}
fixture() {
  local state="$1" id="${2:-fixture}"
  mkdir -p "$state/dispatches/$id/messages" "$state/dispatches/$id/deliveries"
  cat >"$state/dispatches/$id/meta.json" <<JSON
{"dispatchId":"$id","state":"running","parentSessionId":"parent"}
JSON
  cat >"$state/dispatches/$id/messages/0001.json" <<'JSON'
{"seq":1,"from":"child","type":"received","text":"ready","createdAt":"2026-09-01T00:00:00.000Z"}
JSON
  printf 'transcript for %s\n' "$id" >"$state/dispatches/$id/transcript"
}
run_normal() {
  local state="$1"
  require_megabrain_test_state "$state"
  MEGABRAIN_STATE_DIR="$state" "$binary" orchestrate list --all --json
}

# Fresh state is sealed without creating legacy state.
fresh="$tmp/fresh"
require_megabrain_test_state "$fresh"
MEGABRAIN_STATE_DIR="$fresh" "$binary" orchestrate list --all --json >/dev/null
assert_marker "$fresh" auto || fail 'fresh state did not get an automatic marker'
[ ! -e "$fresh/legacy" ] || fail 'fresh state created a legacy snapshot'
printf 'ok: fresh state receives only the cutover marker\n'

# The first ordinary command imports, moves transcripts, seals JSON, and the next is a no-op.
legacy="$tmp/legacy"
fixture "$legacy" live-fixture
mkdir -p "$legacy/dispatches/archive/2026-08/archived-fixture/messages"
cat >"$legacy/dispatches/archive/2026-08/archived-fixture/meta.json" <<'JSON'
{"dispatchId":"archived-fixture","state":"done","parentSessionId":"parent"}
JSON
printf 'archived transcript\n' >"$legacy/dispatches/archive/2026-08/archived-fixture/transcript"
run_normal "$legacy" >"$tmp/list-one.json" 2>"$tmp/migration.err"
snapshot="$(find "$legacy/legacy" -mindepth 1 -maxdepth 1 -type d -name 'json-*' -print -quit)"
[ -n "$snapshot" ] || fail 'legacy JSON was not sealed'
[ -f "$legacy/transcripts/live-fixture.txt" ] || fail 'live transcript was not moved'
[ -f "$legacy/transcripts/archived-fixture.txt" ] || fail 'archived transcript was not moved'
grep -q "migrated legacy JSON state.*$(basename "$snapshot")" "$tmp/migration.err" || fail 'automatic migration did not report its snapshot path'
assert_marker "$legacy" auto || fail 'automatic marker missing after migration'
MEGABRAIN_STATE_DIR="$legacy" "$binary" db show live-fixture --json | jq -e '.meta.dispatchId == "live-fixture" and .messages[0].text == "ready"' >/dev/null
run_normal "$legacy" >/dev/null 2>"$tmp/second.err"
if grep -q 'migrated legacy JSON state' "$tmp/second.err"; then fail 'second command repeated cutover output'; fi
printf 'ok: first command migrates, moves transcripts and seals live and archived state\n'

# A malformed message is a parity failure: no dispatch commit and no file mutation/seal.
bad="$tmp/bad"
fixture "$bad" bad-fixture
printf '{"seq":2,"from":"child","type":"reply","createdAt":"2026-09-01T00:01:00.000Z"}\n' >"$bad/dispatches/bad-fixture/messages/0002.json"
before="$(find "$bad/dispatches" -type f -print0 | sort -z | xargs -0 shasum | shasum | awk '{print $1}')"
if run_normal "$bad" >"$tmp/bad.out" 2>"$tmp/bad.err"; then fail 'parity mismatch unexpectedly succeeded'; fi
grep -q 'migration-report-' "$tmp/bad.err" || fail 'parity failure did not name its report'
after="$(find "$bad/dispatches" -type f -print0 | sort -z | xargs -0 shasum | shasum | awk '{print $1}')"
[ "$before" = "$after" ] || fail 'parity mismatch changed legacy files'
[ ! -d "$bad/legacy" ] || fail 'parity mismatch sealed legacy state'
assert_no_marker "$bad" || fail 'parity mismatch set marker'
printf 'ok: parity mismatch leaves legacy files and database state uncommitted\n'

# Two independent processes converge on one snapshot.
concurrent="$tmp/concurrent"
fixture "$concurrent" concurrent-fixture
require_megabrain_test_state "$concurrent"
MEGABRAIN_STATE_DIR="$concurrent" "$binary" orchestrate list --all --json >"$tmp/concurrent-a.json" 2>"$tmp/concurrent-a.err" & p1=$!
MEGABRAIN_STATE_DIR="$concurrent" "$binary" orchestrate list --all --json >"$tmp/concurrent-b.json" 2>"$tmp/concurrent-b.err" & p2=$!
rc1=0; wait "$p1" || rc1=$?
rc2=0; wait "$p2" || rc2=$?
if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ]; then cat "$tmp/concurrent-a.err" "$tmp/concurrent-b.err" >&2; fail "concurrent command failed ($rc1, $rc2)"; fi
[ "$(find "$concurrent/legacy" -mindepth 1 -maxdepth 1 -type d -name 'json-*' | wc -l | tr -d ' ')" = 1 ] || fail 'concurrent startup created more than one snapshot'
assert_marker "$concurrent" auto || fail 'concurrent startup did not set marker'
printf 'ok: concurrent startup performs one cutover\n'

# Explicit import seals the fixture against automatic migration.
imported="$tmp/imported"
fixture "$imported" explicit-fixture
require_megabrain_test_state "$imported"
MEGABRAIN_STATE_DIR="$imported" "$binary" db import "$imported" --json >/dev/null
assert_marker "$imported" import || fail 'db import did not set marker'
MEGABRAIN_STATE_DIR="$imported" "$binary" orchestrate list --all --json >/dev/null
[ -f "$imported/dispatches/explicit-fixture/meta.json" ] || fail 'db import fixture was automatically sealed'
printf 'ok: explicit import marks the state and preserves fixture files\n'

# Dry run is read-only and explicit migrate refuses a sealed store.
dry="$tmp/dry"
fixture "$dry" dry-fixture
require_megabrain_test_state "$dry"
before="$(find "$dry" -type f -print0 | sort -z | xargs -0 shasum | shasum | awk '{print $1}')"
MEGABRAIN_STATE_DIR="$dry" "$binary" db migrate --dry-run --json >"$tmp/dry.json"
after="$(find "$dry" -type f -print0 | sort -z | xargs -0 shasum | shasum | awk '{print $1}')"
[ "$before" = "$after" ] || fail 'dry run changed files'
MEGABRAIN_STATE_DIR="$dry" "$binary" db migrate --json >/dev/null
if MEGABRAIN_STATE_DIR="$dry" "$binary" db migrate --json >"$tmp/refuse.out" 2>"$tmp/refuse.err"; then fail 'explicit migrate accepted an existing marker'; fi
grep -qi 'already.*migrat\|marker.*set' "$tmp/refuse.err" || fail 'refusal did not say migration was already done'
printf 'ok: dry run is read-only and migrate refuses an existing marker\n'

# The database and its backup are private to the current user.
mode_state="$tmp/modes"
require_megabrain_test_state "$mode_state"
MEGABRAIN_STATE_DIR="$mode_state" "$binary" orchestrate list --all --json >/dev/null
MEGABRAIN_STATE_DIR="$mode_state" "$binary" db backup --json >/dev/null
[ "$(stat -c '%a' "$mode_state/megabrain.db" 2>/dev/null || stat -f '%Lp' "$mode_state/megabrain.db")" = 600 ] || fail 'database mode is not 600'
backup_file="$(find "$mode_state/backups" -type f -name '*.db' -print -quit)"
[ -n "$backup_file" ] || fail 'backup was not created'
[ "$(stat -c '%a' "$backup_file" 2>/dev/null || stat -f '%Lp' "$backup_file")" = 600 ] || fail 'backup mode is not 600'
printf 'ok: database and backup modes are 600\n'
