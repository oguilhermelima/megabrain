#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled chain binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain-writes.XXXXXX")"
binary="$root/.build/megabrain"
trap 'rm -rf "$work"' EXIT
export MEGABRAIN_ROOT="$root"
source "$root/tests/fixtures/entrypoint-routing.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

make_fixture() {
  local state="$1"
  mkdir -p "$state"
  if [[ "$state" == *malformed* ]]; then
    printf '{"chains":' >"$state/chains.json"
    return
  fi
  printf '%s' '{"chains":{"existing":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"gpt-5.6-luna","effort":"medium"}]}},"defaultSteps":[{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}' >"$state/chains.json"
}

run_capture() {
  local side="$1" state="$2" out="$3" err="$4"; shift 4
  local status
  if [ "$side" = shell ]; then
    if env MEGABRAIN_STATE_DIR="$state" HOME="$state/home" MEGABRAIN_CHAIN_IMPLEMENTATION=shell "$root/.build/megabrain" "$@" >"$out" 2>"$err"; then status=0; else status=$?; fi
  else
    if env MEGABRAIN_STATE_DIR="$state" HOME="$state/home" "$binary" "$@" >"$out" 2>"$err"; then status=0; else status=$?; fi
  fi
  printf '%s' "$status"
}

compare_case() {
  local label="$1"; shift
  local shell_state="$work/$label-shell" binary_state="$work/$label-binary"
  local shell_out="$work/$label.shell.out" shell_err="$work/$label.shell.err"
  local binary_out="$work/$label.binary.out" binary_err="$work/$label.binary.err"
  make_fixture "$shell_state"; make_fixture "$binary_state"
  local shell_status binary_status
  shell_status="$(run_capture shell "$shell_state" "$shell_out" "$shell_err" "$@")"
  binary_status="$(run_capture binary "$binary_state" "$binary_out" "$binary_err" "$@")"
  if [ "$label" = malformed ]; then
    sed -E -i.bak 's#/.*/malformed[^/]*/chains.json#STATE/chains.json#g' "$shell_err" "$binary_err"
    rm -f "$shell_err.bak" "$binary_err.bak"
  fi
  [ "$shell_status" = "$binary_status" ] || fail "$label: status differs"
  cmp -s "$shell_out" "$binary_out" || fail "$label: stdout differs"
  cmp -s "$shell_err" "$binary_err" || fail "$label: stderr differs"
  cmp -s "$shell_state/chains.json" "$binary_state/chains.json" || fail "$label: config differs"
}

compare_case duplicate chain add existing --when '{"parentAgent":"codex"}' --steps '[{"agent":"codex","model":"gpt-5.6-luna","effort":"medium"}]'
compare_case missing chain edit absent --json
compare_case missing chain delete absent --json
compare_case invalid chain add invalid --when '{"parentAgent":"codex"}' --steps '[{"agent":"codex"}]'
compare_case unknown-model chain add invalid-model --when '{"parentAgent":"codex"}' --steps '[{"agent":"codex","model":"not-registered","effort":"medium"}]'
compare_case valid chain repair existing --step 1 --model gpt-5.6-luna --effort medium --json
compare_case malformed chain repair existing --step 1 --model gpt-5.6-luna --effort medium --json

printf 'chain write refusal contract: passed\n'

editor="$work/editor.sh"
printf '%s\n' '#!/usr/bin/env bash' 'tmp="$1.tmp"' 'jq '\''.chains.existing.steps[0].effort = "high"'\'' "$1" >"$tmp"' 'mv "$tmp" "$1"' >"$editor"
chmod +x "$editor"
for side in shell binary; do
  state="$work/success-$side"; make_fixture "$state"
  if [ "$side" = shell ]; then
    env MEGABRAIN_STATE_DIR="$state" HOME="$state/home" EDITOR="$editor" MEGABRAIN_CHAIN_IMPLEMENTATION=shell "$root/.build/megabrain" chain edit existing --json >"$work/$side.out" 2>"$work/$side.err"
  else
    env MEGABRAIN_STATE_DIR="$state" HOME="$state/home" EDITOR="$editor" "$binary" chain edit existing --json >"$work/$side.out" 2>"$work/$side.err"
  fi
done
cmp -s "$work/shell.out" "$work/binary.out" || fail 'successful edit: stdout differs'
cmp -s "$work/shell.err" "$work/binary.err" || fail 'successful edit: stderr differs'
cmp -s "$work/success-shell/chains.json" "$work/success-binary/chains.json" || fail 'successful edit: config differs'

routing_fixture="$work/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 97
for verb in add edit delete repair; do
  state="$work/stub-$verb"; make_fixture "$state"
  case "$verb" in
    add) args=(chain add fresh --when '{"parentAgent":"codex"}' --steps '[{"agent":"codex","model":"gpt-5.6-luna","effort":"medium"}]') ;;
    edit) args=(chain edit existing --json) ;;
    delete) args=(chain delete existing --json) ;;
    repair) args=(chain repair existing --step 1 --model gpt-5.6-luna --effort medium --json) ;;
  esac
  if env MEGABRAIN_STATE_DIR="$state" HOME="$state/home" EDITOR=true "$routing_fixture/.build/megabrain" "${args[@]}" >"$work/stub-$verb.out" 2>"$work/stub-$verb.err"; then
    fail "operator chain entrypoint bypassed the compiled implementation for $verb"
  else
    status=$?
  fi
  [ "$status" -eq 97 ] || fail "operator chain entrypoint returned status $status for $verb"
done
printf 'operator chain entrypoint reaches the compiled implementation: passed\n'
