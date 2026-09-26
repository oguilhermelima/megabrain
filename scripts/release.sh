#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
package_manifest="$root/package.json"

fail() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

print_help() {
  cat <<'HELP'
Usage: scripts/release.sh v<version>

Update the private package version in package.json. Publishing is handled separately.
HELP
}

if [ "${1:-}" = -h ] || [ "${1:-}" = --help ]; then
  print_help
  exit 0
fi

[ "$#" -eq 1 ] || fail 'usage: scripts/release.sh v<version>'
case "$1" in
  v[0-9]*.[0-9]*.[0-9]*) version="${1#v}" ;;
  *) fail 'version must use v<major>.<minor>.<patch>' ;;
esac
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'version must use v<major>.<minor>.<patch>'

node --input-type=module - "$package_manifest" "$version" <<'NODE'
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const [path, version] = process.argv.slice(2);
let metadata;
try {
  metadata = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`release: could not read package metadata: ${error.message}`);
  process.exit(1);
}
if (metadata.name !== "megabrain" || metadata.private !== true) {
  console.error("release: expected the private megabrain package");
  process.exit(1);
}
const previous = metadata.version;
if (previous === version) {
  console.error(`release: package version is already ${version}`);
  process.exit(1);
}
metadata.version = version;
const temporary = `${path}.${process.pid}.tmp`;
try {
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: statSync(path).mode & 0o777 });
  renameSync(temporary, path);
} catch (error) {
  try { unlinkSync(temporary); } catch {}
  console.error(`release: could not update package metadata: ${error.message}`);
  process.exit(1);
}
console.log(`package version: ${previous} -> ${version}`);
NODE
