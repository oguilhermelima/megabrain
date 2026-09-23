#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
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

# Fake `security`/`curl` binaries placed ahead of the real ones on PATH so the compiled
# binary's live-limit fetch (src/core/chain-limits.ts: claudeCredentials/fetchClaudeUsage/
# agyCredentials/fetchAgyUsage) exercises real subprocess plumbing without touching the
# network or Keychain. Mode is read from a control file so each scenario can flip it.
fixture_bin="$work_dir/bin"
mkdir -p "$fixture_bin"
security_mode_file="$work_dir/security-mode"
curl_mode_file="$work_dir/curl-mode"
curl_call_file="$work_dir/curl-calls"
printf 'ok\n' >"$security_mode_file"
printf 'claude\n' >"$curl_mode_file"
: >"$curl_call_file"

cat >"$fixture_bin/security" <<EOF
#!/usr/bin/env bash
mode="\$(cat "$security_mode_file")"
service=""
for ((i = 1; i <= \$#; i++)); do
  if [ "\${!i}" = "-s" ]; then j=\$((i + 1)); service="\${!j}"; fi
done
case "\$mode:\$service" in
  missing:*) exit 1 ;;
  expired:"Claude Code-credentials") printf '{"claudeAiOauth":{"accessToken":"synthetic-claude-token","expiresAt":1}}' ;;
  ok:"Claude Code-credentials") printf '{"claudeAiOauth":{"accessToken":"synthetic-claude-token","expiresAt":9999999999}}' ;;
  ok:gemini) printf 'go-keyring-base64:%s' "\$(printf '%s' '{"token":"synthetic-agy-token"}' | base64)" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fixture_bin/security"

cat >"$fixture_bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$(cat "$curl_mode_file")" >>"$curl_call_file"
mode="\$(cat "$curl_mode_file")"
case "\$mode" in
  timeout) exit 28 ;;
  non200) printf '{"error":"synthetic"}\nMEGABRAIN_HTTP_STATUS:503' ;;
  garbage) printf 'not-json\nMEGABRAIN_HTTP_STATUS:200' ;;
  claude) printf '{"five_hour":{"utilization":11.0,"resets_at":"2026-09-07T10:00:00Z"},"seven_day":{"utilization":48.0,"resets_at":"2026-09-10T16:00:00Z"}}\nMEGABRAIN_HTTP_STATUS:200' ;;
  agy) printf '{"quota":{"gemini-5h":{"remaining_fraction":0.80,"reset_time":"2026-09-07T10:00:00Z"},"gemini-weekly":{"remaining_fraction":0.70,"reset_time":"2026-09-10T10:00:00Z"},"3p-5h":{"remaining_fraction":0.60,"reset_time":"2026-09-07T10:00:00Z"},"3p-weekly":{"remaining_fraction":0.50,"reset_time":"2026-09-10T10:00:00Z"}}}\nMEGABRAIN_HTTP_STATUS:200' ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$fixture_bin/curl"

chain_limits() {
  local state="$1"
  shift
  MEGABRAIN_STATE_DIR="$state" HOME="$state" PATH="$fixture_bin:$PATH" "$binary" chain limits --json "$@"
}

write_live_config() {
  local state="$1" provider="$2"
  mkdir -p "$state"
  printf '%s\n' "{\"chains\":{},\"defaultSteps\":[],\"usageLimits\":{\"liveProviders\":[\"$provider\"],\"cacheTtlSeconds\":30,\"timeoutSeconds\":5,\"notice\":{\"enabled\":false,\"intervalSeconds\":3600}}}" >"$state/chains.json"
}

row() {
  local json="$1" provider="$2" window="$3"
  printf '%s' "$json" | jq -c --arg p "$provider" --arg w "$window" '.[] | select(.provider == $p and .window == $w)'
}

