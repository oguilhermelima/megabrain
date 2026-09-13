#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain.XXXXXX")"
home_dir="$state_dir/home"
call_file="$state_dir/spawn-call"

cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir/state"
export HOME="$home_dir"
rollouts_dir="$HOME/.codex/sessions/2026/09/07"
mkdir -p "$rollouts_dir"

source "$root/lib/common.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-chain.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_percent() {
  assert_equal "$(printf '%.1f' "$1")" "$2"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected '$1' not to contain '$2'" ;;
    *) ;;
  esac
}

assert_failure() {
  if "$@" >/dev/null 2>&1; then
    fail "expected command to fail: $*"
  fi
}

fake_security_mode=ok
fake_curl_mode=claude
fake_curl_call_file=""
fake_claude_expiry=""

security() {
  local service="$3"
  case "$fake_security_mode:$service" in
    missing:*) return 1 ;;
    expired:Claude\ Code-credentials) printf '{"claudeAiOauth":{"accessToken":"synthetic-claude-token","expiresAt":1}}' ;;
    malformed:Claude\ Code-credentials) printf '{"claudeAiOauth":{"accessToken":"synthetic-claude-token","expiresAt":"bad"}}' ;;
    ok:Claude\ Code-credentials) printf '{"claudeAiOauth":{"accessToken":"synthetic-claude-token","expiresAt":%s}}' "${fake_claude_expiry:-9999999999}" ;;
    ok:gemini) printf 'go-keyring-base64:%s' "$(printf '%s' '{"token":"synthetic-agy-token"}' | base64)" ;;
    *) return 1 ;;
  esac
}

curl() {
  printf '%s\n' "$fake_curl_mode" >>"$fake_curl_call_file"
  case "$fake_curl_mode" in
    timeout) return 28 ;;
    non200) printf '{"error":"synthetic"}\nMEGABRAIN_HTTP_STATUS:503' ;;
    garbage) printf 'not-json\nMEGABRAIN_HTTP_STATUS:200' ;;
    agy) printf '{"quota":{"gemini-5h":{"remaining_fraction":0.80,"reset_time":"2026-09-07T10:00:00Z"},"gemini-weekly":{"remaining_fraction":0.70,"reset_time":"2026-09-10T10:00:00Z"},"3p-5h":{"remaining_fraction":0.60,"reset_time":"2026-09-07T10:00:00Z"},"3p-weekly":{"remaining_fraction":0.50,"reset_time":"2026-09-10T10:00:00Z"}}}\nMEGABRAIN_HTTP_STATUS:200' ;;
    *) printf '{"five_hour":{"utilization":11.0,"resets_at":"2026-09-07T10:00:00Z"},"seven_day":{"utilization":48.0,"resets_at":"2026-09-10T16:00:00Z"}}\nMEGABRAIN_HTTP_STATUS:200' ;;
  esac
}

write_config() {
  printf '%s\n' "$1" >"$MEGABRAIN_CHAIN_FILE"
}

write_rollout() {
  local path="$1" used="$2" reset="$3"
  printf '%s\n' "{\"timestamp\":\"2026-09-07T08:15:21.790Z\",\"ordinal\":15,\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":19712,\"cached_input_tokens\":2816,\"cache_write_input_tokens\":0,\"output_tokens\":22,\"reasoning_output_tokens\":13,\"total_tokens\":19734},\"model_context_window\":258400},\"rate_limits\":{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":$used,\"window_minutes\":300,\"resets_at\":$reset},\"secondary\":{\"used_percent\":19.0,\"window_minutes\":10080,\"resets_at\":$reset}}}}" >"$path"
}

set_mtime_offset() {
  local path="$1" offset="$2" epoch stamp
  epoch="$(($(date +%s) - offset))"
  if stamp="$(date -r "$epoch" '+%Y%m%d%H%M.%S' 2>/dev/null)"; then
    touch -t "$stamp" "$path"
  else
    stamp="$(date -d "@$epoch" '+%Y%m%d%H%M.%S')"
    touch -t "$stamp" "$path"
  fi
}

