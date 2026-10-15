#!/usr/bin/env bash

# Builds the megabrain CLI from this repository and stages it where Tauri bundles it:
#   src-tauri/binaries/megabrain-cli-<target triple>  the sidecar (bundle.externalBin)
#   src-tauri/binaries/share/megabrain/               its assets (bundle.resources), which the CLI
#                                                     finds at ../Resources/megabrain in the app bundle
# The sidecar is not named plain megabrain because Tauri copies both the sidecar and the resource
# folder into target/<profile>/ in development, where the two names would collide.
# TAURI_ENV_TARGET_TRIPLE, set by `tauri build --target`, picks the triple; the host otherwise.

set -euo pipefail

app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo="$(cd "$app/../.." && pwd -P)"
binaries="$app/src-tauri/binaries"

triple="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$triple" in
  aarch64-apple-darwin) bun_target=bun-darwin-arm64 ;;
  x86_64-apple-darwin) bun_target=bun-darwin-x64 ;;
  x86_64-unknown-linux-gnu) bun_target=bun-linux-x64 ;;
  aarch64-unknown-linux-gnu) bun_target=bun-linux-arm64 ;;
  *) printf 'stage-cli: no bun target for %s\n' "$triple" >&2; exit 2 ;;
esac

stage="$binaries/.stage"
bash "$repo/scripts/build-binary.sh" --out "$stage" --target "$bun_target"
rm -rf "$binaries/share"
mkdir -p "$binaries/share"
mv "$stage/share/megabrain" "$binaries/share/megabrain"
rm -f "$binaries/megabrain-$triple"
mv "$stage/bin/megabrain" "$binaries/megabrain-cli-$triple"
rm -rf "$stage"
printf 'stage-cli: %s\n' "$binaries/megabrain-cli-$triple"
