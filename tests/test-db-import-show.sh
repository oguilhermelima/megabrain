#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-db-import-show.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$tmp/.megabrain-test-state"
require_megabrain_test_state

trap 'rm -rf "$tmp"' EXIT
export MEGABRAIN_STATE_DIR="$tmp/state"
binary="$root/.build/megabrain"

mkdir -p "$tmp/source/dispatches/fixture/messages" "$tmp/source/dispatches/fixture/deliveries"
cat > "$tmp/source/dispatches/fixture/meta.json" <<'JSON'
{"dispatchId":"fixture","state":"running","parentSessionId":"parent"}
JSON
cat > "$tmp/source/dispatches/fixture/messages/0001.json" <<'JSON'
{"seq":1,"from":"child","type":"received","text":"ready","createdAt":"2026-09-01T00:00:00.000Z"}
JSON
cat > "$tmp/source/dispatches/fixture/deliveries/delivery.json" <<'JSON'
{"id":"delivery","dispatchId":"fixture","messageSeqs":[1],"status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}
JSON

"$binary" db import "$tmp/source" --json > "$tmp/import.json"
"$binary" db show fixture --json > "$tmp/show.json"
jq -e '.imported.dispatches == 1 and .imported.messages == 1 and .imported.deliveries == 1' "$tmp/import.json" >/dev/null
jq -e '.meta.dispatchId == "fixture" and .messages[0].text == "ready" and .deliveries[0].id == "delivery" and .archived == false' "$tmp/show.json" >/dev/null
printf 'ok: db import and db show preserve the fixture shape\n'
