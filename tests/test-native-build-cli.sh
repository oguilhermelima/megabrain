#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-build-cli.XXXXXX")"
trap 'rm -rf "$work"; [ -e "$root/megabrain.native-build-shell" ] && mv "$root/megabrain.native-build-shell" "$root/megabrain"' EXIT

shell_output="$(MEGABRAIN_NATIVE_IMPLEMENTATION=shell MEGABRAIN_NATIVE_WORKTREE="$work" "$root/megabrain" native build tv 2>&1)" || shell_status=$?
shell_status="${shell_status:-0}"
[ "$shell_status" -eq 1 ] || { printf 'shell native build status was %s\n' "$shell_status" >&2; exit 1; }
case "$shell_output" in
  *"app path is required for tv; pass surfaces.tv.appPath in .megabrain/native.json"*) ;;
  *) printf 'shell native build refusal was not explicit: %s\n' "$shell_output" >&2; exit 1 ;;
esac

mv "$root/megabrain" "$root/megabrain.native-build-shell"
cat >"$root/megabrain" <<'EOF'
#!/usr/bin/env bash
exit 99
EOF
chmod +x "$root/megabrain"
binary_output="$(MEGABRAIN_NATIVE_WORKTREE="$work" "$root/.build/megabrain" native build tv 2>&1)" || binary_status=$?
binary_status="${binary_status:-0}"
[ "$binary_status" -eq 1 ] || { printf 'binary native build status was %s\n' "$binary_status" >&2; exit 1; }
case "$binary_output" in
  *"app path is required for tv; pass surfaces.tv.appPath in .megabrain/native.json"*) ;;
  *) printf 'binary native build refusal was not explicit: %s\n' "$binary_output" >&2; exit 1 ;;
esac

printf 'native build reaches shell and binary independently\n'