# Scenario: a real-shaped Codex rollout snapshot (5h and weekly windows, both populated)
# reads as current for both windows with the reader's own JSON shape.
# Falsification: the reader would report unknown, wrong percentages, or drop the reading
# metadata (kind/basis) that `chain limits` exposes per row.
state1="$work_dir/state-real-shaped"
sessions1="$state1/sessions"
mkdir -p "$sessions1"
cp "$root/tests/fixtures/codex-rollout-rate-limits.jsonl" "$sessions1/rollout-real-shaped.jsonl"
result1="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions1" chain_limits "$state1")"
row_5h="$(row "$result1" codex 5h)"
row_weekly="$(row "$result1" codex weekly)"
assert_equal "$(printf '%s' "$row_5h" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row_5h" | jq -r '.usedPercent')" 73
assert_equal "$(printf '%s' "$row_5h" | jq -r '.reading.kind')" floor
assert_equal "$(printf '%s' "$row_5h" | jq -r '.reading.basis')" last-recorded-turn
assert_equal "$(printf '%s' "$row_weekly" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row_weekly" | jq -r '.usedPercent')" 28
printf 'limit real-shaped sample: current at 73/28 percent with reading metadata\n'

# Scenario: a snapshot with a single, non-standard window (a 30-day bucket) is still usable
# for a 5h request via the reader's single-available-window fallback.
# Falsification: the reader would refuse to fall back and report unknown instead.
state2="$work_dir/state-go-shaped"
sessions2="$state2/sessions"
mkdir -p "$sessions2"
cp "$root/tests/fixtures/codex-rollout-rate-limits-go.jsonl" "$sessions2/rollout-go-shaped.jsonl"
result2="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions2" chain_limits "$state2")"
row2="$(row "$result2" codex 5h)"
assert_equal "$(printf '%s' "$row2" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row2" | jq -r '.usedPercent')" 35
printf 'limit go-shaped sample: single non-standard window is usable for 5h\n'

# Scenario: a snapshot with a single window whose minutes match neither 5h nor weekly
# still falls back the same way.
# Falsification: the fallback only works for the specific go-shaped minute value above.
state3="$work_dir/state-unexpected-window"
sessions3="$state3/sessions"
mkdir -p "$sessions3"
printf '%s\n' '{"timestamp":"2026-09-07T08:15:20.790Z","ordinal":14,"type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","primary":{"used_percent":35.0,"window_minutes":15,"resets_at":4102444800},"secondary":null}}}' >"$sessions3/rollout-unknown-shaped.jsonl"
result3="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions3" chain_limits "$state3")"
row3="$(row "$result3" codex 5h)"
assert_equal "$(printf '%s' "$row3" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row3" | jq -r '.usedPercent')" 35
printf 'limit single unexpected window: fallback also applies to a 15-minute window\n'

# Scenario: a snapshot with two windows, neither matching the requested one, is unknown
# and names every window it actually saw.
# Falsification: the reader would silently pick one of the mismatched windows or omit
# the observed windows from the reason.
state4="$work_dir/state-multi-window"
sessions4="$state4/sessions"
mkdir -p "$sessions4"
printf '%s\n' '{"timestamp":"2026-09-07T08:15:21.790Z","ordinal":15,"type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","primary":{"used_percent":35.0,"window_minutes":43200,"resets_at":4102444800},"secondary":{"used_percent":20.0,"window_minutes":10080,"resets_at":4102444800}}}}' >"$sessions4/rollout-multi-window.jsonl"
result4="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions4" chain_limits "$state4")"
row4="$(row "$result4" codex 5h)"
assert_equal "$(printf '%s' "$row4" | jq -r '.status')" unknown
assert_contains "$(printf '%s' "$row4" | jq -r '.reason')" 'primary 43200 minutes'
assert_contains "$(printf '%s' "$row4" | jq -r '.reason')" 'secondary 10080 minutes'
printf 'limit multi-window without requested window: unknown names every available window\n'

