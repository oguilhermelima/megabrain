#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
result="$("$root/.build/megabrain" orchestrate adopt any-dispatch --json)"
[[ "$result" == *"deprecated"* && "$result" == *"no longer needed"* ]] || {
  printf 'FAIL: adopt did not print its deprecation note: %s\n' "$result" >&2
  exit 1
}
printf 'orchestrate adopt remains a deprecated no-op\n'
