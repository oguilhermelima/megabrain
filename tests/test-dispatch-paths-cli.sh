#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before implementation: archived state-changing verbs refuse without writes,
# archived close succeeds before any host call, and invalid identifiers stay rejected.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-paths.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled dispatch binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

make_archived() {
  local state="$1"
  mkdir -p "$state/dispatches/archive/2026-09/arq/messages" "$state/dispatches/archive/2026-09/arq/deliveries"
  printf '%s\n' '{"dispatchId":"arq","parentSessionId":"p","parentHost":"orca","state":"running","processState":"running","runtime":"host","childHost":"orca","terminalId":"child","terminalState":"retained"}' >"$state/dispatches/archive/2026-09/arq/meta.json"
  printf '%s\n' '{"id":"delivery","dispatchId":"arq","status":"outstanding","messageSeqs":[1]}' >"$state/dispatches/archive/2026-09/arq/deliveries/delivery.json"
}

mkdir -p "$work/home" "$work/bin"
cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HOST_CALL_LOG"
exit 99
EOF
chmod +x "$work/bin/orca"
make_archived "$work/archive"
export PATH="$work/bin:$PATH" HOST_CALL_LOG="$work/host-calls" MEGABRAIN_STATE_DIR="$work/archive"
export MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=p ORCA_TERMINAL_HANDLE=p
meta_path="$work/archive/dispatches/archive/2026-09/arq/meta.json"
before_meta="$(cat "$meta_path")"

run_archived() {
  local expected_status="$1"; shift
  local output status
  set +e
  output="$("$root/.build/megabrain" "$@" 2>&1)"; status=$?
  set -e
  [ "$status" -eq "$expected_status" ] || fail "${*:1}: expected status $expected_status, got $status: $output"
  printf '%s' "$output"
}

close_output="$(run_archived 0 orchestrate close arq)"
[ "$close_output" = 'dispatch arq is archived; nothing to close' ] || fail "archived close response: $close_output"
[ "$(cat "$meta_path")" = "$before_meta" ] || fail 'archived close changed metadata'
[ ! -e "$HOST_CALL_LOG" ] || fail 'archived close called the host'
printf 'compiled archived close is a no-op before any host call\n'

for verb in reply stop change reconcile; do
  case "$verb" in
    reply) output="$(run_archived 1 orchestrate reply arq --text answer)" ;;
    stop) output="$(run_archived 1 orchestrate stop arq)" ;;
    change) output="$(run_archived 1 orchestrate change arq --text direction)" ;;
    reconcile) output="$(run_archived 1 orchestrate reconcile arq)" ;;
  esac
  case "$output" in *'dispatch arq is archived'*) ;; *) fail "archived $verb did not report its state: $output" ;; esac
  [ "$(cat "$meta_path")" = "$before_meta" ] || fail "archived $verb changed metadata"
done
printf 'reply, stop, change and reconcile refuse archived dispatches\n'

ack_output="$(run_archived 1 orchestrate ack arq delivery --close)"
case "$ack_output" in *'dispatch arq is archived'*) ;; *) fail "archived ack --close did not report its state: $ack_output" ;; esac
[ "$(cat "$meta_path")" = "$before_meta" ] || fail 'archived ack --close changed metadata'
[ "$(cat "$work/archive/dispatches/archive/2026-09/arq/deliveries/delivery.json")" = '{"id":"delivery","dispatchId":"arq","status":"outstanding","messageSeqs":[1]}' ] || fail 'archived ack --close changed delivery state'
[ ! -e "$HOST_CALL_LOG" ] || fail 'an archived state-changing verb called the host'
printf 'ack --close refuses archived dispatches before acknowledging\n'

set +e
invalid_output="$(MEGABRAIN_STATE_DIR="$work/invalid" "$root/.build/megabrain" orchestrate close ../fora 2>&1)"; invalid_status=$?
set -e
[ "$invalid_status" -eq 1 ] || fail "invalid dispatch identifier unexpectedly succeeded: $invalid_output"
case "$invalid_output" in
  *'invalid dispatch id'*) ;;
  *) fail "invalid dispatch identifier content was not reported by the compiled command: $invalid_output" ;;
esac
printf 'compiled invalid-dispatch path reports the rejected identifier\n'

store_module_candidates="$(grep -rl '^export function dispatchRoot(' "$root/src")"
[ -n "$store_module_candidates" ] || fail 'could not locate the module that exports dispatchRoot'
case "$store_module_candidates" in
  *$'\n'*) fail "multiple modules export dispatchRoot:\n$store_module_candidates" ;;
esac
store_module="$(realpath "$store_module_candidates")"

set +e
grep -rn 'dispatches/' "$root/src" >"$work/dispatch-path-matches"
dispatch_path_status=$?
set -e
case "$dispatch_path_status" in
  0)
    : >"$work/offending-dispatch-path-matches"
    while IFS= read -r match; do
      matched_file="${match%%:*}"
      [ "$(realpath "$matched_file")" = "$store_module" ] || printf '%s\n' "$match" >>"$work/offending-dispatch-path-matches"
    done <"$work/dispatch-path-matches"
    if [ -s "$work/offending-dispatch-path-matches" ]; then
      fail "dispatch path construction exists outside the dispatch store:
$(cat "$work/offending-dispatch-path-matches")"
    fi
    ;;
  1) ;;
  *) fail "could not scan src for dispatch path construction (rg exit $dispatch_path_status)" ;;
esac
printf 'dispatch path construction is confined to the dispatch store\n'