future_reset="$(($(date +%s) + 3600))"
cp "$root/tests/fixtures/codex-rollout-rate-limits.jsonl" "$rollouts_dir/rollout-real-shaped.jsonl"
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 73.0
assert_equal "$MEGABRAIN_CHAIN_LIMIT_RESETS" 4102444800
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" '73.0 percent'
assert_equal "$(printf '%s' "$MEGABRAIN_CHAIN_LIMIT_RESULT" | jq -r '.windows[0].usedPercent | type')" number
assert_equal "$(printf '%s' "$MEGABRAIN_CHAIN_LIMIT_RESULT" | jq -r '.reading.kind')" floor
assert_equal "$(printf '%s' "$MEGABRAIN_CHAIN_LIMIT_RESULT" | jq -r '.reading.basis')" last-recorded-turn
megabrain_chain_limit_read codex weekly
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 28.0
assert_equal "$MEGABRAIN_CHAIN_LIMIT_RESETS" 4102444800
printf 'limit real-shaped sample guard: current at 73 percent\n'

rm -f "$rollouts_dir"/rollout-*.jsonl
cp "$root/tests/fixtures/codex-rollout-rate-limits-go.jsonl" "$rollouts_dir/rollout-go-shaped.jsonl"
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'primary 43200 minutes'
printf 'limit go-shaped sample: monthly window is reported as unavailable for 5h\n'

rm -f "$rollouts_dir"/rollout-*.jsonl
printf '%s\n' '{"timestamp":"2026-09-07T08:15:20.790Z","ordinal":14,"type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","primary":{"used_percent":35.0,"window_minutes":15,"resets_at":4102444800},"secondary":null}}}' >"$rollouts_dir/rollout-unknown-shaped.jsonl"
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'primary 15 minutes'
printf 'limit unknown-shaped sample: unexpected window is named in the reason\n'

write_rollout "$rollouts_dir/rollout-current.jsonl" 97.0 "$future_reset"
printf '%s\n' '{"timestamp":"2026-09-07T08:15:22.790Z","ordinal":16,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' >>"$rollouts_dir/rollout-current.jsonl"
set_mtime_offset "$rollouts_dir/rollout-real-shaped.jsonl" 180
set_mtime_offset "$rollouts_dir/rollout-current.jsonl" 120
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 97.0
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" '97.0 percent'
printf 'limit trailing non-snapshot line: last usable snapshot\n'

printf '%s\n' '{"timestamp":"2026-09-07T08:15:23.790Z","ordinal":17,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' >"$rollouts_dir/rollout-empty.jsonl"
set_mtime_offset "$rollouts_dir/rollout-empty.jsonl" 60
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 97.0
printf 'limit newest file without snapshot: older usable snapshot\n'

seeded="$(MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/megabrain" chain list --json)"
assert_equal "$(printf '%s' "$seeded" | jq '.chains | length')" 0
printf 'empty seed and list: passed\n'

config='{"chains":{"parent":{"when":{"parentAgent":"codex"},"steps":[{"agent":"agy","model":"m","effort":"e"}]},"specific":{"when":{"parentAgent":"codex","parentEffort":"high"},"steps":[{"agent":"claude","model":"m","effort":"e"}]}},"defaultSteps":[{"agent":"codex","model":"m","effort":"e"}]}'
megabrain_chain_select "$config" parent codex '' ''
assert_equal "$MEGABRAIN_CHAIN_SELECTED_NAME" parent
printf 'selection explicit name: parent\n'
megabrain_chain_select "$config" '' codex '' ''
assert_equal "$MEGABRAIN_CHAIN_SELECTED_NAME" parent
printf 'selection one selector: parent\n'
megabrain_chain_select "$config" '' codex '' high
assert_equal "$MEGABRAIN_CHAIN_SELECTED_NAME" specific
printf 'selection most specific: specific\n'
tie_config='{"chains":{"alpha":{"when":{"parentAgent":"codex"},"steps":[{"agent":"agy","model":"m","effort":"e"}]},"beta":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"m","effort":"e"}]}},"defaultSteps":[]}'
if tie_error="$(megabrain_chain_select "$tie_config" '' codex '' '' 2>&1)"; then
  fail 'tie selection unexpectedly succeeded'
fi
assert_contains "$tie_error" 'alpha, beta'
printf 'selection tie: error lists candidates\n'
model_config='{"chains":{"model":{"when":{"parentAgent":"codex","parentModel":"known"},"steps":[{"agent":"agy","model":"m","effort":"e"}]}},"defaultSteps":[{"agent":"codex","model":"m","effort":"e"}]}'
megabrain_chain_select "$model_config" '' codex '' ''
assert_equal "$MEGABRAIN_CHAIN_SELECTION_DEFAULT" true
printf 'selection unknown parent model: default\n'
none_config='{"chains":{"claude-only":{"when":{"parentAgent":"claude"},"steps":[{"agent":"agy","model":"m","effort":"e"}]}},"defaultSteps":[{"agent":"codex","model":"m","effort":"e"}]}'
megabrain_chain_select "$none_config" '' agy '' ''
assert_equal "$MEGABRAIN_CHAIN_SELECTION_DEFAULT" true
printf 'selection no match: defaultSteps\n'

