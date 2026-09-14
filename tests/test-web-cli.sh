#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled web binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-web-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/node" <<'NODE'
#!/bin/sh
shift
printf '%s\n' "$*"
NODE
chmod +x "$work/bin/node"

compare() {
  name="$1"
  shift
  shell_output="$(env MEGABRAIN_WEB_IMPLEMENTATION=shell PATH="$work/bin:/usr/bin:/bin" "$root/megabrain" "$@" 2>&1 || true)"
  binary_output="$(env PATH="$work/bin:/usr/bin:/bin" "$root/.build/megabrain" "$@" 2>&1 || true)"
  [ "$shell_output" = "$binary_output" ] || { printf 'FAIL: %s: shell=%s binary=%s\n' "$name" "$shell_output" "$binary_output" >&2; exit 1; }
  printf '%s agrees between shell and binary\n' "$name"
}

compare devices web devices list
compare devices-filter web devices iphone15 --orientation landscape
compare viewport-set web viewport set --browser chromium --width 390 --height 844
compare userscript web userscript install hello.user.js --device iphone15
compare visual web capture --url https://example.com --screen home
compare invalid web devices list --json
printf 'ok: web implementations agree across CLI scenarios\n'