# Scenario: the newest file's snapshot line is followed by a non-snapshot line; the reader
# must not treat the newer file's absence of a later match as "no snapshot" and must keep
# the last usable snapshot it found.
# Falsification: a reader that only looks at the final line of the newest file misses the
# earlier, still-valid snapshot in the same file.
state5="$work_dir/state-trailing-line"
sessions5="$state5/sessions"
mkdir -p "$sessions5"
future_reset="$(($(date +%s) + 3600))"
printf '%s\n%s\n' \
  "{\"timestamp\":\"2026-09-07T08:15:22.790Z\",\"ordinal\":16,\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1},\"model_context_window\":258400},\"rate_limits\":{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":97.0,\"window_minutes\":300,\"resets_at\":$future_reset},\"secondary\":{\"used_percent\":19.0,\"window_minutes\":10080,\"resets_at\":$future_reset}}}}" \
  '{"timestamp":"2026-09-07T08:15:23.790Z","ordinal":17,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' \
  >"$sessions5/rollout-current.jsonl"
result5="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions5" chain_limits "$state5")"
row5="$(row "$result5" codex 5h)"
assert_equal "$(printf '%s' "$row5" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row5" | jq -r '.usedPercent')" 97
printf 'limit trailing non-snapshot line: last usable snapshot in the file still wins\n'

# Scenario: the newest file by mtime carries no usable snapshot at all; an older file's
# snapshot is used instead.
# Falsification: a reader that only reads the newest file reports unknown even though an
# older file has a perfectly good snapshot.
state6="$work_dir/state-older-file"
sessions6="$state6/sessions"
mkdir -p "$sessions6"
printf '%s\n' "{\"timestamp\":\"2026-09-07T08:15:24.790Z\",\"ordinal\":18,\"type\":\"event_msg\",\"payload\":{\"rate_limits\":{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":40.0,\"window_minutes\":300,\"resets_at\":$future_reset},\"secondary\":{\"used_percent\":10.0,\"window_minutes\":10080,\"resets_at\":$future_reset}}}}" >"$sessions6/rollout-under.jsonl"
set_mtime_offset "$sessions6/rollout-under.jsonl" 30
printf '%s\n' '{"timestamp":"2026-09-07T08:15:25.790Z","ordinal":19,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' >"$sessions6/rollout-empty-newer.jsonl"
result6="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions6" chain_limits "$state6")"
row6="$(row "$result6" codex 5h)"
assert_equal "$(printf '%s' "$row6" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row6" | jq -r '.usedPercent')" 40
printf 'limit newest file without a snapshot: older usable snapshot is used\n'

# Scenario: a fresh state directory seeds an empty chain config and `chain list --json`
# reports zero chains without spawning anything.
# Falsification: a first-run config that is malformed or non-empty.
state7="$work_dir/state-empty-seed"
seeded="$(MEGABRAIN_STATE_DIR="$state7" HOME="$state7" "$binary" chain list --json)"
assert_equal "$(printf '%s' "$seeded" | jq '.chains | length')" 0
printf 'empty seed and list: passed\n'

# Scenario: agy's live usage reports normalize the named quota buckets (legacy `quota`
# plus each `-5h`/`-weekly` suffix) into windows the row can expose.
# Falsification: the reader would only understand Claude's shape and treat agy's response
# as unparseable.
state_agy="$work_dir/state-agy"
write_live_config "$state_agy" agy
printf 'agy\n' >"$curl_mode_file"
printf 'ok\n' >"$security_mode_file"
result_agy="$(chain_limits "$state_agy")"
row_agy="$(row "$result_agy" agy 5h)"
assert_equal "$(printf '%s' "$row_agy" | jq -r '.status')" current
assert_equal "$(printf '%s' "$row_agy" | jq -r '.usedPercent')" 20
printf 'agy live limits: named quota buckets normalized\n'