write_rollout "$rollouts_dir/rollout-under.jsonl" 40.0 "$future_reset"
printf '%s\n' '{"timestamp":"2026-09-07T08:15:24.790Z","ordinal":18,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' >>"$rollouts_dir/rollout-under.jsonl"
set_mtime_offset "$rollouts_dir/rollout-under.jsonl" 30
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 40.0
printf 'limit under threshold: current at 40 percent\n'
past_reset="$(($(date +%s) - 60))"
write_rollout "$rollouts_dir/rollout-stale.jsonl" 99.0 "$past_reset"
set_mtime_offset "$rollouts_dir/rollout-stale.jsonl" 10
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_not_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'stale'
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'already reset'
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'no information about the current window'
printf 'limit reset snapshot: unknown without stale claim\n'
megabrain_chain_limit_read claude 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
printf 'limit unavailable provider: unknown and usable\n'
rm -f "$rollouts_dir"/rollout-*.jsonl
printf '%s\n' '{"timestamp":"2026-09-07T08:15:25.790Z","ordinal":19,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' >"$rollouts_dir/rollout-empty-only.jsonl"
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'no rate limit snapshot'
printf 'limit absent: unknown honestly\n'

write_rollout "$rollouts_dir/rollout-reset-only.jsonl" 12.0 "$past_reset"
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_not_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'stale'
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'already reset'
printf 'limit reset-only snapshot: distinct unknown reason\n'

write_config '{"chains":{"run":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"m1","effort":"e1","until":{"usedPercent":95,"window":"5h"}},{"agent":"agy","model":"m2","effort":"e2"}]}},"defaultSteps":[]}'
command_orchestrate() {
  printf '%s\n' "$*" >"$call_file"
  printf '{"dispatch":"dispatch-chain"}\n'
}
write_config '{"chains":{"unknown":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"m1","effort":"e1","until":{"usedPercent":95,"window":"5h"}},{"agent":"agy","model":"m2","effort":"e2"}]}},"defaultSteps":[]}'
run_output="$(command_chain_run --parent-agent codex --worktree "$root" --prompt test --json)"
assert_equal "$(printf '%s' "$run_output" | jq -r '.step')" 1
assert_equal "$(printf '%s' "$run_output" | jq -r '.agent')" codex
assert_equal "$(printf '%s' "$run_output" | jq '.skipped | length')" 0
printf 'limit unknown: step is usable, not exhausted\n'

write_config '{"chains":{"unknown-skip":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"m1","effort":"e1","until":{"usedPercent":95,"window":"5h","onUnknown":"skip"}},{"agent":"agy","model":"m2","effort":"e2"}]}},"defaultSteps":[]}'
unknown_skip_output="$(command_chain_run --parent-agent codex --worktree "$root" --prompt test --json)"
assert_equal "$(printf '%s' "$unknown_skip_output" | jq -r '.step')" 2
assert_equal "$(printf '%s' "$unknown_skip_output" | jq -r '.skipped[0].kind')" limit
assert_contains "$(printf '%s' "$unknown_skip_output" | jq -r '.skipped[0].reason')" 'already reset'
printf 'limit unknown skip policy: advanced to step 2\n'

write_config '{"chains":{"unknown-take":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"m1","effort":"e1","until":{"usedPercent":95,"window":"5h","onUnknown":"take"}},{"agent":"agy","model":"m2","effort":"e2"}]}},"defaultSteps":[]}'
unknown_take_stderr="$state_dir/unknown-take.stderr"
command_chain_run --parent-agent codex --worktree "$root" --prompt test --json 2>"$unknown_take_stderr" >/dev/null
assert_contains "$(cat "$unknown_take_stderr")" 'usage limit is unknown; taking step'
printf 'limit unknown take policy: emits an explicit stderr decision\n'

rm -f "$rollouts_dir/rollout-reset-only.jsonl"
write_rollout "$rollouts_dir/rollout-run.jsonl" 97.0 "$future_reset"
set_mtime_offset "$rollouts_dir/rollout-run.jsonl" 30
run_output="$(command_chain_run --parent-agent codex --worktree "$root" --prompt test --json)"
assert_equal "$(printf '%s' "$run_output" | jq -r '.step')" 2
assert_contains "$(printf '%s' "$run_output" | jq -r '.skipped[0].reason')" '97.0'
assert_contains "$(cat "$call_file")" 'spawn'
assert_contains "$(cat "$call_file")" '--agent agy'
printf 'run limit skip: step 2 and spawn entry point invoked\n'

