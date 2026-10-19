#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${MEGABRAIN_DISPATCH_ID:-}" ]]; then
  echo "refusing stress run with an inherited dispatch id" >&2
  exit 2
fi

real_state_dir=""
if [[ -d "${HOME:-}/.megabrain" ]]; then
  real_state_dir="$(cd "${HOME}/.megabrain" && pwd -P)"
fi
for configured_state_dir in "${MEGABRAIN_STATE_DIR:-}" "${MEGABRAIN_DISPATCH_STATE_DIR:-}"; do
  [[ -n "$configured_state_dir" && -d "$configured_state_dir" ]] || continue
  resolved_state_dir="$(cd "$configured_state_dir" && pwd -P)"
  if [[ -n "$real_state_dir" && "$resolved_state_dir" == "$real_state_dir" ]]; then
    echo "refusing stress run against the real megabrain state directory" >&2
    exit 2
  fi
done

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
binary="$repo_root/.build/megabrain"
if [[ ! -x "$binary" ]]; then
  echo "build the megabrain CLI before running this stress test" >&2
  exit 2
fi

state_dir="$(mktemp -d)"
log_dir="$state_dir/stress-logs"
mkdir -p "$log_dir"
export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_DISPATCH_STATE_DIR="$state_dir"
export MEGABRAIN_STATE_OWNER_IDLE_MS=60000
export MEGABRAIN_BINARY="$binary"

cleanup() {
  if [[ -f "$state_dir/state-owner/owner.pid" ]]; then
    owner_pid="$(cat "$state_dir/state-owner/owner.pid")"
    owner_command="$(ps -p "$owner_pid" -o command= 2>/dev/null || true)"
    if [[ "$owner_command" == *"$binary __state-owner"* ]]; then
      kill -TERM "$owner_pid" 2>/dev/null || true
      stop_deadline=$((SECONDS + 5))
      while kill -0 "$owner_pid" 2>/dev/null && (( SECONDS < stop_deadline )); do sleep 0.05; done
      if kill -0 "$owner_pid" 2>/dev/null; then kill -KILL "$owner_pid" 2>/dev/null || true; fi
      for _ in {1..20}; do
        kill -0 "$owner_pid" 2>/dev/null || break
        sleep 0.05
      done
      if kill -0 "$owner_pid" 2>/dev/null; then
        echo "state owner process $owner_pid survived cleanup; keeping temporary state at $state_dir" >&2
        return
      fi
    elif [[ -n "$owner_command" ]]; then
      echo "refusing to stop an unverified process at pid $owner_pid" >&2
      return
    fi
  fi
  rm -rf "$state_dir"
}
trap cleanup EXIT

cd "$repo_root"
bun -e 'import {callStateOwner} from "./src/db/state-owner.ts"; const stateDir=process.env.MEGABRAIN_STATE_DIR!; process.argv=[process.execPath,process.env.MEGABRAIN_BINARY!]; for(let i=0;i<20;i++){const id="stress-"+String(i).padStart(2,"0"); await callStateOwner(stateDir,{operation:"dispatch-create",dispatch:{dispatchId:id,state:"running",parentHost:"local",parentSessionId:"stress-parent",agent:"codex",chatName:id,terminalId:"stress-child-"+i,childHost:"local"}});}'

worker() {
  local index="$1"
  local dispatch_id="stress-$(printf '%02d' "$index")"
  local log="$log_dir/worker-$index.log"
  local end=$((SECONDS + 30))
  local iterations=0
  local prefix=(env -u MEGABRAIN_DISPATCH_ID -u ORCA_TERMINAL_HANDLE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID)
  while (( SECONDS < end )); do
    if "${prefix[@]}" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_DISPATCH_STATE_DIR="$state_dir" MEGABRAIN_SESSION_ID="stress-child-$index" MEGABRAIN_SESSION_HOST=local "$binary" ask "ask-$index-$iterations" >>"$log" 2>&1; then printf x >>"$log_dir/ask-$index"; fi
    if "${prefix[@]}" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_DISPATCH_STATE_DIR="$state_dir" MEGABRAIN_SESSION_ID=stress-parent MEGABRAIN_SESSION_HOST=local "$binary" orchestrate reply "$dispatch_id" --operator --text "reply-$index-$iterations" >>"$log" 2>&1; then printf x >>"$log_dir/reply-$index"; fi
    if "${prefix[@]}" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_DISPATCH_STATE_DIR="$state_dir" MEGABRAIN_SESSION_ID="stress-child-$index" MEGABRAIN_SESSION_HOST=local "$binary" done "done-$index-$iterations" >>"$log" 2>&1; then printf x >>"$log_dir/done-$index"; fi
    if "${prefix[@]}" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_DISPATCH_STATE_DIR="$state_dir" MEGABRAIN_SESSION_ID=stress-parent MEGABRAIN_SESSION_HOST=local "$binary" orchestrate watch "$dispatch_id" --timeout 0 --wait-mode poll >>"$log" 2>&1; then printf x >>"$log_dir/watch-$index"; fi
    if "${prefix[@]}" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_DISPATCH_STATE_DIR="$state_dir" "$binary" status --json >>"$log" 2>&1; then printf x >>"$log_dir/status-$index"; fi
    if "${prefix[@]}" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_DISPATCH_STATE_DIR="$state_dir" "$binary" settings set terminal-engine native >>"$log" 2>&1; then printf x >>"$log_dir/settings-$index"; fi
    iterations=$((iterations + 1))
  done
}

for index in {0..19}; do worker "$index" & done
wait