# Scenario: every distinct Claude live-fetch failure (missing Keychain item, expired
# credential, network timeout, non-200 response, unparseable body) reports unknown with a
# reason naming that specific failure, not a generic one.
# Falsification: two different failures collapse to the same reason, hiding which one
# actually happened.
for failure in missing expired timeout non200 garbage; do
  state_fail="$work_dir/state-claude-$failure"
  write_live_config "$state_fail" claude
  printf 'ok\n' >"$security_mode_file"
  printf 'claude\n' >"$curl_mode_file"
  case "$failure" in
    missing) printf 'missing\n' >"$security_mode_file" ;;
    expired) printf 'expired\n' >"$security_mode_file" ;;
    timeout) printf 'timeout\n' >"$curl_mode_file" ;;
    non200) printf 'non200\n' >"$curl_mode_file" ;;
    garbage) printf 'garbage\n' >"$curl_mode_file" ;;
  esac
  result_fail="$(chain_limits "$state_fail")"
  row_fail="$(row "$result_fail" claude 5h)"
  assert_equal "$(printf '%s' "$row_fail" | jq -r '.status')" unknown
  case "$failure" in
    missing) assert_contains "$(printf '%s' "$row_fail" | jq -r '.reason')" 'Keychain item is missing' ;;
    expired) assert_contains "$(printf '%s' "$row_fail" | jq -r '.reason')" 'expired' ;;
    timeout) assert_contains "$(printf '%s' "$row_fail" | jq -r '.reason')" 'timed out' ;;
    non200) assert_contains "$(printf '%s' "$row_fail" | jq -r '.reason')" 'HTTP 503' ;;
    garbage) assert_contains "$(printf '%s' "$row_fail" | jq -r '.reason')" 'unparseable' ;;
  esac
  printf 'claude failure %s: unknown with a distinct reason\n' "$failure"
done

# Scenario: an on-disk cache entry older than the configured TTL is treated as stale and
# triggers a fresh live request rather than being reused forever.
# Falsification: the reader would keep serving an expired cache entry and never re-fetch.
state_stale="$work_dir/state-stale-cache"
write_live_config "$state_stale" claude
printf 'ok\n' >"$security_mode_file"
printf 'claude\n' >"$curl_mode_file"
: >"$curl_call_file"
chain_limits "$state_stale" >/dev/null
[ "$(wc -l <"$curl_call_file" | tr -d ' ')" -eq 1 ] || fail 'first fetch did not make exactly one live request'
cache_path="$state_stale/usage-limits-claude.json"
old_fetched="$(($(date +%s) - 60))"
jq --argjson fetchedAt "$old_fetched" '.fetchedAt = $fetchedAt' "$cache_path" >"$cache_path.old"
mv -f "$cache_path.old" "$cache_path"
: >"$curl_call_file"
chain_limits "$state_stale" >/dev/null
assert_equal "$(wc -l <"$curl_call_file" | tr -d ' ')" 1
printf 'stale cache: expired entry triggers exactly one refresh request\n'

# Scenario: the codex rollout scan never opens more than the 50 most recent candidate
# files, even when a real snapshot sits in an older file just past that cutoff.
# Falsification (real, not just a smoke check): if the cap were absent, the scan would
# reach the older file's valid snapshot and report current; with the cap it must stay
# unknown, because the 55 newer, snapshot-less files fill every scan slot first.
state_scan="$work_dir/state-scan"
sessions_scan="$state_scan/sessions"
mkdir -p "$sessions_scan"
future_reset_scan="$(($(date +%s) + 3600))"
printf '%s\n' "{\"timestamp\":\"2026-09-07T08:15:24.790Z\",\"ordinal\":18,\"type\":\"event_msg\",\"payload\":{\"rate_limits\":{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":55.0,\"window_minutes\":300,\"resets_at\":$future_reset_scan}}}}" >"$sessions_scan/rollout-with-snapshot.jsonl"
set_mtime_offset "$sessions_scan/rollout-with-snapshot.jsonl" 100
scan_index=1
while [ "$scan_index" -le 55 ]; do
  printf '%s\n' '{"timestamp":"2026-09-07T08:15:25.790Z","ordinal":19,"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400}}}' >"$sessions_scan/rollout-$scan_index.jsonl"
  set_mtime_offset "$sessions_scan/rollout-$scan_index.jsonl" "$scan_index"
  scan_index=$((scan_index + 1))
done
result_scan="$(MEGABRAIN_CODEX_SESSIONS_DIR="$sessions_scan" chain_limits "$state_scan")"
row_scan="$(row "$result_scan" codex 5h)"
assert_equal "$(printf '%s' "$row_scan" | jq -r '.status')" unknown
printf 'codex rollout scan: the 50-file cap keeps an older real snapshot out of reach\n'

printf 'ok: chain limits reading, agy/claude live fetches, cache staleness, and rollout scan bounds\n'