write_config '{"chains":{"run":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"m1","effort":"e1"},{"agent":"agy","model":"m2","effort":"e2"}]}},"defaultSteps":[]}'
command_orchestrate() {
  printf '%s\n' "$*" >"$call_file"
  case " $* " in
    *' --agent claude '*) printf 'launch failed\n' >&2; return 1 ;;
    *) printf '{"dispatch":"dispatch-after-failure"}\n' ;;
  esac
}
run_output="$(command_chain_run --parent-agent codex --worktree "$root" --prompt test --json)"
assert_equal "$(printf '%s' "$run_output" | jq -r '.step')" 2
assert_equal "$(printf '%s' "$run_output" | jq -r '.skipped[0].kind')" failure
printf 'run failure trigger: advanced to step 2\n'

write_config '{"chains":{"run":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"m1","effort":"e1","until":{"usedPercent":95,"window":"5h"}},{"agent":"claude","model":"m2","effort":"e2","until":{"usedPercent":95,"window":"5h"}}]}},"defaultSteps":[]}'
command_orchestrate() {
  printf 'launch failed\n' >&2
  return 1
}
if exhaustion="$(command_chain_run --parent-agent codex --worktree "$root" --prompt test --json)"; then
  fail 'all unusable steps unexpectedly succeeded'
fi
assert_equal "$(printf '%s' "$exhaustion" | jq '.skipped | length')" 2
assert_contains "$(printf '%s' "$exhaustion" | jq -r '.skipped[0].reason')" 'resets at'
assert_contains "$(printf '%s' "$exhaustion" | jq -r '.skipped[1].reason')" 'unknown'
printf 'run exhaustion: every step reported with reset and unknown\n'

export MEGABRAIN_CHAIN_NAME=run MEGABRAIN_CHAIN_STEP=2 MEGABRAIN_CHAIN_TOTAL=2 MEGABRAIN_CHAIN_REASON='codex exhausted' MEGABRAIN_CHAIN_DEFAULT=false
megabrain_dispatch_meta_write dispatch-record parent superset superset workspace terminal "$root" main agy label running m true agy '' '' host ide '' '' '' >/dev/null
assert_equal "$(jq -r '.chain.name' "$MEGABRAIN_STATE_DIR/dispatches/dispatch-record/meta.json")" run
assert_equal "$(jq -r '.chain.step' "$MEGABRAIN_STATE_DIR/dispatches/dispatch-record/meta.json")" 2
printf 'dispatch reporting: chosen chain and step persisted\n'

future_claude_expiry="$(($(date +%s) + 3600))"
fake_claude_expiry="$future_claude_expiry"
write_config '{"chains":{"provider":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"m","effort":"e"}]}},"defaultSteps":[],"usageLimits":{"liveProviders":["claude","agy"],"cacheTtlSeconds":30,"timeoutSeconds":5,"notice":{"enabled":false,"intervalSeconds":3600}}}'
fake_security_mode=ok
fake_curl_mode=claude
fake_curl_call_file="$state_dir/curl-calls"
: >"$fake_curl_call_file"
megabrain_chain_limit_read claude 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 11.0
assert_equal "$MEGABRAIN_CHAIN_LIMIT_SOURCE" live
assert_equal "$(printf '%s' "$MEGABRAIN_CHAIN_LIMIT_RESULT" | jq -r '.windows | length')" 2
assert_equal "$(wc -l <"$fake_curl_call_file" | tr -d ' ')" 1
megabrain_chain_limit_read claude weekly
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_equal "$(wc -l <"$fake_curl_call_file" | tr -d ' ')" 1
printf 'claude dispatch and cache: normalized response, one request\n'

fake_curl_mode=agy
megabrain_chain_limit_read agy 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" current
assert_percent "$MEGABRAIN_CHAIN_LIMIT_USED" 20.0
assert_equal "$(printf '%s' "$MEGABRAIN_CHAIN_LIMIT_RESULT" | jq -r '.windows | length')" 4
printf 'agy dispatch: named quota buckets normalized\n'