settle_deadline=$((SECONDS + 60))
while (( SECONDS < settle_deadline )); do
  pending="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(*) FROM outbox WHERE status IN ('pending','sending');")"
  [[ "$pending" == 0 ]] && break
  sleep 0.25
done
count_markers() {
  local prefix="$1"
  local total=0
  local file bytes
  for file in "$log_dir/$prefix"-*; do
    [[ -f "$file" ]] || continue
    bytes="$(wc -c < "$file")"
    total=$((total + bytes))
  done
  printf '%s' "$total"
}

lock_errors="$(rg -o 'database is locked' "$log_dir" | wc -l)" || lock_errors=0
lock_errors="${lock_errors//[[:space:]]/}"
ask_success="$(count_markers ask)"
reply_success="$(count_markers reply)"
done_success="$(count_markers done)"
watch_success="$(count_markers watch)"
status_success="$(count_markers status)"
settings_success="$(count_markers settings)"
ask_rows="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(*) FROM messages WHERE dispatch_id LIKE 'stress-%' AND type='ask';")"
reply_rows="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(*) FROM messages WHERE dispatch_id LIKE 'stress-%' AND type='reply';")"
done_rows="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(*) FROM messages WHERE dispatch_id LIKE 'stress-%' AND type='done';")"
delivery_rows="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(*) FROM deliveries WHERE dispatch_id LIKE 'stress-%';")"
pending_outbox="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(*) FROM outbox WHERE status IN ('pending','sending');")"
delivery_messages="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT count(DISTINCT dispatch_id || ':' || message_seq) FROM deliveries WHERE dispatch_id LIKE 'stress-%';")"
message_counts="$(sqlite3 -readonly "$state_dir/megabrain.db" "SELECT type || '=' || count(*) FROM messages WHERE dispatch_id LIKE 'stress-%' GROUP BY type ORDER BY type;")"
transaction_metrics="$(MEGABRAIN_STRESS_LOG="$state_dir/logs/state-owner.log" bun -e 'import {readFileSync} from "node:fs"; const path=process.env.MEGABRAIN_STRESS_LOG!; const events=readFileSync(path,"utf8").split("\n").filter(Boolean).flatMap(line=>{try{const event=JSON.parse(line);return event.event==="request-committed"?[event as {operation:string;messageType?:string;transactionMs:number;elapsedMs:number}]:[]}catch{return[]}}); const q=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]:0}; const lines=[`owner_transactions=${events.length}`,`owner_transaction_ms_p50=${q(events.map(e=>e.transactionMs),0.50).toFixed(3)}`,`owner_transaction_ms_p99=${q(events.map(e=>e.transactionMs),0.99).toFixed(3)}`]; for(const operation of [...new Set(events.map(e=>e.operation))].sort()){const selected=events.filter(e=>e.operation===operation); lines.push(`${operation}_transactions=${selected.length}`,`${operation}_transaction_ms_p50=${q(selected.map(e=>e.transactionMs),0.50).toFixed(3)}`,`${operation}_transaction_ms_p99=${q(selected.map(e=>e.transactionMs),0.99).toFixed(3)}`)} for(const type of ["ask","reply","done"]){const selected=events.filter(e=>e.messageType===type); lines.push(`${type}_owner_calls=${selected.length}`,`${type}_owner_ms_p50=${q(selected.map(e=>e.elapsedMs),0.50).toFixed(3)}`,`${type}_owner_ms_p99=${q(selected.map(e=>e.elapsedMs),0.99).toFixed(3)}`)} const slow=[...events].sort((a,b)=>b.transactionMs-a.transactionMs).slice(0,5); lines.push(`slow_transactions=${slow.map(e=>`${e.operation}:${e.transactionMs.toFixed(3)}ms`).join(",")}`); console.log(lines.join("\n"));')"
transaction_p99="$(printf '%s\n' "$transaction_metrics" | sed -n 's/^owner_transaction_ms_p99=//p')"
delivery_counts="rows=$delivery_rows, distinct_messages=$delivery_messages"

printf 'duration_seconds=30\nworkers=20\nlock_errors=%s\nask_success=%s\nreply_success=%s\ndone_success=%s\nwatch_success=%s\nstatus_success=%s\nsettings_success=%s\npending_outbox=%s\n%s\n%s\n%s\n' \
  "$lock_errors" "$ask_success" "$reply_success" "$done_success" "$watch_success" "$status_success" "$settings_success" "$pending_outbox" "$message_counts" "$delivery_counts" "$transaction_metrics"

if [[ "$pending_outbox" != 0 ]]; then
  echo "stress test left outbox rows pending" >&2
  exit 1
fi
if [[ "$lock_errors" != 0 ]]; then
  echo "stress test found database lock errors" >&2
  exit 1
fi
if [[ "$ask_success" != "$ask_rows" || "$reply_success" != "$reply_rows" || "$done_success" != "$done_rows" ]]; then
  echo "successful message commands do not match the committed message rows" >&2
  exit 1
fi
if [[ "$delivery_rows" != "$delivery_messages" || "$delivery_rows" != "$((ask_rows + reply_rows + done_rows))" ]]; then
  echo "messages were not recorded in exactly one delivery row each" >&2
  exit 1
fi
if ! awk -v value="$transaction_p99" 'BEGIN { if (value == "" || value + 0 > 5.0) exit 1; exit 0 }'; then
  echo "state owner transaction p99 exceeded the 5 ms target: ${transaction_p99:-missing} ms" >&2
  exit 1
fi
