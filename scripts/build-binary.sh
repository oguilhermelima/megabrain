#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  printf 'build-binary: %s\n' "$*" >&2
  exit "${2:-1}"
}

print_help() {
  cat <<'HELP'
Usage: scripts/build-binary.sh --out <dir> [--target <bun-target>]

Compiles the CLI into one executable that needs no Node, and stages the assets it reads at
runtime beside it:

  <dir>/bin/megabrain
  <dir>/share/megabrain/{package.json, every entry of package.json "files"}

--target is a Bun compile target such as bun-darwin-arm64, bun-darwin-x64, bun-linux-x64 or
bun-linux-arm64. It defaults to the host.
HELP
}

out=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) [ "$#" -ge 2 ] || fail "--out needs a directory" 2; out="$2"; shift 2 ;;
    --target) [ "$#" -ge 2 ] || fail "--target needs a value" 2; target="$2"; shift 2 ;;
    -h|--help) print_help; exit 0 ;;
    *) fail "unknown option $1" 2 ;;
  esac
done
[ -n "$out" ] || fail "--out is required" 2

assets="$out/share/megabrain"
rm -rf "$out/bin" "$assets"
mkdir -p "$out/bin" "$assets"

target_args=()
[ -z "$target" ] || target_args=(--target="$target")
bun build --compile ${target_args[@]+"${target_args[@]}"} "$root/src/cli/index.ts" --outfile "$out/bin/megabrain" >/dev/null
chmod 755 "$out/bin/megabrain"

cp "$root/package.json" "$assets/package.json"
files="$(bun -e 'for (const f of require(process.argv[1]).files) if (f !== ".build/megabrain") console.log(f)' "$root/package.json")"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  entry="${entry%/}"
  [ -e "$root/$entry" ] || fail "package.json lists $entry, which does not exist"
  mkdir -p "$assets/$(dirname "$entry")"
  cp -R "$root/$entry" "$assets/$entry"
done <<< "$files"