write_config '{"chains":{"provider":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"m","effort":"e"}]}},"defaultSteps":[],"usageLimits":{"liveProviders":[],"cacheTtlSeconds":30,"timeoutSeconds":5,"notice":{"enabled":false,"intervalSeconds":3600}}}'
 : >"$fake_curl_call_file"
megabrain_chain_limit_read claude 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'not enabled'
assert_equal "$(wc -l <"$fake_curl_call_file" | tr -d ' ')" 0
printf 'opt-in gate: disabled provider made no request\n'

write_config '{"chains":{"provider":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"m","effort":"e"}]}},"defaultSteps":[],"usageLimits":{"liveProviders":["claude"],"cacheTtlSeconds":30,"timeoutSeconds":5,"notice":{"enabled":false,"intervalSeconds":3600}}}'
for failure in missing expired timeout non200 garbage; do
  fake_security_mode=ok
  fake_curl_mode=claude
  case "$failure" in
    missing) fake_security_mode=missing ;;
    expired) fake_security_mode=expired ;;
    timeout) fake_curl_mode=timeout ;;
    non200) fake_curl_mode=non200 ;;
    garbage) fake_curl_mode=garbage ;;
  esac
  rm -f "$MEGABRAIN_STATE_DIR/usage-limits-claude.json"
  megabrain_chain_limit_read claude 5h
  assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
  case "$failure" in
    missing) assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'Keychain item is missing' ;;
    expired) assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'expired' ;;
    timeout) assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'timed out' ;;
    non200) assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'HTTP 503' ;;
    garbage) assert_contains "$MEGABRAIN_CHAIN_LIMIT_REASON" 'unparseable' ;;
  esac
  printf 'failure %s: unknown with distinct reason\n' "$failure"
done

fake_security_mode=ok
fake_curl_mode=claude
megabrain_chain_limit_read claude 5h
cache_path="$MEGABRAIN_STATE_DIR/usage-limits-claude.json"
old_fetched="$(($(date +%s) - 60))"
jq --argjson fetchedAt "$old_fetched" '.fetchedAt = $fetchedAt' "$cache_path" >"$cache_path.old"
mv -f "$cache_path.old" "$cache_path"
 : >"$fake_curl_call_file"
megabrain_chain_limit_read claude 5h
assert_equal "$(wc -l <"$fake_curl_call_file" | tr -d ' ')" 1
printf 'stale cache: expired entry refreshed\n'

limits_output="$(command_chain_limits --json)"
assert_equal "$(printf '%s' "$limits_output" | jq 'map(select(.provider == "codex")) | length')" 2
assert_equal "$(printf '%s' "$limits_output" | jq 'map(select(.provider == "claude")) | length')" 2
assert_equal "$(printf '%s' "$limits_output" | jq -r 'map(select(.provider == "codex"))[0].reading.kind')" floor
assert_equal "$(printf '%s' "$limits_output" | jq -r 'map(select(.provider == "codex"))[0].reading.basis')" last-recorded-turn
printf 'chain limits command: all providers and windows listed\n'

write_config '{"chains":{"provider":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"m","effort":"e"}]}},"defaultSteps":[],"usageLimits":{"liveProviders":["claude"],"cacheTtlSeconds":30,"timeoutSeconds":5,"notice":{"enabled":true,"intervalSeconds":3600}}}'
command_orchestrate() {
  megabrain_dispatch_meta_write notice-dispatch parent-terminal superset superset workspace terminal-child "$root" main codex label running gpt-5 true codex '' '' host >/dev/null
  printf '{"dispatch":"notice-dispatch"}\n'
}
megabrain_parent_notify_dispatch() { return 1; }
command_orchestrate >/dev/null
megabrain_chain_usage_notice_maybe notice-dispatch
notice_message="$(find "$MEGABRAIN_STATE_DIR/dispatches/notice-dispatch/messages" -name '*.json' -print -quit)"
[ -n "$notice_message" ] || fail 'usage notice was not queued'
assert_contains "$(jq -r '.text' "$notice_message")" 'Usage limits:'
printf 'chat notice: queued and delivery failure did not break caller\n'

# A process killed while the fallback walk is waiting for a launch must not leave its
# stderr scratch file in the shared state directory.
interrupt_state="$state_dir/interrupted"
mkdir -p "$interrupt_state"
(
  export MEGABRAIN_STATE_DIR="$interrupt_state"
  source "$root/lib/common.sh"
  source "$root/lib/module-chain.sh"
  MEGABRAIN_CHAIN_SELECTED_NAME=interrupted
  MEGABRAIN_CHAIN_SELECTION_DEFAULT=false
  MEGABRAIN_CHAIN_SELECTED_STEPS='[{"agent":"codex","model":"gpt-6-astra","effort":"high"}]'
  megabrain_chain_run_spawn() { sleep 30; }
  megabrain_chain_walk "$root" '' '' '' '' interrupted-prompt interrupted-label false '' '' false false
) &
interrupt_pid=$!
interrupt_attempt=0
while [ "$interrupt_attempt" -lt 100 ] &&
  [ "$(find "$interrupt_state" -name 'chain-run.*' -type f -print 2>/dev/null | wc -l | tr -d ' ')" -eq 0 ]; do
  sleep 0.05
  interrupt_attempt=$((interrupt_attempt + 1))
done
[ "$interrupt_attempt" -lt 100 ] || fail 'interrupted chain walk did not create its scratch file'
kill -TERM "$interrupt_pid"
wait "$interrupt_pid" 2>/dev/null || true
assert_equal "$(find "$interrupt_state" -name 'chain-run.*' -type f -print 2>/dev/null | wc -l | tr -d ' ')" 0
printf 'interrupted chain walk: scratch file removed\n'

# The refusal reader requires both independent lines from the shared tmux pane.
megabrain_dispatch_meta_write refusal-reading parent-terminal superset tmux workspace-test child-terminal \
  "$root" main codex label running gpt-5 true codex refusal-session refusal-pane tmux tmux >/dev/null
fake_pane_output="$(printf '%s\n%s\n' \
  "You've hit your usage limit for this account." \
  'Switch to another model now,')"
megabrain_tmux_capture_pane() { printf '%s\n' "$fake_pane_output"; }
megabrain_dispatch_limit_refusal_read refusal-reading
assert_equal "$MEGABRAIN_DISPATCH_LIMIT_REFUSAL" true
assert_contains "$MEGABRAIN_DISPATCH_LIMIT_REFUSAL_REASON" 'usage limit'
fake_pane_output="You've hit your usage limit for this account."
megabrain_dispatch_limit_refusal_read refusal-reading
assert_equal "$MEGABRAIN_DISPATCH_LIMIT_REFUSAL" false
printf 'limit refusal reader: anchored marker without second marker ignored\n'
fake_pane_output="typed-in brief quotes: You've hit your usage limit for this account."
megabrain_dispatch_limit_refusal_read refusal-reading
assert_equal "$MEGABRAIN_DISPATCH_LIMIT_REFUSAL" false
printf 'limit refusal reader: typed-in marker without refusal context ignored\n'
fake_pane_output='normal agent output'
megabrain_dispatch_limit_refusal_read refusal-reading
assert_equal "$MEGABRAIN_DISPATCH_LIMIT_REFUSAL" false
printf 'limit refusal reader: marker detected and absent output ignored\n'

# A long run of recent rollouts without a snapshot is bounded by the relevance
# window and a hard file ceiling before jq opens each file.
scan_root="$HOME/.codex/sessions/scan"
scan_count_file="$state_dir/scan-count"
mkdir -p "$scan_root"
: >"$scan_count_file"
: >"$scan_root/rollout-outside.jsonl"
: >"$scan_root/rollout-boundary.jsonl"
set_mtime_offset "$scan_root/rollout-outside.jsonl" 18001
set_mtime_offset "$scan_root/rollout-boundary.jsonl" 18000
scan_relevant="$(megabrain_chain_codex_rollouts 5h)"
assert_not_contains "$scan_relevant" 'rollout-outside.jsonl'
assert_contains "$scan_relevant" 'rollout-boundary.jsonl'
printf 'codex rollout relevance: outside excluded and boundary included\n'
scan_index=1
while [ "$scan_index" -le 55 ]; do
  : >"$scan_root/rollout-$scan_index.jsonl"
  touch "$scan_root/rollout-$scan_index.jsonl"
  scan_index=$((scan_index + 1))
done
real_jq="$(command -v jq)"
jq() {
  case " $* " in
    *"$scan_root"*) printf '%s\n' "$1" >>"$scan_count_file" ;;
  esac
  "$real_jq" "$@"
}
megabrain_chain_limit_read codex 5h
assert_equal "$MEGABRAIN_CHAIN_LIMIT_STATUS" unknown
assert_equal "$(wc -l <"$scan_count_file" | tr -d ' ')" 50
printf 'codex rollout scan: bounded at 50 files\n'

printf 'ok: chain selection, limits, failure advance, exhaustion, and reporting\n'
