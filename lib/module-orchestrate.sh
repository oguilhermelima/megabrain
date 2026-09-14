#!/usr/bin/env bash

MEGABRAIN_DISPATCH_PROTOCOL=""
MEGABRAIN_SUPERSET_PROTOCOL=""
MEGABRAIN_LAST_DISPATCH=""
MEGABRAIN_DISPATCH_CLOSE_LAST_PANE=false
MEGABRAIN_DISPATCH_DELIVERY_BATCH_CAP="${MEGABRAIN_DISPATCH_DELIVERY_BATCH_CAP:-50}"
MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS="${MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS:-30}"
MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS="${MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS:-3}"
MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL="${MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL:-0.1}"
MEGABRAIN_PROMPT_RECEIPT_WAITING_STATUS=2
MEGABRAIN_PROMPT_BUDGET_ARGV_BYTES=262144
MEGABRAIN_PROMPT_BUDGET_TMUX_BYTES=12000
MEGABRAIN_DISPATCH_CLOSE_OUTCOME=unknown
MEGABRAIN_DISPATCH_CLOSE_ERROR=""
MEGABRAIN_DISPATCH_LIVE_ACTIVITY_WINDOW_SECONDS=60
MEGABRAIN_DISPATCH_PRUNE_DEFAULT_DAYS=7
MEGABRAIN_TRANSCRIPT_MAX_BYTES="${MEGABRAIN_TRANSCRIPT_MAX_BYTES:-10485760}"
MEGABRAIN_LAST_MESSAGE_SEQ=""
MEGABRAIN_LAST_SUPERSEDE_QUEUED=0
MEGABRAIN_LAST_SUPERSEDE_DELIVERED=0
MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES='[]'

# Single source of truth for mail visibility, keyed "from:type". actionable mail
# is surfaced by default and triggers a notify; protocol mail is durable evidence
# surfaced only with --full. Every site that routes or filters mail consults this.
MEGABRAIN_DISPATCH_MAIL_ACTIONABLE_KEYS=(child:ask child:done child:stalled megabrain:usage parent:withdrawal)
MEGABRAIN_DISPATCH_MAIL_PROTOCOL_KEYS=(child:received child:ack child:done-repeat parent:interrupt parent:interrupt-result)

megabrain_dispatch_prune_states() {
  printf 'closed,done,failed,orphaned,circuit_broken\n'
}

if ! declare -F megabrain_dispatch_preamble >/dev/null 2>&1; then
  # shellcheck source=local/megabrain/lib/module-facts.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/module-facts.sh"
fi

if ! declare -F megabrain_dispatch_terminal_status >/dev/null 2>&1; then
  # shellcheck source=local/megabrain/lib/module-context.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/module-context.sh"
fi

MEGABRAIN_DISPATCH_PROTOCOL="$(megabrain_dispatch_protocol)"
MEGABRAIN_SUPERSET_PROTOCOL="$MEGABRAIN_DISPATCH_PROTOCOL"

megabrain_dispatch_transition_allowed() {
  local axis="$1" from="$2" to="$3"
  case "$axis:$from:$to" in
    dispatch:spawning:spawning|dispatch:spawning:running|dispatch:spawning:failed|dispatch:spawning:closed) return 0 ;;
    dispatch:running:running|dispatch:running:waiting_for_reply|dispatch:running:done|dispatch:running:failed|dispatch:running:orphaned|dispatch:running:closed) return 0 ;;
    dispatch:waiting_for_reply:waiting_for_reply|dispatch:waiting_for_reply:running|dispatch:waiting_for_reply:done|dispatch:waiting_for_reply:failed|dispatch:waiting_for_reply:orphaned|dispatch:waiting_for_reply:closed) return 0 ;;
    dispatch:done:done|dispatch:done:failed|dispatch:done:orphaned|dispatch:done:closed) return 0 ;;
    dispatch:failed:failed|dispatch:failed:circuit_broken|dispatch:failed:closed) return 0 ;;
    dispatch:orphaned:orphaned|dispatch:orphaned:running|dispatch:orphaned:waiting_for_reply|dispatch:orphaned:done|dispatch:orphaned:failed|dispatch:orphaned:circuit_broken|dispatch:orphaned:closed) return 0 ;;
    # WHY: A child proving it is alive must be able to complete after a stall classification.
    dispatch:closed:closed|dispatch:circuit_broken:circuit_broken) return 0 ;;
    process:starting:starting|process:starting:running|process:starting:start-unproven|process:starting:failed|process:starting:stopping|process:starting:stopped|process:starting:stop-unproven|process:starting:abandoned) return 0 ;;
    process:start-unproven:start-unproven|process:start-unproven:running|process:start-unproven:failed|process:start-unproven:stopping|process:start-unproven:stopped|process:start-unproven:stop-unproven|process:start-unproven:abandoned) return 0 ;;
    process:running:running|process:running:succeeded|process:running:failed|process:running:stopping|process:running:stopped|process:running:abandoned|process:running:exited) return 0 ;;
    process:stopping:stopping|process:stopping:stopped|process:stopping:stop-unproven|process:stopping:running|process:stopping:failed|process:stopping:abandoned) return 0 ;;
    process:stop-unproven:stop-unproven|process:stop-unproven:failed|process:stop-unproven:stopped|process:stop-unproven:abandoned) return 0 ;;
    process:succeeded:succeeded|process:failed:failed|process:stopped:stopped|process:abandoned:abandoned|process:exited:exited|process:exited:running|process:exited:succeeded) return 0 ;;
    terminal:owned:owned|terminal:owned:missing|terminal:owned:retained|terminal:owned:released) return 0 ;;
    terminal:retained:retained|terminal:retained:missing|terminal:retained:released) return 0 ;;
    terminal:missing:missing|terminal:missing:retained|terminal:missing:released|terminal:released:released) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_dispatch_validate_transition() {
  local axis="$1" from="$2" to="$3"
  if ! megabrain_dispatch_transition_allowed "$axis" "$from" "$to"; then
    megabrain_error "illegal $axis state transition: $from -> $to"
    return 1
  fi
}

# A caller that wants to move a dispatch names the destination; the transition table
# remains the only authority for whether the current state may make that move.
megabrain_dispatch_require_transition() {
  local axis="$1" from="$2" to="$3"
  megabrain_dispatch_validate_transition "$axis" "$from" "$to"
}

megabrain_dispatch_reply_state_allowed() {
  local state="$1"
  megabrain_dispatch_transition_allowed dispatch "$state" running
}

# WHY: done is terminal for child execution. The mark-running hook is idempotent there
# and must not invent the forbidden done -> running transition just to refresh metadata.
megabrain_dispatch_mark_running_noop() {
  [ "$1" = done ]
}

megabrain_prompt_byte_length() {
  LC_ALL=C printf '%s' "$1" | wc -c | tr -d '[:space:]'
}

megabrain_validate_prompt_budget() {
  local text="$1" path="${2:-argv}" label="${3:-prompt}" actual limit
  case "$path" in
    argv) limit="$MEGABRAIN_PROMPT_BUDGET_ARGV_BYTES" ;;
    tmux) limit="$MEGABRAIN_PROMPT_BUDGET_TMUX_BYTES" ;;
    *) megabrain_error "unknown prompt delivery path: $path"; return 1 ;;
  esac
  actual="$(megabrain_prompt_byte_length "$text")"
  if [ "$actual" -gt "$limit" ]; then
    megabrain_error "$label is too large for $path delivery: $actual bytes (limit: $limit bytes)"
    return 1
  fi
}

megabrain_dispatch_new_id() {
  local candidate suffix counter=0
  suffix="$(date -u '+%Y%m%d%H%M%S')-$$-${RANDOM:-0}"
  candidate="dispatch-$suffix"
  while [ -e "$MEGABRAIN_DISPATCH_DIR/$candidate" ]; do
    counter=$((counter + 1))
    candidate="dispatch-$suffix-$counter"
  done
  printf '%s\n' "$candidate"
}

megabrain_dispatch_default_label() {
  local user_name host_name timestamp
  user_name="${USER:-$(id -un 2>/dev/null || true)}"
  host_name="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
  timestamp="$(megabrain_iso_now)"
  if [ -n "$user_name" ] && [ -n "$host_name" ]; then
    printf '%s@%s %s\n' "$user_name" "$host_name" "$timestamp"
  elif [ -n "$timestamp" ]; then
    printf 'megabrain-dispatch-%s\n' "$timestamp"
  else
    printf 'megabrain-dispatch\n'
  fi
}

megabrain_dispatch_dir() {
  local dispatch_id="$1" live_path archive_path
  case "$dispatch_id" in
    ""|*[!A-Za-z0-9._-]*)
      megabrain_error "invalid dispatch id: $dispatch_id"
      return 1
      ;;
  esac
  live_path="$MEGABRAIN_DISPATCH_DIR/$dispatch_id"
  if [ -e "$live_path" ]; then
    printf '%s\n' "$live_path"
    return 0
  fi
  for archive_path in "$MEGABRAIN_DISPATCH_DIR"/archive/*/"$dispatch_id"; do
    [ -e "$archive_path" ] || continue
    printf '%s\n' "$archive_path"
    return 0
  done
  printf '%s\n' "$live_path"
}

megabrain_dispatch_meta_path() { printf '%s/meta.json\n' "$(megabrain_dispatch_dir "$1")"; }
megabrain_dispatch_messages_dir() { printf '%s/messages\n' "$(megabrain_dispatch_dir "$1")"; }
megabrain_dispatch_cursor_path() { printf '%s/cursor.json\n' "$(megabrain_dispatch_dir "$1")"; }
megabrain_dispatch_deliveries_dir() { printf '%s/deliveries\n' "$(megabrain_dispatch_dir "$1")"; }

megabrain_dispatch_delivery_path() {
  local dispatch_id="$1" delivery_id="$2"
  case "$delivery_id" in
    ""|*[!A-Za-z0-9._-]*)
      megabrain_error "invalid delivery id: $delivery_id"
      return 1
      ;;
  esac
  printf '%s/%s.json\n' "$(megabrain_dispatch_deliveries_dir "$dispatch_id")" "$delivery_id"
}

megabrain_dispatch_new_delivery_id() {
  local dispatch_id="$1" candidate suffix counter=0 deliveries_dir
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")" || return 1
  mkdir -p "$deliveries_dir" || return 1
  suffix="$(date -u '+%Y%m%d%H%M%S')-$$-${RANDOM:-0}"
  candidate="delivery-$suffix"
  while [ -e "$deliveries_dir/$candidate.json" ]; do
    counter=$((counter + 1))
    candidate="delivery-$suffix-$counter"
  done
  printf '%s\n' "$candidate"
}

megabrain_dispatch_delivery_write() {
  local dispatch_id="$1" delivery_id="$2" consumer="$3" generation="$4" message_seqs="$5"
  local deliveries_dir path tmp now
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")" || return 1
  mkdir -p "$deliveries_dir" || return 1
  path="$(megabrain_dispatch_delivery_path "$dispatch_id" "$delivery_id")" || return 1
  now="$(megabrain_iso_now)"
  tmp="$(mktemp "$deliveries_dir/.delivery.XXXXXX")" || return 1
  if ! jq -n \
    --arg id "$delivery_id" --arg dispatchId "$dispatch_id" --arg consumer "$consumer" \
    --argjson generation "$generation" --argjson messageSeqs "$message_seqs" \
    --arg now "$now" \
    '{id: $id, dispatchId: $dispatchId, consumer: $consumer, consumerGeneration: $generation, messageSeqs: $messageSeqs, status: "outstanding", createdAt: $now, updatedAt: $now, acknowledgedAt: null, fencedAt: null}' \
    >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_delivery_create() {
  local dispatch_id="$1" recipient="$2" message_seqs="$3"
  local delivery_id deliveries_dir path tmp now
  case "$recipient" in
    parent|child) ;;
    *) megabrain_error "invalid delivery recipient: $recipient"; return 1 ;;
  esac
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")" || return 1
  mkdir -p "$deliveries_dir" || return 1
  delivery_id="$(megabrain_dispatch_new_delivery_id "$dispatch_id")" || return 1
  path="$(megabrain_dispatch_delivery_path "$dispatch_id" "$delivery_id")" || return 1
  now="$(megabrain_iso_now)"
  tmp="$(mktemp "$deliveries_dir/.delivery.XXXXXX")" || return 1
  if ! jq -n \
    --arg id "$delivery_id" --arg dispatchId "$dispatch_id" --arg recipient "$recipient" \
    --argjson messageSeqs "$message_seqs" --arg now "$now" \
    '{id: $id, dispatchId: $dispatchId, recipient: $recipient, consumer: null, consumerGeneration: null, messageSeqs: $messageSeqs, status: "outstanding", createdAt: $now, updatedAt: $now, acknowledgedAt: null, fencedAt: null}' \
    >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
  printf '%s\n' "$delivery_id"
}

megabrain_dispatch_delivery_claim() {
  local path="$1" consumer="$2" generation="$3" tmp now
  now="$(megabrain_iso_now)"
  tmp="$(mktemp "$(dirname "$path")/.delivery.XXXXXX")" || return 1
  if ! jq --arg consumer "$consumer" --argjson generation "$generation" --arg now "$now" \
    '.consumer = $consumer | .consumerGeneration = $generation | .updatedAt = $now' \
    "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_delivery_has_seq() {
  local deliveries_dir="$1" message_seq="$2" path
  for path in "$deliveries_dir"/*.json; do
    [ -f "$path" ] || continue
    jq -e --argjson seq "$message_seq" '(.messageSeqs // []) | index($seq) != null' \
      "$path" >/dev/null 2>&1 && return 0
  done
  return 1
}

megabrain_dispatch_migrate_legacy_deliveries() {
  local dispatch_id="$1" messages_dir deliveries_dir lock path from type seq recipient class
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  [ -d "$messages_dir" ] || return 0
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")"
  lock="$messages_dir/.lock"
  megabrain_dispatch_lock_acquire "$lock" || return 1
  while IFS=$'\t' read -r seq path; do
    [ -n "$path" ] || continue
    from="$(jq -r '.from // empty' "$path" 2>/dev/null || true)"
    type="$(jq -r '.type // empty' "$path" 2>/dev/null || true)"
    case "$from:$type" in
      parent:reply) recipient=child ;;
      *)
        class="$(megabrain_dispatch_mail_class_for_message "$dispatch_id" "$from:$type" "$seq" 2>/dev/null || true)"
        [ -n "$class" ] && recipient=parent || continue
        ;;
    esac
    megabrain_dispatch_delivery_has_seq "$deliveries_dir" "$seq" && continue
    megabrain_dispatch_delivery_create "$dispatch_id" "$recipient" "[$seq]" >/dev/null || {
      rmdir "$lock"
      return 1
    }
  done < <(megabrain_dispatch_message_paths "$messages_dir")
  rmdir "$lock"
}

megabrain_dispatch_meta_write() {
  local dispatch_id="$1" parent_session="$2" parent_host="$3" child_host="$4"
  local workspace_id="$5" terminal_id="$6" worktree_path="$7" branch="$8"
  local agent="$9" label="${10}" state="${11}" model="${12:-}" model_honored="${13:-false}"
  local agent_id="${14:-$agent}" tmux_session="${15:-}" tmux_pane="${16:-}" runtime="${17:-host}" spawn_runtime="${18:-}"
  local parent_tmux_session="${19:-}" parent_tmux_pane="${20:-}" parent_workspace_id="${21:-}"
  local chain_name="${22:-${MEGABRAIN_CHAIN_NAME:-}}" chain_step="${23:-${MEGABRAIN_CHAIN_STEP:-}}"
  local chain_total="${24:-${MEGABRAIN_CHAIN_TOTAL:-}}" chain_reason="${25:-${MEGABRAIN_CHAIN_REASON:-}}"
  local chain_default="${26:-${MEGABRAIN_CHAIN_DEFAULT:-false}}" effort="${27:-}" chain_step_json chain_total_json dispatch_dir tmp
  if [ -z "$spawn_runtime" ]; then
    [ "$runtime" = tmux ] && spawn_runtime=tmux || spawn_runtime=ide
  fi
  case "$chain_step" in
    ''|*[!0-9]*) chain_step_json=null ;;
    *) chain_step_json="$chain_step" ;;
  esac
  case "$chain_total" in
    ''|*[!0-9]*) chain_total_json=null ;;
    *) chain_total_json="$chain_total" ;;
  esac
  dispatch_dir="$(megabrain_dispatch_dir "$dispatch_id")" || return 1
  # Publish metadata before the queue directories. If a later filesystem operation
  # fails, inventory and doctor can still name the durable dispatch directory.
  mkdir -p "$dispatch_dir" || return 1
  tmp="$(mktemp "$dispatch_dir/.meta.XXXXXX")" || return 1
  if ! jq -n \
    --arg dispatchId "$dispatch_id" --arg parentSessionId "$parent_session" \
    --arg parentHost "$parent_host" --arg childHost "$child_host" \
    --arg workspaceId "$workspace_id" --arg terminalId "$terminal_id" \
    --arg worktreePath "$worktree_path" --arg branch "$branch" \
    --arg agent "$agent" --arg labelText "$label" --arg state "$state" \
    --arg model "$model" --arg agentId "$agent_id" --arg runtime "$runtime" \
    --arg tmuxSession "$tmux_session" --arg tmuxPane "$tmux_pane" --arg spawnRuntime "$spawn_runtime" \
    --arg parentTmuxSession "$parent_tmux_session" --arg parentTmuxPane "$parent_tmux_pane" --arg parentWorkspaceId "$parent_workspace_id" \
    --arg chainName "$chain_name" --arg chainReason "$chain_reason" \
    --arg effort "$effort" \
    --argjson chainStep "$chain_step_json" --argjson chainTotal "$chain_total_json" \
    --argjson chainDefault "$(megabrain_bool_json "$chain_default")" \
    --argjson modelHonored "$(megabrain_bool_json "$model_honored")" \
    --arg now "$(megabrain_iso_now)" \
    '{dispatchId: $dispatchId, parentSessionId: $parentSessionId, parentHost: $parentHost, parentWorkspaceId: (if $parentWorkspaceId == "" then null else $parentWorkspaceId end), parentTmuxSession: (if $parentTmuxSession == "" then null else $parentTmuxSession end), parentTmuxPane: (if $parentTmuxPane == "" then null else $parentTmuxPane end), childHost: $childHost, workspaceId: $workspaceId, terminalId: $terminalId, worktreePath: $worktreePath, branch: $branch, agent: $agent, agentId: $agentId, model: $model, effort: (if $effort == "" then null else $effort end), modelHonored: $modelHonored, modelSubstitution: null, runtime: $runtime, spawnRuntime: $spawnRuntime, tmuxSession: (if $tmuxSession == "" then null else $tmuxSession end), tmuxPane: (if $tmuxPane == "" then null else $tmuxPane end), label: $labelText, chain: (if $chainName == "" then null else {name: $chainName, step: $chainStep, total: $chainTotal, reason: $chainReason, usedDefault: $chainDefault} end), state: $state, promptDelivered: false, promptDelivery: "pending", promptDeliveryReason: null, promptPublication: "pending", promptTransport: "pending", promptReceipt: "pending", promptState: "awaiting-publication", processState: (if $state == "spawning" then "starting" elif $state == "running" then "running" elif $state == "done" then "succeeded" elif $state == "failed" then "failed" elif $state == "closed" then "stopped" else "start-unproven" end), terminalState: "owned", terminalReason: null, failureCount: 0, stage: null, reason: null, reconcileOutcome: null, createdAt: $now, updatedAt: $now}' \
    >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv -f "$tmp" "$(megabrain_dispatch_meta_path "$dispatch_id")"; then
    rm -f "$tmp"
    return 1
  fi
  mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries" || return 1
  megabrain_dispatch_cursor_write "$dispatch_id" 0 || return 1
  printf '%s\n' "$dispatch_id"
}

megabrain_dispatch_meta_update_prompt() {
  local dispatch_id="$1" delivered="$2" delivery="$3" reason="${4:-}" path tmp current_delivery
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.meta.XXXXXX")" || return 1
  current_delivery="$(jq -r '.promptDelivery // "pending"' "$path" 2>/dev/null || true)"
  case "$current_delivery:$delivery" in
    pending:delivered|pending:not-delivered|delivered:delivered|not-delivered:not-delivered) ;;
    *)
      rm -f "$tmp"
      megabrain_error "prompt delivery state cannot change from $current_delivery to $delivery for $dispatch_id"
      return 1
      ;;
  esac
  if ! jq \
    --argjson delivered "$(megabrain_bool_json "$delivered")" --arg delivery "$delivery" --arg reason "$reason" \
    --arg now "$(megabrain_iso_now)" \
    '.promptDelivered = $delivered | .promptDelivery = $delivery | .promptDeliveryReason = (if $reason == "" then null else $reason end) | if $delivery == "delivered" then .promptReceipt = "received" | .promptState = "confirmed" elif $delivery == "not-delivered" then .promptState = "failed" else . end | .updatedAt = $now' \
    "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_meta_update_prompt_layers() {
  local dispatch_id="$1" publication="$2" transport="$3" receipt="$4" prompt_state="$5" reason="${6:-__keep__}"
  local path tmp
  case "$publication" in __keep__|pending|published|not-published|unknown) ;; *) megabrain_error "invalid prompt publication state: $publication"; return 1 ;; esac
  case "$transport" in __keep__|pending|transported|not-transported|unknown) ;; *) megabrain_error "invalid prompt transport state: $transport"; return 1 ;; esac
  case "$receipt" in __keep__|pending|received|unknown) ;; *) megabrain_error "invalid prompt receipt state: $receipt"; return 1 ;; esac
  case "$prompt_state" in __keep__|awaiting-publication|awaiting-transport|awaiting-receipt|confirmed|failed|legacy|unknown) ;; *) megabrain_error "invalid prompt state: $prompt_state"; return 1 ;; esac
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.meta.XXXXXX")" || return 1
  if ! jq \
    --arg publication "$publication" --arg transport "$transport" --arg receipt "$receipt" \
    --arg promptState "$prompt_state" --arg reason "$reason" --arg now "$(megabrain_iso_now)" '
      . as $before
      | if $publication == "__keep__" then . else .promptPublication = $publication end
      | if $transport == "__keep__" then . else .promptTransport = $transport end
      | if $receipt == "__keep__" then . else .promptReceipt = $receipt end
      | if $promptState == "__keep__" then . else .promptState = $promptState end
      | if $reason == "__keep__" then . elif $reason == "__clear__" then .promptDeliveryReason = null else .promptDeliveryReason = $reason end
      | if . == $before then . else .updatedAt = $now end
    ' "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_meta_update_chain_context() {
  local dispatch_id="$1" prompt="$2" path tmp
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.meta.XXXXXX")" || return 1
  if ! jq --arg prompt "$prompt" --arg now "$(megabrain_iso_now)" \
    'if (.chain | type) == "object" then .chain.prompt = $prompt | .updatedAt = $now else . end' \
    "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_transcript_path() {
  printf '%s/transcript\n' "$(megabrain_dispatch_dir "$1")"
}

# Streams path capped to at most max_bytes, keeping the END of the file
# (front truncation). A file at or under max_bytes passes through unchanged.
# When truncation happens, the first (possibly partial) line of the kept
# slice is dropped, since a byte-boundary cut can land inside a line or an
# escape sequence.
megabrain_transcript_capped_stream() {
  local path="$1" max_bytes="$2" size
  size="$(wc -c <"$path" 2>/dev/null | tr -d ' ')"
  case "$size" in
    ''|*[!0-9]*)
      cat "$path"
      return $?
      ;;
  esac
  if [ "$size" -gt "$max_bytes" ]; then
    tail -c "$max_bytes" "$path" | tail -n +2
  else
    cat "$path"
  fi
}

# Truncates path in place to at most max_bytes, front-truncating (keeping
# the tail) via megabrain_transcript_capped_stream. A no-op when the file
# is missing or already at or under max_bytes.
megabrain_transcript_truncate_file() {
  local path="$1" max_bytes="$2" size tmp
  [ -f "$path" ] || return 0
  size="$(wc -c <"$path" 2>/dev/null | tr -d ' ')"
  case "$size" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$size" -gt "$max_bytes" ] || return 0
  tmp="$(mktemp "${path}.XXXXXX")" || return 1
  if ! megabrain_transcript_capped_stream "$path" "$max_bytes" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_render_transcript() {
  local path="$1" lines="$2" render_dir='' replay_path='' captured_path='' socket='' session='' marker='' start_marker='' history_limit=0 raw_line_count=0 attempts=0
  local command_text="" tmux_config=''
  render_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-transcript-render.XXXXXX")" || return 1
  replay_path="$render_dir/replay"
  captured_path="$render_dir/captured"
  socket="$render_dir/tmux"
  session="megabrain-render-$$-${RANDOM:-0}"
  marker="$render_dir/complete"
  start_marker="$render_dir/start"
  tmux_config="$render_dir/tmux.conf"
  # Never load more than MEGABRAIN_TRANSCRIPT_MAX_BYTES of the source file: this is
  # the bound that actually holds regardless of whether a lifecycle path ever
  # truncated the persisted transcript on disk.
  if ! megabrain_transcript_capped_stream "$path" "$MEGABRAIN_TRANSCRIPT_MAX_BYTES" |
    awk -v esc="$(printf '\033')" '{ gsub(esc "\\[3J", ""); print }' >"$replay_path"; then
    rm -rf "$render_dir"
    return 1
  fi
  raw_line_count="$(wc -l <"$replay_path" | tr -d ' ')"
  case "$raw_line_count" in
    ''|*[!0-9]*)
      rm -rf "$render_dir"
      return 1
      ;;
  esac
  history_limit=$((raw_line_count + lines + 100))

  # history-limit became a per-window option in tmux 3.2+: setting it with
  # set-option after the window already exists is a no-op on some tmux builds
  # (measured: tmux 3.3a silently keeps the compiled-in 2000-line default,
  # while tmux 3.7c happens to grow the existing window anyway). It must be
  # in place before new-session creates the window, so it goes in a minimal
  # config file passed via -f instead of /dev/null. alternate-screen is a
  # session option, applied dynamically regardless of when it is set
  # (measured: setting it off after creation still suppresses an alternate-
  # screen switch that arrives afterward), so it stays a post-creation
  # set-option below rather than moving into this file.
  printf 'set-option -g history-limit %s\n' "$history_limit" >"$tmux_config"

  command_text="stty -echo; while [ ! -f $(printf '%q' "$start_marker") ]; do sleep 0.01; done; cat $(printf '%q' "$replay_path"); touch $(printf '%q' "$marker"); exec sleep 60"
  if ! tmux -S "$socket" -f "$tmux_config" new-session -d -x 240 -y 100 -s "$session" "$command_text" >/dev/null 2>&1; then
    tmux -S "$socket" -f /dev/null kill-server >/dev/null 2>&1 || true
    rm -rf "$render_dir"
    return 1
  fi

  if ! tmux -S "$socket" -f /dev/null set-option -g alternate-screen off >/dev/null 2>&1 ||
    ! touch "$start_marker"; then
    tmux -S "$socket" -f /dev/null kill-server >/dev/null 2>&1 || true
    rm -rf "$render_dir"
    return 1
  fi

  while [ ! -f "$marker" ]; do
    if ! tmux -S "$socket" -f /dev/null has-session -t "$session" >/dev/null 2>&1; then
      tmux -S "$socket" -f /dev/null kill-server >/dev/null 2>&1 || true
      rm -rf "$render_dir"
      return 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 1200 ]; then
      tmux -S "$socket" -f /dev/null kill-server >/dev/null 2>&1 || true
      rm -rf "$render_dir"
      return 1
    fi
    sleep 0.05
  done

  if ! tmux -S "$socket" -f /dev/null capture-pane -J -p -t "$session":0.0 -S "-$history_limit" >"$captured_path" 2>/dev/null; then
    tmux -S "$socket" -f /dev/null kill-server >/dev/null 2>&1 || true
    rm -rf "$render_dir"
    return 1
  fi
  tmux -S "$socket" -f /dev/null kill-server >/dev/null 2>&1 || true
  # Streams the trailing-blank-line trim instead of loading the capture into an
  # array: buffer only a run of blank lines, flush it once a non-blank line
  # shows it wasn't trailing, and drop whatever is still buffered at EOF.
  awk '
    /^[[:space:]]*$/ { blank = blank $0 "\n"; next }
    { if (blank != "") { printf "%s", blank; blank = "" } print }
  ' "$captured_path"
  rm -rf "$render_dir"
  return 0
}

MEGABRAIN_DISPATCH_LIVENESS_STATUS=unknown
MEGABRAIN_DISPATCH_LIVENESS_REASON=''
MEGABRAIN_DISPATCH_LIVENESS_SOURCE=unknown

megabrain_dispatch_liveness_read() {
  local dispatch_id="$1" json=false arg meta runtime pane agent output source state terminal_status
  MEGABRAIN_DISPATCH_LIVENESS_STATUS=unknown
  MEGABRAIN_DISPATCH_LIVENESS_REASON=''
  MEGABRAIN_DISPATCH_LIVENESS_SOURCE=unknown
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      *) megabrain_error "unknown liveness option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
  agent="$(printf '%s' "$meta" | jq -r '.agent // empty')"
  state="$(printf '%s' "$meta" | jq -r '.state // "unknown"')"
  if [ "$runtime" = tmux ]; then
    # WHY: a pane id can be recycled; classify only after the terminal helper proves ownership.
    megabrain_dispatch_terminal_status "$meta"
    terminal_status="$MEGABRAIN_TERMINAL_STATUS"
    case "$state:$terminal_status" in
      closed:*)
        # WHY: a closed dispatch has no current agent, even if stale tmux state remains.
        MEGABRAIN_DISPATCH_LIVENESS_STATUS=missing
        MEGABRAIN_DISPATCH_LIVENESS_REASON='dispatch is closed'
        ;;
      *:missing)
        MEGABRAIN_DISPATCH_LIVENESS_STATUS=missing
        MEGABRAIN_DISPATCH_LIVENESS_REASON='terminal is no longer available'
        ;;
      *:unknown)
        MEGABRAIN_DISPATCH_LIVENESS_STATUS=unknown
        MEGABRAIN_DISPATCH_LIVENESS_REASON='terminal identity is unproven'
        ;;
      *:proven)
        agent="$(megabrain_tmux_agent_for_pane "$pane" 2>/dev/null || printf '%s' "$agent")"
        if output="$(megabrain_tmux_capture_pane "$pane" -200 2>/dev/null)" && [ -n "$output" ]; then
          MEGABRAIN_DISPATCH_LIVENESS_SOURCE=tmux
          if [ -n "$agent" ]; then
            megabrain_tmux_liveness_classify "$agent" "$output"
            MEGABRAIN_DISPATCH_LIVENESS_STATUS="${MEGABRAIN_TMUX_LIVENESS_STATUS:-unknown}"
            MEGABRAIN_DISPATCH_LIVENESS_REASON="${MEGABRAIN_TMUX_LIVENESS_REASON:-}"
          fi
        fi
        ;;
    esac
  fi
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg dispatchState "$(printf '%s' "$meta" | jq -r '.state // "unknown"')" \
      --arg terminalLiveness "$MEGABRAIN_DISPATCH_LIVENESS_STATUS" --arg source "$MEGABRAIN_DISPATCH_LIVENESS_SOURCE" \
      --arg reason "$MEGABRAIN_DISPATCH_LIVENESS_REASON" \
      '{dispatchId: $dispatchId, dispatchState: $dispatchState, terminalLiveness: $terminalLiveness, source: $source, reason: (if $reason == "" then null else $reason end)}'
  else
    printf 'dispatch: %s\nstate: %s\nterminal liveness: %s\nsource: %s\n' \
      "$dispatch_id" "$(printf '%s' "$meta" | jq -r '.state // "unknown"')" \
      "$MEGABRAIN_DISPATCH_LIVENESS_STATUS" "$MEGABRAIN_DISPATCH_LIVENESS_SOURCE"
    [ -n "$MEGABRAIN_DISPATCH_LIVENESS_REASON" ] && printf 'reason: %s\n' "$MEGABRAIN_DISPATCH_LIVENESS_REASON"
  fi
}

megabrain_dispatch_liveness() {
  local dispatch_id="${1:-}"
  case "$dispatch_id" in
    -h|--help) megabrain_usage_show orchestrate-liveness; return 0 ;;
  esac
  [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-liveness; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  megabrain_dispatch_liveness_read "$dispatch_id" "$@"
}

megabrain_dispatch_start_transcript() {
  local dispatch_id="$1" pane="$2" path
  path="$(megabrain_dispatch_transcript_path "$dispatch_id")" || return 1
  mkdir -p "$(dirname "$path")" || return 1
  touch "$path" || return 1
  declare -F megabrain_tmux_pipe_pane_start >/dev/null 2>&1 || return 1
  megabrain_tmux_pipe_pane_start "$pane" "$path"
}

megabrain_dispatch_stop_transcript() {
  local meta="$1" runtime pane dispatch_id transcript_path
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"' 2>/dev/null || true)"
  [ "$runtime" = tmux ] || return 0
  pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty' 2>/dev/null || true)"
  [ -n "$pane" ] || return 0
  declare -F megabrain_tmux_pipe_pane_stop >/dev/null 2>&1 || return 0
  megabrain_tmux_pipe_pane_stop "$pane" >/dev/null 2>&1 || true
  # Housekeeping for disk: bounds the file once its writer has stopped. This is not
  # the bound that protects the render path's memory use, which caps on every read
  # regardless of whether this ever runs (a pane that just dies never reaches here).
  dispatch_id="$(printf '%s' "$meta" | jq -r '.dispatchId // empty' 2>/dev/null || true)"
  if [ -n "$dispatch_id" ]; then
    transcript_path="$(megabrain_dispatch_transcript_path "$dispatch_id")" || return 0
    megabrain_transcript_truncate_file "$transcript_path" "$MEGABRAIN_TRANSCRIPT_MAX_BYTES" || true
  fi
  return 0
}

megabrain_dispatch_meta_read() {
  local dispatch_id="$1" path
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  if [ ! -f "$path" ]; then
    megabrain_error "dispatch not found: $dispatch_id"
    return 1
  fi
  jq -e . "$path" >/dev/null 2>&1 || { megabrain_error "dispatch metadata is not valid JSON: $dispatch_id"; return 1; }
  # WHY: stalled and timeout were persisted by older versions on the contract axis;
  # normalise them before any reader applies the current transition table.
  megabrain_dispatch_meta_normalize "$dispatch_id" || return 1
  cat "$path"
}

megabrain_dispatch_meta_update_state() {
  local dispatch_id="$1" state="$2" path current_state
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  megabrain_dispatch_meta_normalize "$dispatch_id" || return 1
  current_state="$(jq -r '.state // empty' "$path" 2>/dev/null || true)"
  [ -n "$current_state" ] || { megabrain_error "dispatch state is missing: $dispatch_id"; return 1; }
  megabrain_dispatch_validate_transition dispatch "$current_state" "$state" || return 1
  megabrain_dispatch_meta_update_fields "$dispatch_id" "$state" "__keep__" "__keep__" "__keep__" "__keep__" "__keep__" "__keep__" "__keep__" || return 1
  case "$state" in
    done|failed|circuit_broken)
      if ! megabrain_dispatch_release_terminal_process "$dispatch_id"; then
        # The dispatch outcome is durable queue state; terminal cleanup is housekeeping.
        # A cleanup failure must be recorded without rejecting the child outcome.
        megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ __keep__ retained __keep__ __keep__ __keep__ \
          'terminal release failed; process was not released' __keep__ || true
      fi
      ;;
  esac
}

megabrain_dispatch_terminal_status_required() {
  local meta="$1"
  if ! declare -F megabrain_dispatch_terminal_status >/dev/null 2>&1; then
    MEGABRAIN_DISPATCH_TERMINAL_STATUS_ERROR='terminal identity check unavailable'
    return 1
  fi
  if ! megabrain_dispatch_terminal_status "$meta"; then
    MEGABRAIN_DISPATCH_TERMINAL_STATUS_ERROR='terminal identity check failed'
    return 1
  fi
  return 0
}

megabrain_dispatch_release_terminal_process() {
  local dispatch_id="$1" meta runtime transcript_path process_state terminal_state terminal_status
  MEGABRAIN_DISPATCH_RELEASE_STATUS=not-released
  MEGABRAIN_DISPATCH_RELEASED_TERMINAL=false
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  terminal_state="$(printf '%s' "$meta" | jq -r '.terminalState // "owned"')"
  [ "$terminal_state" != released ] || {
    MEGABRAIN_DISPATCH_RELEASE_STATUS=released
    return 0
  }
  if [ "$runtime" = tmux ]; then
    transcript_path="$(megabrain_dispatch_transcript_path "$dispatch_id")" || return 1
    # WHY: the transcript is the durable record that makes releasing the live pane safe.
    [ -f "$transcript_path" ] || return 0
    megabrain_dispatch_release_tmux_process "$meta" || return 1
  else
    # Host terminals have no persisted transcript. Their terminal identity is the
    # durable record, so only a proven identity may be closed automatically.
    if ! megabrain_dispatch_terminal_status_required "$meta"; then
      megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ __keep__ retained __keep__ __keep__ __keep__ \
        "${MEGABRAIN_DISPATCH_TERMINAL_STATUS_ERROR}; process was not released" __keep__ || return 1
      MEGABRAIN_DISPATCH_RELEASE_STATUS=unproven
      return 0
    fi
    terminal_status="${MEGABRAIN_TERMINAL_STATUS:-unknown}"
    case "$terminal_status" in
      missing)
        MEGABRAIN_DISPATCH_RELEASED_TERMINAL=true
        MEGABRAIN_DISPATCH_RELEASE_STATUS=missing
        ;;
      unknown)
        megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ __keep__ retained __keep__ __keep__ __keep__ \
          'host terminal identity is unproven; process was not released' __keep__ || return 1
        MEGABRAIN_DISPATCH_RELEASE_STATUS=unproven
        return 0
        ;;
      proven)
        if ! megabrain_dispatch_native_close "$meta"; then
          megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ __keep__ retained __keep__ __keep__ __keep__ \
            "${MEGABRAIN_DISPATCH_CLOSE_ERROR:-terminal release failed; process was not released}" __keep__ || return 1
          MEGABRAIN_DISPATCH_RELEASE_STATUS=not-released
          return 0
        fi
        MEGABRAIN_DISPATCH_RELEASED_TERMINAL=true
        MEGABRAIN_DISPATCH_RELEASE_STATUS=released
        ;;
      *)
        return 1
        ;;
    esac
  fi
  if [ "$MEGABRAIN_DISPATCH_RELEASED_TERMINAL" = true ]; then
    process_state="$(printf '%s' "$meta" | jq -r '.processState // empty')"
    case "$process_state" in
      starting|start-unproven|running|stopping|stop-unproven) megabrain_dispatch_meta_update_process_state "$dispatch_id" stopped || return 1 ;;
    esac
    megabrain_dispatch_meta_update_terminal_state "$dispatch_id" released || return 1
  fi
}

megabrain_dispatch_meta_update_fields() {
  local dispatch_id="$1" state="$2" process_state="$3" terminal_state="$4"
  local stage="$5" reason="$6" outcome="$7" terminal_reason="$8" failure_count="$9"
  local path current_state current_process current_terminal tmp
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  current_state="$(jq -r '.state // empty' "$path" 2>/dev/null || true)"
  current_process="$(jq -r '.processState // empty' "$path" 2>/dev/null || true)"
  current_terminal="$(jq -r '.terminalState // empty' "$path" 2>/dev/null || true)"
  [ "$state" = __keep__ ] || megabrain_dispatch_validate_transition dispatch "$current_state" "$state" || return 1
  [ "$process_state" = __keep__ ] || megabrain_dispatch_validate_transition process "$current_process" "$process_state" || return 1
  [ "$terminal_state" = __keep__ ] || megabrain_dispatch_validate_transition terminal "$current_terminal" "$terminal_state" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.meta.XXXXXX")" || return 1
  if ! jq \
    --arg state "$state" --arg processState "$process_state" --arg terminalState "$terminal_state" \
    --arg stage "$stage" --arg reason "$reason" --arg outcome "$outcome" \
    --arg terminalReason "$terminal_reason" --arg failureCount "$failure_count" --arg now "$(megabrain_iso_now)" '
      . as $before
      | if $state == "__keep__" then . else .state = $state end
      | if $processState == "__keep__" then . else .processState = $processState end
      | if $terminalState == "__keep__" then . else .terminalState = $terminalState end
      | if $stage == "__keep__" then . elif $stage == "__clear__" then .stage = null else .stage = $stage end
      | if $reason == "__keep__" then . elif $reason == "__clear__" then .reason = null else .reason = $reason end
      | if $outcome == "__keep__" then . elif $outcome == "__clear__" then .reconcileOutcome = null else .reconcileOutcome = $outcome end
      | if $terminalReason == "__keep__" then . elif $terminalReason == "__clear__" then .terminalReason = null else .terminalReason = $terminalReason end
      | if $failureCount == "__keep__" then . else .failureCount = ($failureCount | tonumber) end
      | if . == $before then . else .updatedAt = $now end
    ' "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_meta_update_model_substitution() {
  local dispatch_id="$1" substitution="$2" path tmp
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.meta.XXXXXX")" || return 1
  if ! jq --arg substitution "$substitution" --arg now "$(megabrain_iso_now)" \
    '.modelHonored = false | .modelSubstitution = $substitution | .updatedAt = $now' \
    "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_meta_update_process_state() {
  local dispatch_id="$1" process_state="$2"
  megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ "$process_state" __keep__ __keep__ __keep__ __keep__ __keep__ __keep__
}

megabrain_dispatch_meta_update_terminal_state() {
  local dispatch_id="$1" terminal_state="$2"
  megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ __keep__ "$terminal_state" __keep__ __keep__ __keep__ __keep__ __keep__
}

megabrain_dispatch_meta_normalize() {
  local dispatch_id="$1" path tmp
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.meta.XXXXXX")" || return 1
  if ! jq '
    if .state == "stalled" or .state == "timeout" then .state = "running" else . end
    | .processState //= (if .state == "spawning" then "starting" elif .state == "running" then "running" elif .state == "done" then "succeeded" elif .state == "failed" then "failed" elif .state == "closed" then "stopped" else "start-unproven" end)
    | .terminalState //= "owned"
    | .terminalReason //= null
    | .failureCount //= 0
    | .stage //= null
    | .reason //= null
    | .reconcileOutcome //= null
    | .modelSubstitution //= null
    | .effort //= null
    | .promptPublication //= "unknown"
    | .promptTransport //= "unknown"
    | .promptReceipt //= "unknown"
    | .promptState //= "legacy"
  ' "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$path"
  fi
}

megabrain_dispatch_has_recent_child_activity() {
  local dispatch_id="$1" messages_dir path modified latest=0 now
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  for path in "$messages_dir"/*.json; do
    [ -f "$path" ] || continue
    jq -e '.from == "child" and (.type == "received" or .type == "ask" or .type == "done")' "$path" >/dev/null 2>&1 || continue
    modified="$(megabrain_path_mtime "$path" 2>/dev/null || true)"
    [[ "$modified" =~ ^[0-9]+$ ]] || continue
    [ "$modified" -gt "$latest" ] && latest="$modified"
  done
  [ "$latest" -gt 0 ] || return 1
  now="$(date +%s)"
  [ $((now - latest)) -le "$MEGABRAIN_DISPATCH_LIVE_ACTIVITY_WINDOW_SECONDS" ]
}

# A proven terminal only tells us the process is alive, not that it is still
# generating; the turn-end hook only runs once a turn has actually ended. So
# proven gets the same recent-activity debounce as unknown, instead of an
# unconditional skip: a live child that just spoke stays silent, but a live
# child sitting idle after its turn ended is still reported stalled. missing
# always reports, because there is nothing left to debounce against.
megabrain_dispatch_stalled_is_due() {
  local meta="$1" dispatch_id
  dispatch_id="$(printf '%s' "$meta" | jq -r '.dispatchId // empty' 2>/dev/null)"
  [ -n "$dispatch_id" ] || return 1
  megabrain_dispatch_terminal_status "$meta"
  case "${MEGABRAIN_TERMINAL_STATUS:-unknown}" in
    missing) return 0 ;;
    *) megabrain_dispatch_has_recent_child_activity "$dispatch_id" && return 1 ;;
  esac
  return 0
}

megabrain_dispatch_has_child_identity_proof() {
  local dispatch_id="$1" messages_dir path
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  for path in "$messages_dir"/*.json; do
    [ -f "$path" ] || continue
    jq -e '.from == "child" and (.type == "received" or .type == "ask" or .type == "done")' "$path" >/dev/null 2>&1 && return 0
  done
  return 1
}

megabrain_dispatch_has_prompt_receipt() {
  local dispatch_id="$1" messages_dir path
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  for path in "$messages_dir"/*.json; do
    [ -f "$path" ] || continue
    jq -e '.from == "child" and .type == "received"' "$path" >/dev/null 2>&1 && return 0
  done
  return 1
}

MEGABRAIN_DISPATCH_LIMIT_REFUSAL=false
MEGABRAIN_DISPATCH_LIMIT_REFUSAL_REASON=""

megabrain_dispatch_limit_refusal_read() {
  local dispatch_id="$1" meta runtime pane output
  MEGABRAIN_DISPATCH_LIMIT_REFUSAL=false
  MEGABRAIN_DISPATCH_LIMIT_REFUSAL_REASON=""
  meta="$(megabrain_dispatch_meta_read "$dispatch_id" 2>/dev/null || true)"
  [ -n "$meta" ] || return 1
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  [ "$runtime" = tmux ] || return 0
  pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
  [ -n "$pane" ] || return 0
  output="$(megabrain_tmux_capture_pane "$pane" -200 2>/dev/null || true)"
  # WHY: tmux captures echoed input too; a refusal needs both the anchored first
  # marker and the separate model-switch marker, so prose that merely quotes its
  # first line cannot trigger the guard.
  if printf '%s\n' "$output" | grep -E "^You've hit your usage limit for" >/dev/null 2>&1; then
    case "$output" in
      *"Switch to another model now,"*)
        MEGABRAIN_DISPATCH_LIMIT_REFUSAL=true
        MEGABRAIN_DISPATCH_LIMIT_REFUSAL_REASON="agent refused the dispatch: You've hit your usage limit for"
        ;;
    esac
  fi
}

megabrain_dispatch_mark_limit_refused() {
  local dispatch_id="$1" reason="${2:-${MEGABRAIN_DISPATCH_LIMIT_REFUSAL_REASON:-agent refused the dispatch for a usage limit}}"
  megabrain_dispatch_meta_update_prompt_layers "$dispatch_id" __keep__ __keep__ unknown failed "$reason" >/dev/null 2>&1 || true
  megabrain_dispatch_meta_update_fields "$dispatch_id" failed failed __keep__ limit-refused "$reason" limit-refused __keep__ __keep__
}

megabrain_dispatch_wait_for_prompt_receipt() {
  local dispatch_id="$1" timeout="${MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS:-30}" started now
  [[ "$timeout" =~ ^[0-9]+$ ]] || { megabrain_error "prompt receipt timeout is invalid: $timeout"; return 1; }
  [[ "$MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
    megabrain_error "prompt receipt poll interval is invalid: $MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL"
    return 1
  }
  started="$(date +%s)"
  while :; do
    megabrain_dispatch_has_prompt_receipt "$dispatch_id" && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$timeout" ] && return "$MEGABRAIN_PROMPT_RECEIPT_WAITING_STATUS"
    sleep "$MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL"
  done
}

megabrain_dispatch_sync_prompt_receipt() {
  local dispatch_id="$1" path delivery
  megabrain_dispatch_has_prompt_receipt "$dispatch_id" || return 0
  path="$(megabrain_dispatch_meta_path "$dispatch_id")" || return 1
  delivery="$(jq -r '.promptDelivery // "pending"' "$path" 2>/dev/null || true)"
  if [ "$delivery" = pending ] || [ "$delivery" = delivered ]; then
    megabrain_dispatch_meta_update_prompt "$dispatch_id" true delivered
  else
    # A legacy not-delivered value is retained as history; the receipt fact is still
    # recorded independently rather than rewriting what the old field meant.
    megabrain_dispatch_meta_update_prompt_layers "$dispatch_id" __keep__ __keep__ received confirmed __keep__
  fi
}

megabrain_dispatch_reconcile_one() {
  local dispatch_id="$1" meta state process_state terminal_status parent_status failure_count next_state next_process
  local stage reason outcome terminal_state next_terminal
  MEGABRAIN_RECONCILE_OUTCOME=unchanged
  if [ "${MEGABRAIN_RECONCILE_DRY_RUN:-false}" != true ]; then
    megabrain_dispatch_meta_normalize "$dispatch_id" || return 1
    megabrain_dispatch_sync_prompt_receipt "$dispatch_id" || return 1
  fi
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  state="$(printf '%s' "$meta" | jq -r '.state')"
  process_state="$(printf '%s' "$meta" | jq -r '.processState')"
  terminal_state="$(printf '%s' "$meta" | jq -r '.terminalState // "owned"')"
  [ "$state" != closed ] || return 0
  [ "$state" != circuit_broken ] || return 0
  megabrain_dispatch_terminal_status "$meta"
  terminal_status="${MEGABRAIN_TERMINAL_STATUS:-unknown}"
  if megabrain_dispatch_has_child_identity_proof "$dispatch_id"; then
    # WHY: A child message is direct identity proof, even when terminal inspection is inconclusive.
    terminal_status=proven
  fi
  case "$terminal_status" in
    missing)
      if [ "$process_state" = exited ]; then
        MEGABRAIN_RECONCILE_OUTCOME=unchanged
        return 0
      fi
      if [ "$process_state" = running ]; then
        megabrain_dispatch_reconcile_update "$dispatch_id" __keep__ exited missing agent-exit 'agent exited without reporting' agent-exited terminal-missing __keep__ || return 1
        MEGABRAIN_RECONCILE_OUTCOME=agent-exited
        return 0
      fi
      failure_count="$(printf '%s' "$meta" | jq -r '.failureCount // 0')"
      failure_count=$((failure_count + 1))
      next_state=failed
      [ "$failure_count" -ge 3 ] && next_state=circuit_broken
      # Abandoned ends logical authority without asserting that the process died.
      next_process=abandoned
      case "$process_state" in
        succeeded|failed|stopped|abandoned) next_process=__keep__ ;;
      esac
      megabrain_dispatch_reconcile_update "$dispatch_id" "$next_state" "$next_process" missing terminal-missing terminal-missing terminal-missing terminal-missing "$failure_count" || return 1
      MEGABRAIN_RECONCILE_OUTCOME=terminal-missing
      ;;
    proven)
      megabrain_dispatch_parent_status "$meta"
      parent_status="${MEGABRAIN_PARENT_STATUS:-unknown}"
      case "$parent_status" in
        gone)
          next_state=__keep__
          case "$process_state:$state" in
            starting:*|start-unproven:*|running:*|stopping:*|stop-unproven:*) next_state=orphaned ;;
          esac
          # Retained blocks release while the orphaned terminal remains under review.
          megabrain_dispatch_reconcile_update "$dispatch_id" "$next_state" __keep__ retained parent-missing parent-missing orphaned parent-missing __keep__ || return 1
          MEGABRAIN_RECONCILE_OUTCOME=orphaned
          ;;
        alive)
          next_state=__keep__
          next_process=__keep__
          next_terminal=__keep__
          [ "$state" = spawning ] || [ "$state" = orphaned ] && next_state=running
          case "$process_state" in
            starting|start-unproven) next_process=running ;;
          esac
          [ "$terminal_state" = retained ] && next_terminal=owned
          megabrain_dispatch_reconcile_update "$dispatch_id" "$next_state" "$next_process" "$next_terminal" terminal-proven identity-proven adopted __keep__ __keep__ || return 1
          MEGABRAIN_RECONCILE_OUTCOME=adopted
          ;;
        *)
          megabrain_dispatch_reconcile_update "$dispatch_id" __keep__ __keep__ __keep__ parent-unproven parent-unproven parent-unproven __keep__ __keep__ || return 1
          MEGABRAIN_RECONCILE_OUTCOME=parent-unproven
          ;;
      esac
      ;;
    *)
      next_process=__keep__
      [ "$process_state" = starting ] && next_process=start-unproven
      # Retained blocks release while terminal identity is unproven.
      megabrain_dispatch_reconcile_update "$dispatch_id" __keep__ "$next_process" retained identity-unproven identity-unproven identity-unproven identity-unproven __keep__ || return 1
      MEGABRAIN_RECONCILE_OUTCOME=identity-unproven
      ;;
  esac
}

megabrain_dispatch_reconcile_update() {
  [ "${MEGABRAIN_RECONCILE_DRY_RUN:-false}" = true ] && return 0
  megabrain_dispatch_meta_update_fields "$@"
}

megabrain_dispatch_reconcile() {
  local dispatch_id="" all=false json=false arg meta_path meta entries='[]' outcome
  case "${1:-}" in
    -h|--help)
      megabrain_usage_show orchestrate-reconcile
      return 0
      ;;
  esac
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --all) all=true; shift ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-reconcile; return 0 ;;
      *)
        [ -z "$dispatch_id" ] || { megabrain_error "unknown reconcile option: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }
        dispatch_id="$arg"
        shift
        ;;
    esac
  done
  if [ "$all" = true ]; then
    for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
      [ -f "$meta_path" ] || continue
      dispatch_id="$(jq -r '.dispatchId' "$meta_path")"
      megabrain_dispatch_reconcile_one "$dispatch_id" || return 1
      meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
      outcome="${MEGABRAIN_RECONCILE_OUTCOME:-unchanged}"
      entries="$(jq --argjson item "$meta" --arg outcome "$outcome" '. + [$item + {reconcileResult: $outcome}]' <<<"$entries")" || return 1
    done
  else
    [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-reconcile; return "$MEGABRAIN_USAGE_ERROR"; }
    megabrain_dispatch_reconcile_one "$dispatch_id" || return 1
    meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
    outcome="${MEGABRAIN_RECONCILE_OUTCOME:-unchanged}"
    entries="$(jq --argjson item "$meta" --arg outcome "$outcome" '. + [$item + {reconcileResult: $outcome}]' <<<"$entries")" || return 1
  fi
  if [ "$json" = true ]; then
    printf '%s\n' "$entries" | jq 'if length == 1 then .[0] else . end'
  else
    printf '%s\n' "$entries" | jq -r '.[] | [.dispatchId, .reconcileResult, .state, .processState, .terminalState] | @tsv' | while IFS=$'\t' read -r dispatch outcome state process terminal; do
      printf 'dispatch: %s\nresult: %s\nstate: %s\nprocess: %s\nterminal: %s\n' "$dispatch" "$outcome" "$state" "$process" "$terminal"
    done
  fi
}

megabrain_dispatch_health_counts() {
  local meta_path meta records='[]' dispatch_path dispatch_name state timestamp timestamp_epoch cutoff
  local runtime tmux_session leaked_sessions=''
  MODULE_UNCERTAIN_DISPATCHES=0
  MODULE_RETAINED_TERMINALS=0
  MODULE_LEAKED_DISPATCH_SESSIONS=0
  MODULE_PRUNABLE_DISPATCHES=0
  MODULE_UNCERTAIN_REASONS='[]'
  MODULE_RETAINED_REASONS='[]'
  MODULE_UNTRACKED_DISPATCHES=""
  for dispatch_path in "$MEGABRAIN_DISPATCH_DIR"/*; do
    [ -d "$dispatch_path" ] || continue
    dispatch_name="${dispatch_path##*/}"
    [ "$dispatch_name" = archive ] && continue
    [ -f "$dispatch_path/meta.json" ] && continue
    if [ -n "$MODULE_UNTRACKED_DISPATCHES" ]; then
      MODULE_UNTRACKED_DISPATCHES="$MODULE_UNTRACKED_DISPATCHES, $dispatch_name"
    else
      MODULE_UNTRACKED_DISPATCHES="$dispatch_name"
    fi
  done
  if [ -n "$MODULE_UNTRACKED_DISPATCHES" ]; then
    megabrain_notice "dispatch directories without metadata: $MODULE_UNTRACKED_DISPATCHES"
  fi
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    meta="$(cat "$meta_path" 2>/dev/null || true)"
    printf '%s' "$meta" | jq -e . >/dev/null 2>&1 || continue
    records="$(jq --argjson item "$meta" '. + [$item]' <<<"$records")" || continue
  done
  MODULE_UNCERTAIN_DISPATCHES="$(printf '%s' "$records" | jq '[.[] | select((.processState // "") == "start-unproven" or (.processState // "") == "stop-unproven" or (.processState // "") == "abandoned" or (.processState // "") == "exited")] | length')"
  MODULE_RETAINED_TERMINALS="$(printf '%s' "$records" | jq '[.[] | select((.terminalState // "") == "retained")] | length')"
  MODULE_UNCERTAIN_REASONS="$(printf '%s' "$records" | jq '[.[] | select((.processState // "") == "start-unproven" or (.processState // "") == "stop-unproven" or (.processState // "") == "abandoned" or (.processState // "") == "exited") | {dispatchId, reason: (if .processState == "start-unproven" then "process start was not proven" elif .processState == "stop-unproven" then "process stop was not proven" elif .processState == "exited" then "agent exited without reporting" else "process was abandoned without proof" end), processState, terminalState}]')"
  MODULE_RETAINED_REASONS="$(printf '%s' "$records" | jq '[.[] | select((.terminalState // "") == "retained") | {dispatchId, reason: (.terminalReason // "terminal identity remains unproven"), processState, terminalState}]')"
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    state="$(jq -r '.state // empty' "$meta_path" 2>/dev/null || true)"
    megabrain_dispatch_prune_state_terminal "$state" || continue
    meta="$(cat "$meta_path" 2>/dev/null || true)"
    runtime="$(jq -r '.runtime // "host"' "$meta_path" 2>/dev/null || true)"
    [ "$runtime" = tmux ] || continue
    tmux_session="$(jq -r '.tmuxSession // empty' "$meta_path" 2>/dev/null || true)"
    [ -n "$tmux_session" ] || continue
    megabrain_dispatch_tmux_session_owned "$meta" || continue
    declare -F megabrain_tmux_session_exists >/dev/null 2>&1 || continue
    megabrain_tmux_session_exists "$tmux_session" || continue
    if ! printf '%s\n' "$leaked_sessions" | grep -Fx "$tmux_session" >/dev/null 2>&1; then
      if [ -n "$leaked_sessions" ]; then
        leaked_sessions="$leaked_sessions"$'\n'"$tmux_session"
      else
        leaked_sessions="$tmux_session"
      fi
      MODULE_LEAKED_DISPATCH_SESSIONS=$((MODULE_LEAKED_DISPATCH_SESSIONS + 1))
    fi
  done
  cutoff=$(( $(date -u +%s) - MEGABRAIN_DISPATCH_PRUNE_DEFAULT_DAYS * 86400 ))
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    state="$(jq -r '.state // empty' "$meta_path" 2>/dev/null || true)"
    megabrain_dispatch_prune_state_terminal "$state" || continue
    timestamp="$(jq -r 'if has("updatedAt") and .updatedAt != null and .updatedAt != "" then .updatedAt else .createdAt // empty end' "$meta_path" 2>/dev/null || true)"
    timestamp_epoch="$(megabrain_dispatch_timestamp_epoch "$timestamp" 2>/dev/null || true)"
    [[ "$timestamp_epoch" =~ ^[0-9]+$ ]] && [ "$timestamp_epoch" -le "$cutoff" ] || continue
    MODULE_PRUNABLE_DISPATCHES=$((MODULE_PRUNABLE_DISPATCHES + 1))
  done
}

megabrain_dispatch_prune_state_terminal() {
  # WHY: this is the archive policy, narrower than the transition table. A state may
  # still be recoverable (orphaned) while old dispatch records are safe to archive.
  case ",$(megabrain_dispatch_prune_states)," in
    *,"$1",*) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_dispatch_prune_state_selected() {
  case ",$2," in
    *,"$1",*) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_dispatch_timestamp_epoch() {
  local timestamp="$1" epoch
  epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$timestamp" '+%s' 2>/dev/null || true)"
  if ! [[ "$epoch" =~ ^[0-9]+$ ]]; then
    epoch="$(date -u -d "$timestamp" '+%s' 2>/dev/null || true)"
  fi
  [[ "$epoch" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$epoch"
}

megabrain_dispatch_prune_release() {
  local dispatch_id="$1" meta="$2" runtime terminal_state
  MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON=""
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  if [ "$runtime" = host ]; then
    if ! megabrain_dispatch_release_terminal_process "$dispatch_id"; then
      MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON='could not release dispatch terminal'
      return 1
    fi
    terminal_state="$(jq -r '.terminalState // "owned"' "$(megabrain_dispatch_meta_path "$dispatch_id")" 2>/dev/null || printf 'owned')"
    if [ "$terminal_state" = retained ]; then
      MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON='host terminal identity is unproven; dispatch terminal was retained'
      return 1
    fi
    return 0
  fi
  megabrain_dispatch_release_tmux_session "$meta" || {
    MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON='could not release dispatch terminal'
    return 1
  }
  if [ "${MEGABRAIN_DISPATCH_TERMINAL_STATUS:-unknown}" = unknown ]; then
    MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON='terminal identity is unproven'
    return 1
  fi
  return 0
}

megabrain_dispatch_prune() {
  local older_than="$MEGABRAIN_DISPATCH_PRUNE_DEFAULT_DAYS" state_filter="$(megabrain_dispatch_prune_states)"
  local mode=archive dry_run=false json=false arg now_epoch cutoff archive_month
  local meta_path dispatch_dir dispatch_id state process_state terminal_state timestamp timestamp_epoch reason target reconcile_outcome reconcile_rc meta
  local archived_ids='[]' deleted_ids='[]' skipped_dispatches='[]'
  local archived_count=0 deleted_count=0 skipped_count=0
  case "${1:-}" in
    -h|--help) megabrain_usage_show orchestrate-prune; return 0 ;;
  esac
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --older-than) older_than="${2:-}"; shift 2 ;;
      --state) state_filter="${2:-}"; shift 2 ;;
      --archive) mode=archive; shift ;;
      --delete) mode=delete; shift ;;
      --dry-run) dry_run=true; shift ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-prune; return 0 ;;
      *) megabrain_error "unknown orchestrate prune option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [[ "$older_than" =~ ^[0-9]+$ ]] || { megabrain_error "--older-than must be a non-negative number of days"; return "$MEGABRAIN_USAGE_ERROR"; }
  [ -n "$state_filter" ] || { megabrain_error "--state must not be empty"; return "$MEGABRAIN_USAGE_ERROR"; }
  case "$state_filter" in
    *[!A-Za-z0-9_,-]*) megabrain_error "--state must be a comma-separated list of dispatch states"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
  now_epoch="$(date -u +%s)"
  cutoff=$((now_epoch - older_than * 86400))
  archive_month="$(date -u '+%Y-%m')"
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    dispatch_dir="${meta_path%/meta.json}"
    dispatch_id="${dispatch_dir##*/}"
    state="$(jq -r '.state // empty' "$meta_path" 2>/dev/null || true)"
    process_state="$(jq -r '.processState // empty' "$meta_path" 2>/dev/null || true)"
    terminal_state="$(jq -r '.terminalState // empty' "$meta_path" 2>/dev/null || true)"
    if ! megabrain_dispatch_prune_state_terminal "$state" && {
      [ "$terminal_state" = retained ] ||
      [ "$process_state" = start-unproven ] ||
      [ "$process_state" = stop-unproven ] ||
      [ "$process_state" = abandoned ] ||
      [ "$process_state" = exited ];
    }; then
      if [ "$dry_run" = true ]; then
        MEGABRAIN_RECONCILE_DRY_RUN=true
        megabrain_dispatch_reconcile_one "$dispatch_id"
        reconcile_rc=$?
        unset MEGABRAIN_RECONCILE_DRY_RUN
        [ "$reconcile_rc" -eq 0 ] || continue
      else
        megabrain_dispatch_reconcile_one "$dispatch_id" || continue
      fi
      reconcile_outcome="${MEGABRAIN_RECONCILE_OUTCOME:-unchanged}"
      state="$(jq -r '.state // empty' "$meta_path" 2>/dev/null || true)"
      if [ "$reconcile_outcome" = terminal-missing ] && ! megabrain_dispatch_prune_state_terminal "$state"; then
        state=failed
      fi
    fi
    reason=""
    if ! megabrain_dispatch_prune_state_terminal "$state"; then
      if [ -n "$state" ]; then
        reason="state $state is not terminal"
      else
        reason="state is missing or unknown"
      fi
    elif ! megabrain_dispatch_prune_state_selected "$state" "$state_filter"; then
      reason="state $state was not selected"
    elif ! jq -e 'has("updatedAt") and .updatedAt != null and .updatedAt != ""' "$meta_path" >/dev/null 2>&1 &&
      ! jq -e 'has("createdAt") and .createdAt != null and .createdAt != ""' "$meta_path" >/dev/null 2>&1; then
      reason="updatedAt and createdAt are missing"
    else
      timestamp="$(jq -r 'if has("updatedAt") and .updatedAt != null and .updatedAt != "" then .updatedAt else .createdAt end' "$meta_path" 2>/dev/null || true)"
      timestamp_epoch="$(megabrain_dispatch_timestamp_epoch "$timestamp" 2>/dev/null || true)"
      if ! [[ "$timestamp_epoch" =~ ^[0-9]+$ ]]; then
        reason="invalid timestamp: $timestamp"
      elif [ "$timestamp_epoch" -gt "$cutoff" ]; then
        reason="younger than $older_than days"
      fi
    fi
    if [ -n "$reason" ]; then
      skipped_count=$((skipped_count + 1))
      skipped_dispatches="$(jq --arg dispatchId "$dispatch_id" --arg state "$state" --arg reason "$reason" '. + [{dispatchId: $dispatchId, state: (if $state == "" then null else $state end), reason: $reason}]' <<<"$skipped_dispatches")"
      continue
    fi
    if [ "$mode" = archive ]; then
      target="$MEGABRAIN_DISPATCH_DIR/archive/$archive_month/$dispatch_id"
    else
      target=""
    fi
    if [ "$dry_run" = true ]; then
      if [ "$mode" = archive ]; then
        archived_ids="$(jq --arg dispatchId "$dispatch_id" --arg path "$target" '. + [{dispatchId: $dispatchId, path: $path}]' <<<"$archived_ids")"
      else
        deleted_ids="$(jq --arg dispatchId "$dispatch_id" '. + [$dispatchId]' <<<"$deleted_ids")"
      fi
      continue
    fi
    if [ "$mode" = archive ]; then
      if [ -e "$target" ]; then
        reason="archive destination already exists"
      elif ! meta="$(cat "$meta_path")"; then
        reason="could not read dispatch metadata"
      else
        if ! megabrain_dispatch_prune_release "$dispatch_id" "$meta"; then
          reason="${MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON:-could not release dispatch terminal}"
        elif mkdir -p "$(dirname "$target")" && mv "$dispatch_dir" "$target"; then
          archived_count=$((archived_count + 1))
          archived_ids="$(jq --arg dispatchId "$dispatch_id" --arg path "$target" '. + [{dispatchId: $dispatchId, path: $path}]' <<<"$archived_ids")"
          continue
        else
          reason="could not archive dispatch"
        fi
      fi
    elif ! meta="$(cat "$meta_path")"; then
      reason="could not read dispatch metadata"
    else
      if ! megabrain_dispatch_prune_release "$dispatch_id" "$meta"; then
        reason="${MEGABRAIN_DISPATCH_PRUNE_RELEASE_REASON:-could not release dispatch terminal}"
      elif rm -rf "$dispatch_dir"; then
        deleted_count=$((deleted_count + 1))
        deleted_ids="$(jq --arg dispatchId "$dispatch_id" '. + [$dispatchId]' <<<"$deleted_ids")"
        continue
      else
        reason="could not delete dispatch"
      fi
    fi
    skipped_count=$((skipped_count + 1))
    skipped_dispatches="$(jq --arg dispatchId "$dispatch_id" --arg state "$state" --arg reason "$reason" '. + [{dispatchId: $dispatchId, state: (if $state == "" then null else $state end), reason: $reason}]' <<<"$skipped_dispatches")"
  done
  if [ "$dry_run" = true ]; then
    archived_count="$(printf '%s' "$archived_ids" | jq 'length')"
    deleted_count="$(printf '%s' "$deleted_ids" | jq 'length')"
  fi
  if [ "$json" = true ]; then
    jq -n --arg mode "$mode" --argjson dryRun "$(megabrain_bool_json "$dry_run")" \
      --argjson olderThanDays "$older_than" --argjson archived "$archived_ids" \
      --argjson deleted "$deleted_ids" --argjson skipped "$skipped_dispatches" \
      --argjson archivedCount "$archived_count" --argjson deletedCount "$deleted_count" \
      --argjson skippedCount "$skipped_count" \
      '{mode: $mode, dryRun: $dryRun, olderThanDays: $olderThanDays, archived: $archivedCount, deleted: $deletedCount, skipped: $skippedCount, archivedDispatches: $archived, deletedDispatches: $deleted, skippedDispatches: $skipped}'
  else
    printf 'mode: %s\ndry-run: %s\nolder-than-days: %s\n' "$mode" "$dry_run" "$older_than"
    if [ "$mode" = archive ]; then
      printf '%s\n' "$archived_ids" | jq -r '.[] | (if .path then (if "'"$dry_run"'" == "true" then "would archive: " else "archived: " end) + .dispatchId else empty end)'
    else
      printf '%s\n' "$deleted_ids" | jq -r '.[] | (if "'"$dry_run"'" == "true" then "would delete: " else "deleted: " end) + .'
    fi
    printf 'skipped: %s\n' "$skipped_count"
    printf '%s\n' "$skipped_dispatches" | jq -r '.[] | "skipped: " + .dispatchId + " (" + .reason + ")"'
  fi
}

megabrain_dispatch_cursor_read() {
  local dispatch_id="$1" path value
  path="$(megabrain_dispatch_cursor_path "$dispatch_id")" || return 1
  if [ ! -f "$path" ]; then
    printf '{"lastReadSeq":0}\n' >"$path" || return 1
  fi
  value="$(jq -r '.lastReadSeq // 0' "$path" 2>/dev/null || true)"
  [[ "$value" =~ ^[0-9]+$ ]] || { megabrain_error "dispatch cursor is invalid: $dispatch_id"; return 1; }
  printf '%s\n' "$value"
}

megabrain_dispatch_cursor_write() {
  local dispatch_id="$1" seq="$2" path tmp
  path="$(megabrain_dispatch_cursor_path "$dispatch_id")" || return 1
  tmp="$(mktemp "$(megabrain_dispatch_dir "$dispatch_id")/.cursor.XXXXXX")" || return 1
  jq -n --argjson seq "$seq" '{lastReadSeq: $seq}' >"$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$path"
}

# WHY: the lock is a directory, so it survives the process that made it. A writer killed
# between mkdir and rmdir used to jam the mailbox forever, and every ask, done, received
# and reply for that dispatch waits here. The wait is bounded so a caller gets an error it
# can report, and a lock older than any real critical section is treated as ownerless and
# broken. A lock younger than that is never stolen: stealing it would reintroduce the lost
# message the lock exists to prevent.
MEGABRAIN_LOCK_WAIT_SECONDS="${MEGABRAIN_LOCK_WAIT_SECONDS:-15}"
MEGABRAIN_LOCK_STALE_SECONDS="${MEGABRAIN_LOCK_STALE_SECONDS:-30}"

megabrain_dispatch_lock_acquire() {
  local lock="$1" waited=0 deadline age now
  deadline=$(( $(date +%s) + MEGABRAIN_LOCK_WAIT_SECONDS ))
  while ! mkdir "$lock" 2>/dev/null; do
    now="$(date +%s)"
    age="$(megabrain_dispatch_path_age_seconds "$lock")"
    if [ -n "$age" ] && [ "$age" -ge "$MEGABRAIN_LOCK_STALE_SECONDS" ]; then
      rmdir "$lock" 2>/dev/null || rm -rf "$lock" 2>/dev/null || true
      continue
    fi
    if [ "$now" -ge "$deadline" ]; then
      megabrain_error "mailbox lock is held by another writer: $lock"
      return 1
    fi
    sleep 0.02
    waited=$((waited + 1))
  done
}

megabrain_dispatch_path_age_seconds() {
  local path="$1" mtime now
  mtime="$(megabrain_path_mtime "$path")" || return 0
  now="$(date +%s)"
  printf '%s\n' $((now - mtime))
}

megabrain_dispatch_message_append_locked() {
  local dispatch_id="$1" from="$2" type="$3" text="$4" session_id="$5"
  local supersedes_json="${6:-null}"
  local messages_dir path tmp seq file_name recipient meta notify=false class
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  seq="$(find "$messages_dir" -maxdepth 1 -type f -name '*.json' -print 2>/dev/null | sed 's|.*/||; s|-.*||' | sort -n | tail -n 1)"
  [ -n "$seq" ] || seq=0
  seq=$((10#$seq + 1))
  file_name="$(printf '%04d-%s-%s.json' "$seq" "$from" "$type")"
  path="$messages_dir/$file_name"
  tmp="$(mktemp "$messages_dir/.message.XXXXXX")" || return 1
  if [ "$supersedes_json" = null ]; then
    if ! jq -n --argjson seq "$seq" --arg from "$from" --arg type "$type" --arg text "$text" \
      --arg createdAt "$(megabrain_iso_now)" --arg sessionId "$session_id" \
      '{seq: $seq, from: $from, type: $type, text: $text, createdAt: $createdAt, sessionId: $sessionId}' >"$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  elif ! jq -n --argjson seq "$seq" --arg from "$from" --arg type "$type" --arg text "$text" \
    --arg createdAt "$(megabrain_iso_now)" --arg sessionId "$session_id" --argjson supersedes "$supersedes_json" \
    '{seq: $seq, from: $from, type: $type, text: $text, createdAt: $createdAt, sessionId: $sessionId, supersedes: $supersedes}' >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
  MEGABRAIN_LAST_MESSAGE_SEQ="$seq"
  MEGABRAIN_LAST_MESSAGE_NUDGE=""
  case "$from:$type" in
    parent:reply) recipient=child; notify=true ;;
    parent:withdrawal|parent:interrupt|parent:interrupt-result) recipient=child ;;
    *)
      class="$(megabrain_dispatch_mail_class_for_message "$dispatch_id" "$from:$type" "$seq" 2>/dev/null || true)"
      case "$class" in
        actionable) recipient=parent; notify=true ;;
        protocol) recipient=parent ;;
        *) recipient='' ;;
      esac
      ;;
  esac
  if [ -n "$recipient" ]; then
    # WHY: the message write is the event. Addressing is durable before either side reads it;
    # the reader claims the delivery and supplies the process-specific fence later.
    megabrain_dispatch_delivery_create "$dispatch_id" "$recipient" "[$seq]" >/dev/null || return 1
    meta="$(megabrain_dispatch_meta_read "$dispatch_id" 2>/dev/null || true)"
    if [ -n "$meta" ] && [ "$notify" = true ]; then
      if [ "$recipient" = parent ]; then
        type megabrain_parent_notify_dispatch >/dev/null 2>&1 &&
          megabrain_parent_notify_dispatch "$meta" >/dev/null 2>&1 || true
      else
        megabrain_dispatch_native_send "$meta" "$(megabrain_dispatch_reply_pointer "$dispatch_id")" >/dev/null 2>&1
        MEGABRAIN_LAST_MESSAGE_NUDGE="${MEGABRAIN_DISPATCH_NATIVE_SEND_STATUS:-not-typed}"
      fi
    fi
  fi
  printf '%s\n' "$seq"
}

megabrain_dispatch_message_append() {
  local dispatch_id="$1" lock
  lock="$(megabrain_dispatch_messages_dir "$dispatch_id")/.lock"
  megabrain_dispatch_lock_acquire "$lock" || return 1
  if ! megabrain_dispatch_message_append_locked "$@"; then
    rmdir "$lock"
    return 1
  fi
  rmdir "$lock"
}

megabrain_dispatch_message_paths() {
  local messages_dir="$1" path seq
  for path in "$messages_dir"/*.json; do
    [ -f "$path" ] || continue
    seq="$(jq -r '.seq // 0' "$path" 2>/dev/null || true)"
    [[ "$seq" =~ ^[0-9]+$ ]] || continue
    printf '%s\t%s\n' "$seq" "$path"
  done | sort -n -k1,1
}

megabrain_dispatch_last_child_message() {
  local dispatch_id="$1" messages_dir path latest_path=""
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  while IFS=$'\t' read -r _ path; do
    [ -n "$path" ] || continue
    jq -e '.from == "child"' "$path" >/dev/null 2>&1 || continue
    latest_path="$path"
  done < <(megabrain_dispatch_message_paths "$messages_dir")
  [ -n "$latest_path" ] || return 1
  jq -r '.text // empty' "$latest_path"
}

megabrain_dispatch_mail_class() {
  local key="$1" candidate
  for candidate in "${MEGABRAIN_DISPATCH_MAIL_ACTIONABLE_KEYS[@]}"; do
    [ "$candidate" = "$key" ] && { printf 'actionable\n'; return 0; }
  done
  for candidate in "${MEGABRAIN_DISPATCH_MAIL_PROTOCOL_KEYS[@]}"; do
    [ "$candidate" = "$key" ] && { printf 'protocol\n'; return 0; }
  done
  return 1
}

megabrain_dispatch_has_prior_child_done() {
  local dispatch_id="$1" before_seq="${2:-}" messages_dir path candidate_seq
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  for path in "$messages_dir"/*.json; do
    [ -f "$path" ] || continue
    if [ -n "$before_seq" ]; then
      candidate_seq="$(jq -r '.seq // 0' "$path" 2>/dev/null || true)"
      [[ "$candidate_seq" =~ ^[0-9]+$ ]] || continue
      [ "$candidate_seq" -lt "$before_seq" ] || continue
    fi
    jq -e '.from == "child" and .type == "done"' "$path" >/dev/null 2>&1 && return 0
  done
  return 1
}

megabrain_dispatch_mail_class_for_message() {
  local dispatch_id="$1" key="$2" message_seq="${3:-}" classification_key="$2"
  if [ "$key" = child:done ] && megabrain_dispatch_has_prior_child_done "$dispatch_id" "$message_seq"; then
    classification_key=child:done-repeat
  fi
  megabrain_dispatch_mail_class "$classification_key"
}

megabrain_dispatch_delivery_mark_superseded() {
  local path="$1" delivered="$2" tmp now
  now="$(megabrain_iso_now)"
  tmp="$(mktemp "$(dirname "$path")/.delivery.XXXXXX")" || return 1
  if [ "$delivered" = true ]; then
    if ! jq --arg now "$now" \
      '.superseded = true | .supersededAt = $now | .updatedAt = $now' "$path" >"$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  elif ! jq --arg now "$now" \
    '.status = "superseded" | .superseded = true | .supersededAt = $now | .updatedAt = $now' "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_supersede_replies_locked() {
  local dispatch_id="$1" session_id="$2"
  local deliveries_dir path status consumer message_seqs withdrawal_text sequences_text
  local already_superseded=false
  MEGABRAIN_LAST_SUPERSEDE_QUEUED=0
  MEGABRAIN_LAST_SUPERSEDE_DELIVERED=0
  MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES='[]'
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")" || return 1
  for path in "$deliveries_dir"/*.json; do
    [ -f "$path" ] || continue
    megabrain_dispatch_delivery_is_reply "$dispatch_id" "$path" || continue
    already_superseded="$(jq -r '.superseded // false' "$path" 2>/dev/null || printf 'false')"
    [ "$already_superseded" = true ] && continue
    status="$(jq -r '.status // empty' "$path" 2>/dev/null || true)"
    consumer="$(jq -r '.consumer // empty' "$path" 2>/dev/null || true)"
    message_seqs="$(jq -c '.messageSeqs // []' "$path" 2>/dev/null || printf '[]')"
    case "$status:$consumer" in
      outstanding:)
        megabrain_dispatch_delivery_mark_superseded "$path" false || return 1
        MEGABRAIN_LAST_SUPERSEDE_QUEUED=$((MEGABRAIN_LAST_SUPERSEDE_QUEUED + 1))
        ;;
      outstanding:*|acknowledged:*|fenced:*)
        megabrain_dispatch_delivery_mark_superseded "$path" true || return 1
        MEGABRAIN_LAST_SUPERSEDE_DELIVERED=$((MEGABRAIN_LAST_SUPERSEDE_DELIVERED + 1))
        MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES="$(jq -c --argjson additions "$message_seqs" '. + $additions' <<<"$MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES")" || return 1
        ;;
      *)
        continue
        ;;
    esac
  done
  if [ "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED" -gt 0 ]; then
    sequences_text="$(jq -r 'map(tostring) | join(", ")' <<<"$MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES")"
    withdrawal_text="withdrawn parent direction message sequence(s): $sequences_text"
    megabrain_dispatch_message_append_locked "$dispatch_id" parent withdrawal "$withdrawal_text" "$session_id" "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES" >/dev/null || return 1
  fi
}

megabrain_dispatch_delivery_is_reply() {
  local dispatch_id="$1" delivery_path="$2" messages_dir message_seqs seq path found=false
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  message_seqs="$(jq -c '.messageSeqs // []' "$delivery_path")" || return 1
  while IFS=$'\t' read -r seq path; do
    [ -n "$path" ] || continue
    jq -n -e --argjson seqs "$message_seqs" --argjson seq "$seq" '$seqs | index($seq) != null' >/dev/null 2>&1 || continue
    jq -e '.from == "parent" and .type == "reply"' "$path" >/dev/null 2>&1 || return 1
    found=true
  done < <(megabrain_dispatch_message_paths "$messages_dir")
  [ "$found" = true ]
}

megabrain_dispatch_has_reply_receipt() {
  local dispatch_id="$1" delivery_id="$2" messages_dir path
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  for path in "$messages_dir"/*.json; do
    [ -f "$path" ] || continue
    jq -e --arg deliveryId "$delivery_id" \
      '.from == "child" and .type == "ack" and .text == $deliveryId' \
      "$path" >/dev/null 2>&1 && return 0
  done
  return 1
}

megabrain_dispatch_failure_error() {
  local dispatch_id="$1" reason="$2" message
  message="$(megabrain_dispatch_last_child_message "$dispatch_id" 2>/dev/null || true)"
  if [ -n "$message" ]; then
    megabrain_error "$reason; child message: \"$message\""
  else
    megabrain_error "$reason"
  fi
}

megabrain_dispatch_seq_acknowledged() {
  local deliveries_dir="$1" seq="$2" path
  for path in "$deliveries_dir"/*.json; do
    [ -f "$path" ] || continue
    if jq -e --argjson seq "$seq" '.status == "acknowledged" and ((.messageSeqs // []) | index($seq) != null)' "$path" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

megabrain_dispatch_delivery_fence() {
  local path="$1" tmp now
  now="$(megabrain_iso_now)"
  tmp="$(mktemp "$(dirname "$path")/.delivery.XXXXXX")" || return 1
  if ! jq --arg now "$now" '.status = "fenced" | .fencedAt = $now | .updatedAt = $now' "$path" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_dispatch_delivery_report() {
  local dispatch_id="$1" delivery_id="$2" replayed="$3" json="$4"
  local record messages_dir deliveries_dir message_seqs messages='[]' path seq from type text status='done'
  record="$(cat "$(megabrain_dispatch_delivery_path "$dispatch_id" "$delivery_id")")" || return 1
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")"
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")"
  message_seqs="$(printf '%s' "$record" | jq -c '.messageSeqs')"
  while IFS=$'\t' read -r seq path; do
    [ -n "$path" ] || continue
    if ! jq -n -e --argjson seqs "$message_seqs" --argjson seq "$seq" '$seqs | index($seq) != null' >/dev/null 2>&1; then
      continue
    fi
    messages="$(jq --argjson item "$(cat "$path")" '. + [$item]' <<<"$messages")" || return 1
  done < <(megabrain_dispatch_message_paths "$messages_dir")
  type="$(printf '%s' "$messages" | jq -r '.[0].type // empty')"
  case "$type" in
    ask) status=waiting_for_reply ;;
    done) status=done ;;
    stalled) status=stalled ;;
    reply) status=reply ;;
    withdrawal) status=withdrawal ;;
    received) status=received ;;
    ack) status=acknowledged ;;
    *) status=done ;;
  esac
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg deliveryId "$delivery_id" \
      --argjson replayed "$(megabrain_bool_json "$replayed")" --arg status "$status" \
      --argjson messageSeqs "$message_seqs" --argjson messages "$messages" \
      '{dispatchId: $dispatchId, deliveryId: $deliveryId, replayed: $replayed, status: $status, messageSeqs: $messageSeqs, messages: $messages, text: ($messages | map(.text // "") | join("\n"))}'
  else
    printf 'delivery: %s\nreplayed: %s\nstatus: %s\n' "$delivery_id" "$replayed" "$status"
    printf '%s\n' "$messages" | jq -r '.[] | "[" + (.seq|tostring) + "] " + (.type // "message") + ": " + (.text // "")'
  fi
}

megabrain_dispatch_empty_delivery_report() {
  local dispatch_id="$1" json="$2"
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" \
      '{dispatchId: $dispatchId, deliveryId: null, replayed: false, status: "empty", messageSeqs: [], messages: [], text: ""}'
  else
    megabrain_dispatch_report "$dispatch_id" empty "" false
  fi
}

megabrain_dispatch_child_consumer() {
  local session
  if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    session="$(megabrain_dispatch_tmux_caller_session || true)"
    [ -n "$session" ] || return 1
    printf 'child/%s/%s/%s\n' "$MEGABRAIN_SESSION_HOST" "$session" "$TMUX_PANE"
  else
    printf 'child/%s/%s\n' "$MEGABRAIN_SESSION_HOST" "$MEGABRAIN_SESSION_ID"
  fi
}

megabrain_dispatch_delivery_matches_mailbox() {
  local dispatch_id="$1" delivery_path="$2" mailbox="$3" full="$4"
  local recipient messages_dir message_seqs seq path from type class
  recipient="$(jq -r '.recipient // empty' "$delivery_path" 2>/dev/null || true)"
  if [ -n "$recipient" ]; then
    [ "$recipient" = "$mailbox" ] || return 1
  fi
  # WHY: deliveries written before event-driven addressing have no recipient. Infer their
  # side from the queued message so those durable records remain readable after migration.
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")" || return 1
  message_seqs="$(jq -c '.messageSeqs // []' "$delivery_path" 2>/dev/null || true)"
  [ -n "$message_seqs" ] || return 1
  while IFS=$'\t' read -r seq path; do
    [ -n "$path" ] || continue
    jq -n -e --argjson seqs "$message_seqs" --argjson seq "$seq" \
      '$seqs | index($seq) != null' >/dev/null 2>&1 || continue
    from="$(jq -r '.from // empty' "$path" 2>/dev/null || true)"
    type="$(jq -r '.type // empty' "$path" 2>/dev/null || true)"
    if [ "$mailbox" = parent ] && { [ "$from" = child ] || [ "$from" = megabrain ]; }; then
      class="$(megabrain_dispatch_mail_class_for_message "$dispatch_id" "$from:$type" "$seq" 2>/dev/null || true)"
      if [ "$full" = true ]; then
        [ -n "$class" ] && return 0
      else
        [ "$class" = actionable ] && return 0
      fi
    elif [ "$mailbox" = child ] && [ "$from" = parent ]; then
      if [ "$full" = true ]; then
        case "$type" in reply|withdrawal|received|ack|ask|done|stalled|interrupt|interrupt-result) return 0 ;; esac
      else
        [ "$type" = reply ] || [ "$type" = withdrawal ] && return 0
      fi
    fi
  done < <(megabrain_dispatch_message_paths "$messages_dir")
  return 1
}

megabrain_dispatch_require_session() {
  megabrain_session_id >/dev/null
  if [ -z "${MEGABRAIN_SESSION_ID:-}" ]; then
    megabrain_error "this command requires a managed terminal identity; run it inside an Orca or Superset terminal"
    return 1
  fi
}

megabrain_dispatch_require_parent() {
  local dispatch_id="$1" meta expected_id expected_host
  megabrain_dispatch_require_session || return 1
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  expected_id="$(printf '%s' "$meta" | jq -r '.parentSessionId // empty')"
  expected_host="$(printf '%s' "$meta" | jq -r '.parentHost // empty')"
  if [ "$MEGABRAIN_SESSION_ID" != "$expected_id" ] || [ "$MEGABRAIN_SESSION_HOST" != "$expected_host" ]; then
    megabrain_error "dispatch $dispatch_id is owned by $expected_host/$expected_id, not $MEGABRAIN_SESSION_HOST/$MEGABRAIN_SESSION_ID"
    return 1
  fi
  printf '%s\n' "$meta"
}

megabrain_dispatch_find_child() {
  local tmux_session="" tmux_pane="" tmux_identity=false matches dispatch_id second direct_id direct_path
  MEGABRAIN_FOUND_DISPATCH=""
  megabrain_dispatch_require_session || return 1
  if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    tmux_identity=true
    tmux_pane="$TMUX_PANE"
    tmux_session="$(megabrain_dispatch_tmux_caller_session || true)"
  fi
  direct_id="${MEGABRAIN_DISPATCH_ID:-}"
  if [ -n "$direct_id" ]; then
    direct_path="$(megabrain_dispatch_meta_path "$direct_id" 2>/dev/null || true)"
    if [ -n "$direct_path" ] && [ -f "$direct_path" ]; then
      if [ "$tmux_identity" = true ]; then
        if [ -n "$tmux_session" ] && jq -e \
          --arg dispatchId "$direct_id" --arg host "$MEGABRAIN_SESSION_HOST" \
          --arg session "$tmux_session" --arg pane "$tmux_pane" \
          '.dispatchId == $dispatchId and .childHost == $host and .runtime == "tmux" and .tmuxSession == $session and .tmuxPane == $pane' \
          "$direct_path" \
          >/dev/null 2>&1; then
          MEGABRAIN_FOUND_DISPATCH="$direct_id"
          return 0
        fi
      elif jq -e \
        --arg dispatchId "$direct_id" --arg id "$MEGABRAIN_SESSION_ID" --arg host "$MEGABRAIN_SESSION_HOST" \
        '.dispatchId == $dispatchId and .terminalId == $id and .childHost == $host' \
        "$direct_path" \
        >/dev/null 2>&1; then
        MEGABRAIN_FOUND_DISPATCH="$direct_id"
        return 0
      fi
    fi
  fi
  # WHY: this runs on every ask, done, check, received and turn-end hook, and the
  # dispatch directory only grows. Use the exported dispatch id when it is valid, and
  # retain this batch scan for older or stale environments. Pane identity replaces
  # terminal identity because tmux shares the host id across panes.
  if [ "$tmux_identity" = true ]; then
    [ -n "$tmux_session" ] || {
      megabrain_error "no managed dispatch belongs to tmux session ${tmux_session:-unknown} pane $tmux_pane"
      return 1
    }
    matches="$(jq -r --arg host "$MEGABRAIN_SESSION_HOST" --arg session "$tmux_session" --arg pane "$tmux_pane" \
      'select(.childHost == $host and .runtime == "tmux" and .tmuxSession == $session and .tmuxPane == $pane) | .dispatchId // empty' \
      "$MEGABRAIN_DISPATCH_DIR"/*/meta.json 2>/dev/null)" || matches=""
  else
    matches="$(jq -r --arg id "$MEGABRAIN_SESSION_ID" --arg host "$MEGABRAIN_SESSION_HOST" \
      'select(.terminalId == $id and .childHost == $host) | .dispatchId // empty' \
      "$MEGABRAIN_DISPATCH_DIR"/*/meta.json 2>/dev/null)" || matches=""
  fi
  dispatch_id="$(printf '%s\n' "$matches" | sed -n '1p')"
  second="$(printf '%s\n' "$matches" | sed -n '2p')"
  if [ -n "$second" ]; then
    if [ "$tmux_identity" = true ]; then
      megabrain_error "tmux identity matches multiple dispatches for session ${tmux_session:-unknown} pane $tmux_pane: $dispatch_id, $second"
    else
      megabrain_error "terminal identity matches multiple dispatches for $MEGABRAIN_SESSION_HOST/$MEGABRAIN_SESSION_ID: $dispatch_id, $second"
    fi
    return 1
  fi
  if [ -n "$dispatch_id" ]; then
    MEGABRAIN_FOUND_DISPATCH="$dispatch_id"
    return 0
  fi
  if [ "$tmux_identity" = true ]; then
    megabrain_error "no managed dispatch belongs to tmux session ${tmux_session:-unknown} pane $tmux_pane"
  else
    megabrain_error "no managed dispatch belongs to $MEGABRAIN_SESSION_HOST/$MEGABRAIN_SESSION_ID"
  fi
  return 1
}

megabrain_dispatch_native_send() {
  local meta="$1" text="$2" host workspace_id terminal_id runtime tmux_session tmux_pane agent rc
  MEGABRAIN_DISPATCH_NATIVE_SEND_STATUS=not-typed
  host="$(printf '%s' "$meta" | jq -r '.childHost')"
  workspace_id="$(printf '%s' "$meta" | jq -r '.workspaceId // empty')"
  terminal_id="$(printf '%s' "$meta" | jq -r '.terminalId')"
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  if [ "$runtime" = tmux ]; then
    tmux_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
    tmux_pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
    agent="$(printf '%s' "$meta" | jq -r '.agent // empty')"
    [ -n "$tmux_session" ] && [ -n "$tmux_pane" ] || { megabrain_error "tmux dispatch metadata has no session or pane"; return 1; }
    megabrain_tmux_session_exists "$tmux_session" || { megabrain_error "tmux session is no longer available: $tmux_session"; return 1; }
    megabrain_tmux_send_nudge "$tmux_pane" "$text" "$agent"
    rc=$?
    # WHY: megabrain_tmux_send_text can return 0 after a failed type was merely
    # cleaned up. MEGABRAIN_TMUX_SEND_STATUS is the only field that says whether
    # the text actually reached the pane; the return code alone is not trustworthy.
    [ "${MEGABRAIN_TMUX_SEND_STATUS:-not-typed}" = queued ] && MEGABRAIN_DISPATCH_NATIVE_SEND_STATUS=typed
    return "$rc"
  fi
  case "$host" in
    superset)
      megabrain_superset terminals send --workspace "$workspace_id" --terminal "$terminal_id" --text "$text" --json >/dev/null || {
        megabrain_error "Superset terminals send failed for terminal $terminal_id in workspace $workspace_id"
        return 1
      }
      ;;
    orca)
      orca terminal send --terminal "$terminal_id" --text "$text" --enter --json >/dev/null || {
        megabrain_error "orca terminal send failed for terminal $terminal_id"
        return 1
      }
      ;;
    *) megabrain_error "unsupported child host: $host"; return 1 ;;
  esac
  MEGABRAIN_DISPATCH_NATIVE_SEND_STATUS=typed
}

megabrain_dispatch_reply_pointer() {
  local dispatch_id="$1"
  printf '[megabrain] reply available; run megabrain check\n'
}

megabrain_dispatch_close_refuse_caller() {
  local meta="$1" runtime target_session target_pane caller_session
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  [ "$runtime" = tmux ] || return 0
  [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 0
  target_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
  target_pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
  caller_session="$(megabrain_dispatch_tmux_caller_session || true)"
  if [ "$target_pane" = "$TMUX_PANE" ] && {
    [ -z "$caller_session" ] || [ "$target_session" = "$caller_session" ]
  }; then
    # Caller protection is unconditional so --force-release cannot kill the requesting process.
    megabrain_error "refusing to close dispatch $(printf '%s' "$meta" | jq -r '.dispatchId'): target tmux pane $target_pane is the calling pane"
    return 1
  fi
  return 0
}

megabrain_dispatch_close_reason() {
  local output="$1" reason
  reason="$(printf '%s' "$output" | jq -r 'if (.error | type) == "object" then (.error.message // .error.code // empty) else (.error // .message // empty) end' 2>/dev/null || true)"
  [ -n "$reason" ] || reason="$output"
  reason="$(printf '%s' "$reason" | tr '\r\n' '  ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//')"
  [ -n "$reason" ] || reason='the host gave no reason'
  printf '%s\n' "$reason"
}

megabrain_dispatch_close_output_is_absent() {
  local output="$1" reason normalized
  reason="$(megabrain_dispatch_close_reason "$output")"
  normalized="$(printf '%s' "$reason" | tr '[:upper:]_' '[:lower:] ' | tr '-' ' ')"
  case "$normalized" in
    *'not found'*|*'does not exist'*|*'no such'*|*'already closed'*|*'already gone'*|*'already deleted'*|*'404'*) return 0 ;;
    *) return 1 ;;
  esac
}

MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_STATUS=not-landed
MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON=''

megabrain_dispatch_native_interrupt() {
  local meta="$1" host terminal_id
  MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_STATUS=not-landed
  MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON=''
  host="$(printf '%s' "$meta" | jq -r '.childHost // empty')"
  terminal_id="$(printf '%s' "$meta" | jq -r '.terminalId // empty')"
  case "$host" in
    superset)
      MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON='Superset terminals send offers no interrupt capability'
      return 1
      ;;
    orca)
      [ -n "$terminal_id" ] || {
        MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON='Orca terminal id is missing'
        return 1
      }
      if orca terminal send --terminal "$terminal_id" --interrupt --json >/dev/null 2>&1; then
        MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_STATUS=landed
        return 0
      fi
      MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON="Orca terminal $terminal_id rejected --interrupt"
      return 1
      ;;
    *)
      MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON="interrupt capability is unavailable for host $host"
      return 1
      ;;
  esac
}

megabrain_dispatch_close_result() {
  local output="$1" close_rc="$2"
  [ "$close_rc" -eq 0 ] && return 0
  # WHY: deleting a workspace before its terminal is an expected teardown order;
  # a host-side not-found response means the resource already has the desired state.
  if megabrain_dispatch_close_output_is_absent "$output"; then
    MEGABRAIN_DISPATCH_CLOSE_OUTCOME=host-terminal-absent
    return 0
  fi
  MEGABRAIN_DISPATCH_CLOSE_ERROR="$(megabrain_dispatch_close_reason "$output")"
  return "$close_rc"
}

megabrain_dispatch_native_close() {
  local meta="$1" allow_caller="${2:-false}" host workspace_id terminal_id runtime tmux_session tmux_pane pane_count close_rc=0 close_output=""
  local parent_tmux_session caller_tmux_session shared_session=false
  MEGABRAIN_DISPATCH_CLOSE_LAST_PANE=false
  MEGABRAIN_DISPATCH_CLOSE_OUTCOME=unknown
  MEGABRAIN_DISPATCH_CLOSE_ERROR=""
  host="$(printf '%s' "$meta" | jq -r '.childHost')"
  workspace_id="$(printf '%s' "$meta" | jq -r '.workspaceId // empty')"
  terminal_id="$(printf '%s' "$meta" | jq -r '.terminalId')"
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  if [ "$runtime" = tmux ]; then
    tmux_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
    tmux_pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
    parent_tmux_session="$(printf '%s' "$meta" | jq -r '.parentTmuxSession // empty')"
    [ -n "$tmux_session" ] && [ -n "$tmux_pane" ] || { megabrain_error "tmux dispatch metadata has no session or pane"; return 1; }
    caller_tmux_session="$(megabrain_dispatch_tmux_caller_session || true)"
    if [ "$tmux_session" = "$parent_tmux_session" ] || {
      [ "$allow_caller" != true ] && [ "$tmux_session" = "$caller_tmux_session" ];
    }; then
      shared_session=true
    fi
    if [ "$shared_session" = true ]; then
      MEGABRAIN_DISPATCH_CLOSE_OUTCOME=shared-pane
      megabrain_tmux_session_exists "$tmux_session" || return 0
      tmux kill-pane -t "$tmux_pane"
      return $?
    fi
    if ! megabrain_tmux_session_exists "$tmux_session"; then
      MEGABRAIN_DISPATCH_CLOSE_OUTCOME=exclusive-session
      MEGABRAIN_DISPATCH_CLOSE_LAST_PANE=true
      pane_count=0
    else
      pane_count="$(tmux list-panes -t "$tmux_session" 2>/dev/null | wc -l | tr -d ' ')"
    fi
    if [ "$pane_count" -gt 1 ]; then
      MEGABRAIN_DISPATCH_CLOSE_OUTCOME=exclusive-pane
      tmux kill-pane -t "$tmux_pane"
      return $?
    fi
    MEGABRAIN_DISPATCH_CLOSE_OUTCOME=exclusive-session
    MEGABRAIN_DISPATCH_CLOSE_LAST_PANE=true
    tmux kill-session -t "$tmux_session" >/dev/null 2>&1 || true
    case "$host" in
      superset) close_output="$(megabrain_superset terminals close --workspace "$workspace_id" --terminal "$terminal_id" --json 2>&1)" || close_rc=$? ;;
      orca) close_output="$(orca terminal close --terminal "$terminal_id" --json 2>&1)" || close_rc=$? ;;
      *) megabrain_error "unsupported child host: $host"; return 1 ;;
    esac
    megabrain_dispatch_close_result "$close_output" "$close_rc"
    return $?
  fi
  case "$host" in
    superset) close_output="$(megabrain_superset terminals close --workspace "$workspace_id" --terminal "$terminal_id" --json 2>&1)" || close_rc=$? ;;
    orca) close_output="$(orca terminal close --terminal "$terminal_id" --json 2>&1)" || close_rc=$? ;;
    *) megabrain_error "unsupported child host: $host"; return 1 ;;
  esac
  megabrain_dispatch_close_result "$close_output" "$close_rc"
}

megabrain_dispatch_tmux_session_owned() {
  local meta="$1" allow_caller="${2:-false}" tmux_session parent_tmux_session caller_tmux_session
  tmux_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
  parent_tmux_session="$(printf '%s' "$meta" | jq -r '.parentTmuxSession // empty')"
  [ -n "$tmux_session" ] || return 1
  # A split dispatch records the parent's session, which owns the session and
  # only lends the child its pane. It is never safe for prune to release it.
  [ "$tmux_session" != "$parent_tmux_session" ] || return 1
  [ "$allow_caller" = true ] && return 0
  caller_tmux_session="$(megabrain_dispatch_tmux_caller_session 2>/dev/null || true)"
  [ -z "$caller_tmux_session" ] || [ "$tmux_session" != "$caller_tmux_session" ]
}

megabrain_dispatch_release_tmux_session() {
  local meta="$1" allow_caller="${2:-false}" runtime tmux_session terminal_status
  MEGABRAIN_DISPATCH_RELEASED_TERMINAL=false
  MEGABRAIN_DISPATCH_TERMINAL_STATUS=unknown
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  [ "$runtime" = tmux ] || {
    MEGABRAIN_DISPATCH_TERMINAL_STATUS=not-applicable
    return 0
  }
  tmux_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
  [ -n "$tmux_session" ] || {
    MEGABRAIN_DISPATCH_TERMINAL_STATUS=missing
    return 0
  }
  megabrain_dispatch_terminal_status "$meta"
  terminal_status="${MEGABRAIN_TERMINAL_STATUS:-unknown}"
  MEGABRAIN_DISPATCH_TERMINAL_STATUS="$terminal_status"
  # WHY: tmux pane ids are recycled; never kill a session until its process tree
  # proves that the pane still belongs to this dispatch.
  [ "$terminal_status" = proven ] || return 0
  megabrain_dispatch_tmux_session_owned "$meta" "$allow_caller" || return 0
  declare -F megabrain_tmux_session_exists >/dev/null 2>&1 || return 0
  if ! megabrain_tmux_session_exists "$tmux_session"; then
    MEGABRAIN_DISPATCH_TERMINAL_STATUS=missing
    return 0
  fi
  if [ "$allow_caller" != true ]; then
    megabrain_dispatch_close_refuse_caller "$meta" || return 1
  fi
  megabrain_dispatch_stop_transcript "$meta"
  megabrain_dispatch_native_close "$meta" "$allow_caller"
  MEGABRAIN_DISPATCH_RELEASED_TERMINAL=true
}

megabrain_dispatch_release_tmux_process() {
  local meta="$1" runtime tmux_session tmux_pane pane_count terminal_status
  MEGABRAIN_DISPATCH_RELEASED_TERMINAL=false
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  [ "$runtime" = tmux ] || return 0
  tmux_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
  tmux_pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
  [ -n "$tmux_session" ] && [ -n "$tmux_pane" ] || return 0
  megabrain_dispatch_terminal_status "$meta"
  terminal_status="${MEGABRAIN_TERMINAL_STATUS:-unknown}"
  # WHY: tmux pane ids are recycled; never kill a process tree without proof
  # that its current pane still belongs to this dispatch.
  [ "$terminal_status" = proven ] || return 0
  megabrain_dispatch_tmux_session_owned "$meta" true || return 0
  declare -F megabrain_tmux_session_exists >/dev/null 2>&1 || return 0
  megabrain_tmux_session_exists "$tmux_session" || return 0
  megabrain_dispatch_stop_transcript "$meta"
  if pane_count="$(tmux list-panes -t "$tmux_session" 2>/dev/null | wc -l | tr -d ' ')" && [ "$pane_count" -gt 1 ]; then
    tmux kill-pane -t "$tmux_pane" || return 1
  else
    tmux kill-session -t "$tmux_session" >/dev/null 2>&1 || return 1
  fi
  MEGABRAIN_DISPATCH_RELEASED_TERMINAL=true
}

megabrain_dispatch_host_terminal_read() {
  local meta="$1" host workspace_id terminal_id response
  host="$(printf '%s' "$meta" | jq -r '.childHost // empty')"
  workspace_id="$(printf '%s' "$meta" | jq -r '.workspaceId // empty')"
  terminal_id="$(printf '%s' "$meta" | jq -r '.terminalId // empty')"
  case "$host" in
    superset)
      response="$(megabrain_superset terminals read --workspace "$workspace_id" --terminal "$terminal_id" --json 2>&1)" || {
        megabrain_error "Superset terminal $terminal_id could not be read; host terminal output is unavailable"
        return 1
      }
      ;;
    orca)
      response="$(orca terminal read --terminal "$terminal_id" --json 2>&1)" || {
        megabrain_error "Orca terminal $terminal_id could not be read; host terminal output is unavailable"
        return 1
      }
      ;;
    *)
      megabrain_error "unsupported host terminal $host; host terminal output is unavailable"
      return 1
      ;;
  esac
  printf '%s' "$response" | jq -e . >/dev/null 2>&1 || {
    megabrain_error "$host terminal $terminal_id returned invalid read-back data; host terminal output is unavailable"
    return 1
  }
  printf '%s' "$response" | jq -r '
    if type == "string" then .
    elif type == "object" then
      (.text // .output // .content // .result.text // .result.output //
       .terminal.text // .terminal.output // tostring)
    else tostring end
  '
}

megabrain_dispatch_read() {
  local dispatch_id="${1:-}" lines=200 json=false arg meta runtime pane output source transcript_path
  local truncated=false transcript_bytes
  case "$dispatch_id" in
    -h|--help) megabrain_usage_show orchestrate-read; return 0 ;;
  esac
  [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-read; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --lines) lines="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-read; return 0 ;;
      *) megabrain_error "unknown orchestrate read option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [[ "$lines" =~ ^[1-9][0-9]*$ ]] || { megabrain_error "--lines must be a positive number"; return "$MEGABRAIN_USAGE_ERROR"; }
  meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  if [ "$runtime" = tmux ]; then
    pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
    source=tmux
    if ! output="$(megabrain_tmux_capture_pane "$pane" "-$lines" 2>/dev/null)"; then
      transcript_path="$(megabrain_dispatch_transcript_path "$dispatch_id")"
      if [ -f "$transcript_path" ]; then
        output="$(megabrain_dispatch_render_transcript "$transcript_path" "$lines")" || {
          megabrain_error "could not render dispatch transcript $transcript_path"
          return 1
        }
        source=file
        # The render path never loads more than MEGABRAIN_TRANSCRIPT_MAX_BYTES of the
        # source file, so a transcript over that bound loses content the caller asked
        # for; that fact must reach the caller rather than being promoted to a
        # complete answer.
        transcript_bytes="$(wc -c <"$transcript_path" 2>/dev/null | tr -d ' ')"
        case "$transcript_bytes" in
          ''|*[!0-9]*) ;;
          *) [ "$transcript_bytes" -gt "$MEGABRAIN_TRANSCRIPT_MAX_BYTES" ] && truncated=true ;;
        esac
      else
        megabrain_error "could not read tmux pane $pane and no persisted transcript exists"
        return 1
      fi
    fi
  else
    output="$(megabrain_dispatch_host_terminal_read "$meta")" || return 1
    source=host
    pane=""
  fi
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg pane "$pane" --arg source "$source" --arg output "$output" \
      --argjson truncated "$truncated" \
      '{dispatchId: $dispatchId, pane: $pane, source: $source, truncated: $truncated, text: $output}'
  else
    printf 'source: %s\n' "$source"
    [ "$truncated" = true ] && printf 'truncated: transcript exceeds %s bytes, oldest lines dropped\n' "$MEGABRAIN_TRANSCRIPT_MAX_BYTES"
    printf '%s\n' "$output"
  fi
}

megabrain_dispatch_report() {
  local dispatch_id="$1" status="$2" text="$3" json="$4"
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg status "$status" --arg text "$text" '{dispatchId: $dispatchId, status: $status, text: $text}'
  else
    printf 'status: %s\n%s\n' "$status" "$text"
  fi
}

megabrain_dispatch_mailbox_watch() {
  local mailbox="$1" dispatch_id timeout=120 poll_interval=3 wait_mode=nudge json=false full=false arg meta start_time now remaining
  local consumer="${MEGABRAIN_CONSUMER_ID:-}" generation="${MEGABRAIN_CONSUMER_GENERATION:-1}"
  local messages_dir deliveries_dir lock path seq from type message_seqs delivery_id outstanding_path outstanding_consumer outstanding_generation outstanding_seq candidate_seq delivery_status
  shift
  case "${1:-}" in
    -h|--help)
      if [ "$mailbox" = parent ]; then
        megabrain_usage_show orchestrate-watch
      else
        megabrain_usage_show check
      fi
      return 0
      ;;
  esac
  if [ "$mailbox" = parent ]; then
    dispatch_id="${1:-}"
    [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-watch; return "$MEGABRAIN_USAGE_ERROR"; }
    shift
  else
    megabrain_dispatch_find_child || return 1
    dispatch_id="$MEGABRAIN_FOUND_DISPATCH"
  fi
  # Legacy actionable mail is migrated before this reader claims deliveries; new writes never
  # depend on this path, and a migration is scoped to the dispatch being read.
  megabrain_dispatch_migrate_legacy_deliveries "$dispatch_id" || true
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --timeout) timeout="${2:-}"; shift 2 ;;
      --poll-interval) poll_interval="${2:-}"; shift 2 ;;
      --wait-mode) wait_mode="${2:-}"; shift 2 ;;
      --poll) wait_mode=poll; shift ;;
      --consumer) consumer="${2:-}"; shift 2 ;;
      --generation) generation="${2:-}"; shift 2 ;;
      --full) full=true; shift ;;
      --json) json=true; shift ;;
      -h|--help)
        if [ "$mailbox" = parent ]; then
          megabrain_usage_show orchestrate-watch
        else
          megabrain_usage_show check
        fi
        return 0
        ;;
      *) megabrain_error "unknown orchestrate watch option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [[ "$timeout" =~ ^[0-9]+$ ]] || { megabrain_error "--timeout must be a non-negative number of seconds"; return "$MEGABRAIN_USAGE_ERROR"; }
  [[ "$poll_interval" =~ ^[0-9]+$ ]] || { megabrain_error "--poll-interval must be a non-negative number of seconds"; return "$MEGABRAIN_USAGE_ERROR"; }
  case "$wait_mode" in nudge|poll) ;; *) megabrain_error "--wait-mode must be nudge or poll"; return "$MEGABRAIN_USAGE_ERROR" ;; esac
  [[ "$generation" =~ ^[1-9][0-9]*$ ]] || { megabrain_error "--generation must be a positive number"; return "$MEGABRAIN_USAGE_ERROR"; }
  [[ "$MEGABRAIN_DISPATCH_DELIVERY_BATCH_CAP" =~ ^[1-9][0-9]*$ ]] || { megabrain_error "delivery batch cap is invalid"; return 1; }
  if [ "$mailbox" = parent ]; then
    meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
    [ -n "$consumer" ] || consumer="$MEGABRAIN_SESSION_HOST/$MEGABRAIN_SESSION_ID"
  else
    meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
    [ -n "$consumer" ] || consumer="$(megabrain_dispatch_child_consumer)" || return 1
  fi
  [ -n "$consumer" ] || { megabrain_error "consumer identity is empty"; return 1; }
  messages_dir="$(megabrain_dispatch_messages_dir "$dispatch_id")"
  deliveries_dir="$(megabrain_dispatch_deliveries_dir "$dispatch_id")"
  mkdir -p "$deliveries_dir" || return 1
  if [ "$mailbox" = parent ]; then
    megabrain_parent_notify_waiter_register "$dispatch_id" "$meta" || return 1
  fi
  lock="$messages_dir/.lock"
  start_time="$(date +%s)"
  while true; do
    megabrain_dispatch_lock_acquire "$lock" || return 1
    outstanding_path=""
    outstanding_seq=""
    for path in "$deliveries_dir"/*.json; do
      [ -f "$path" ] || continue
      delivery_status="$(jq -r '.status // empty' "$path" 2>/dev/null || true)"
      [ "$delivery_status" = outstanding ] || { [ "$full" = true ] && [ "$delivery_status" = superseded ]; } || continue
      [ "$full" = true ] || [ "$(jq -r '.superseded // false' "$path" 2>/dev/null || true)" != true ] || continue
      megabrain_dispatch_delivery_matches_mailbox "$dispatch_id" "$path" "$mailbox" "$full" || continue
      outstanding_consumer="$(jq -r '.consumer // empty' "$path" 2>/dev/null || true)"
      if [ -z "$outstanding_consumer" ] || [ "$outstanding_consumer" = "$consumer" ]; then
        candidate_seq="$(jq -r '.messageSeqs[0] // empty' "$path" 2>/dev/null || true)"
        if [[ "$candidate_seq" =~ ^[0-9]+$ ]] && {
          [ -z "$outstanding_seq" ] || [ "$candidate_seq" -lt "$outstanding_seq" ]
        }; then
          outstanding_path="$path"
          outstanding_seq="$candidate_seq"
        fi
      fi
    done
    if [ -n "$outstanding_path" ]; then
      outstanding_consumer="$(jq -r '.consumer // empty' "$outstanding_path")"
      outstanding_generation="$(jq -r '.consumerGeneration // empty' "$outstanding_path")"
      delivery_id="$(jq -r '.id // empty' "$outstanding_path")"
      if [ -z "$outstanding_consumer" ]; then
        megabrain_dispatch_delivery_claim "$outstanding_path" "$consumer" "$generation" || {
          rmdir "$lock"
          [ "$mailbox" = parent ] && megabrain_parent_notify_waiter_unregister "$dispatch_id"
          return 1
        }
        rmdir "$lock"
        [ "$mailbox" = parent ] && megabrain_parent_notify_waiter_unregister "$dispatch_id"
        megabrain_dispatch_delivery_report "$dispatch_id" "$delivery_id" false "$json"
        return $?
      fi
      if [ "$outstanding_consumer" = "$consumer" ] && [ "$outstanding_generation" = "$generation" ]; then
        rmdir "$lock"
        [ "$mailbox" = parent ] && megabrain_parent_notify_waiter_unregister "$dispatch_id"
        megabrain_dispatch_delivery_report "$dispatch_id" "$delivery_id" true "$json"
        return $?
      fi
      megabrain_dispatch_delivery_fence "$outstanding_path" || { rmdir "$lock"; [ "$mailbox" = parent ] && megabrain_parent_notify_waiter_unregister "$dispatch_id"; return 1; }
    fi
    rmdir "$lock"
    now="$(date +%s)"
    if [ $((now - start_time)) -ge "$timeout" ]; then
      [ "$mailbox" = parent ] && megabrain_parent_notify_waiter_unregister "$dispatch_id"
      megabrain_dispatch_empty_delivery_report "$dispatch_id" "$json"
      return 0
    fi
    if [ "$mailbox" = parent ] && [ "$wait_mode" = nudge ]; then
      remaining=$((timeout - (now - start_time)))
      [ "$remaining" -gt 0 ] && megabrain_parent_notify_wait_for_wake "$dispatch_id" "$remaining" || true
    else
      sleep "$poll_interval"
    fi
  done
}

megabrain_dispatch_watch() {
  megabrain_dispatch_mailbox_watch parent "$@"
}

megabrain_dispatch_child_check() {
  megabrain_dispatch_mailbox_watch child "$@"
}

megabrain_dispatch_ack_for_owner() {
  local owner="$1" dispatch_id="" delivery_id="" consumer="${MEGABRAIN_CONSUMER_ID:-}" generation="${MEGABRAIN_CONSUMER_GENERATION:-1}"
  local json=false arg meta path status record_consumer record_generation lock tmp now message_seqs
  shift
  case "${1:-}" in
    -h|--help)
      if [ "$owner" = parent ]; then
        megabrain_usage_show orchestrate-ack
      else
        megabrain_usage_show ack
      fi
      return 0
      ;;
  esac
  if [ "$owner" = parent ]; then
    dispatch_id="${1:-}"
    delivery_id="${2:-}"
    shift 2
  else
    delivery_id="${1:-}"
    shift
    megabrain_dispatch_find_child || return 1
    dispatch_id="$MEGABRAIN_FOUND_DISPATCH"
    [ -n "$consumer" ] || consumer="$(megabrain_dispatch_child_consumer)" || return 1
  fi
  [ -n "$dispatch_id" ] && [ -n "$delivery_id" ] || { megabrain_usage_fail orchestrate-ack; return "$MEGABRAIN_USAGE_ERROR"; }
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --consumer) consumer="${2:-}"; shift 2 ;;
      --generation) generation="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-ack; return 0 ;;
      *) megabrain_error "unknown orchestrate ack option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [[ "$generation" =~ ^[1-9][0-9]*$ ]] || { megabrain_error "--generation must be a positive number"; return "$MEGABRAIN_USAGE_ERROR"; }
  if [ "$owner" = parent ]; then
    meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
    [ -n "$consumer" ] || consumer="$MEGABRAIN_SESSION_HOST/$MEGABRAIN_SESSION_ID"
  else
    meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  fi
  [ -n "$consumer" ] || { megabrain_error "consumer identity is empty"; return 1; }
  path="$(megabrain_dispatch_delivery_path "$dispatch_id" "$delivery_id")" || return 1
  [ -f "$path" ] || { megabrain_error "delivery $delivery_id refused: delivery is unknown"; return 1; }
  lock="$(megabrain_dispatch_messages_dir "$dispatch_id")/.lock"
  megabrain_dispatch_lock_acquire "$lock" || return 1
  status="$(jq -r '.status // empty' "$path")"
  case "$status" in
    acknowledged)
      # Idempotent acknowledgement makes retries safe after a lost connection.
      message_seqs="$(jq -c '.messageSeqs // []' "$path")"
      if [ "$owner" = child ] && megabrain_dispatch_delivery_is_reply "$dispatch_id" "$path" &&
        ! megabrain_dispatch_has_reply_receipt "$dispatch_id" "$delivery_id"; then
        megabrain_dispatch_message_append_locked "$dispatch_id" child ack "$delivery_id" "$MEGABRAIN_SESSION_ID" >/dev/null || {
          rmdir "$lock"
          return 1
        }
      fi
      rmdir "$lock"
      if [ "$json" = true ]; then
        jq -n --arg dispatchId "$dispatch_id" --arg deliveryId "$delivery_id" --argjson messageSeqs "$message_seqs" \
          '{dispatchId: $dispatchId, deliveryId: $deliveryId, acknowledged: true, duplicate: true, status: "acknowledged", messageSeqs: $messageSeqs}'
      else
        printf 'acknowledged: %s\nduplicate: true\n' "$delivery_id"
      fi
      return 0
      ;;
    fenced)
      # A fenced delivery must stay refused so an old generation cannot acknowledge a replacement batch.
      rmdir "$lock"
      megabrain_error "delivery $delivery_id refused: delivery is fenced"
      return 1
      ;;
    outstanding|superseded) ;;
    *)
      rmdir "$lock"
      megabrain_error "delivery $delivery_id refused: status is invalid ($status)"
      return 1
      ;;
  esac
  record_consumer="$(jq -r '.consumer // empty' "$path")"
  record_generation="$(jq -r '.consumerGeneration // empty' "$path")"
  if [ "$record_consumer" != "$consumer" ] || [ "$record_generation" != "$generation" ]; then
    rmdir "$lock"
    megabrain_error "delivery $delivery_id refused: outstanding delivery belongs to consumer $record_consumer generation $record_generation"
    return 1
  fi
  now="$(megabrain_iso_now)"
  if [ "$owner" = child ] && megabrain_dispatch_delivery_is_reply "$dispatch_id" "$path"; then
    if ! megabrain_dispatch_has_reply_receipt "$dispatch_id" "$delivery_id"; then
      megabrain_dispatch_message_append_locked "$dispatch_id" child ack "$delivery_id" "$MEGABRAIN_SESSION_ID" >/dev/null || {
        rmdir "$lock"
        return 1
      }
    fi
  fi
  tmp="$(mktemp "$(dirname "$path")/.delivery.XXXXXX")" || { rmdir "$lock"; return 1; }
  if ! jq --arg now "$now" '.status = "acknowledged" | .acknowledgedAt = $now | .updatedAt = $now' "$path" >"$tmp"; then
    rm -f "$tmp"
    rmdir "$lock"
    return 1
  fi
  mv -f "$tmp" "$path"
  message_seqs="$(jq -c '.messageSeqs // []' "$path")"
  rmdir "$lock"
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg deliveryId "$delivery_id" --argjson messageSeqs "$message_seqs" \
      '{dispatchId: $dispatchId, deliveryId: $deliveryId, acknowledged: true, duplicate: false, status: "acknowledged", messageSeqs: $messageSeqs}'
  else
    printf 'acknowledged: %s\nduplicate: false\n' "$delivery_id"
  fi
}

megabrain_dispatch_ack() {
  megabrain_dispatch_ack_for_owner parent "$@"
}

megabrain_dispatch_child_ack() {
  megabrain_dispatch_ack_for_owner child "$@"
}

megabrain_dispatch_reply() {
  local dispatch_id="${1:-}" answer="" json=false supersede=false arg meta state status nudge lock
  case "$dispatch_id" in
    -h|--help) megabrain_usage_show orchestrate-reply; return 0 ;;
  esac
  [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-reply; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --text) answer="${2:-}"; shift 2 ;;
      --supersede) supersede=true; shift ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-reply; return 0 ;;
      *) megabrain_error "unknown orchestrate reply option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [ -n "$answer" ] || { megabrain_error "--text is required"; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_dispatch_require_session || return 1
  meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
  state="$(printf '%s' "$meta" | jq -r '.state // empty')"
  if ! megabrain_dispatch_reply_state_allowed "$state"; then
    case "$state" in
      done|failed|closed|circuit_broken)
        megabrain_error "dispatch $dispatch_id is settled in state $state; open a new dispatch for a reply"
        ;;
      *)
        megabrain_error "dispatch $dispatch_id cannot receive a reply in state $state"
        ;;
    esac
    return 1
  fi
  MEGABRAIN_LAST_SUPERSEDE_QUEUED=0
  MEGABRAIN_LAST_SUPERSEDE_DELIVERED=0
  MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES='[]'
  if [ "$supersede" = true ]; then
    lock="$(megabrain_dispatch_messages_dir "$dispatch_id")/.lock"
    megabrain_dispatch_lock_acquire "$lock" || return 1
    if ! megabrain_dispatch_supersede_replies_locked "$dispatch_id" "$MEGABRAIN_SESSION_ID" ||
      ! megabrain_dispatch_message_append_locked "$dispatch_id" parent reply "$answer" "$MEGABRAIN_SESSION_ID" >/dev/null; then
      rmdir "$lock"
      return 1
    fi
    rmdir "$lock"
  else
    megabrain_dispatch_message_append "$dispatch_id" parent reply "$answer" "$MEGABRAIN_SESSION_ID" >/dev/null || return 1
  fi
  status=queued
  # The reply is durable either way; the nudge is only a best-effort pointer into the
  # pane. Report status=queued always, and say separately whether the nudge was typed,
  # so a failed keystroke is never mistaken for a lost reply.
  nudge="${MEGABRAIN_LAST_MESSAGE_NUDGE:-not-typed}"
  if [ "$state" != done ]; then
    megabrain_dispatch_meta_update_state "$dispatch_id" running || return 1
  fi
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg status "$status" --arg nudge "$nudge" \
      --argjson supersededQueued "$MEGABRAIN_LAST_SUPERSEDE_QUEUED" \
      --argjson supersededDelivered "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED" \
      --argjson deliveredSequences "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES" \
      '{dispatchId: $dispatchId, status: $status, nudge: $nudge, supersededQueued: $supersededQueued, supersededDelivered: $supersededDelivered, deliveredSequences: $deliveredSequences}'
  else
    printf '%s: %s\n' "$status" "$dispatch_id"
    [ "$supersede" = true ] && printf 'superseded queued: %s\nsuperseded delivered: %s\n' "$MEGABRAIN_LAST_SUPERSEDE_QUEUED" "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED"
    [ "$nudge" = typed ] || printf 'nudge not typed; the child will still find this reply with megabrain check\n'
  fi
}

megabrain_dispatch_stop() {
  local dispatch_id="${1:-}" json=false arg meta runtime host liveness_status liveness_reason agent pane terminal_status
  local interrupt_affordance interrupt_status attempted_text result_text interrupt_reason=''
  case "$dispatch_id" in
    -h|--help) megabrain_usage_show orchestrate-stop; return 0 ;;
  esac
  [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-stop; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-stop; return 0 ;;
      *) megabrain_error "unknown orchestrate stop option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  if [ "$runtime" = tmux ]; then
    megabrain_dispatch_liveness_read "$dispatch_id" --json >/dev/null || return 1
    liveness_status="${MEGABRAIN_DISPATCH_LIVENESS_STATUS:-unknown}"
    liveness_reason="${MEGABRAIN_DISPATCH_LIVENESS_REASON:-liveness is not proven}"
    if [ "$liveness_status" != working ]; then
      case "$liveness_status" in
        pending-check) liveness_reason='pending check frame: messages are waiting for the next tool call' ;;
        unknown) liveness_reason="unknown liveness: ${liveness_reason:-liveness is not proven}" ;;
        *) liveness_reason="${liveness_status}: ${liveness_reason:-agent is not working}" ;;
      esac
      megabrain_error "dispatch $dispatch_id cannot be stopped: $liveness_reason"
      return 1
    fi
    pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
    agent="$(printf '%s' "$meta" | jq -r '.agent // empty')"
    [ -n "$agent" ] || agent="$(megabrain_tmux_agent_for_pane "$pane" 2>/dev/null || true)"
    interrupt_affordance="$(megabrain_tmux_interrupt_affordance "$agent" 2>/dev/null || true)"
    [ -n "$interrupt_affordance" ] || {
      megabrain_error "dispatch $dispatch_id cannot be stopped: interrupt affordance is unknown for agent $agent"
      return 1
    }
    attempted_text="interrupt attempted for dispatch $dispatch_id with $interrupt_affordance"
    megabrain_dispatch_message_append "$dispatch_id" parent interrupt "$attempted_text" "$MEGABRAIN_SESSION_ID" >/dev/null || return 1
    megabrain_tmux_send_interrupt "$pane" "$agent" || true
    interrupt_status="${MEGABRAIN_TMUX_INTERRUPT_STATUS:-not-landed}"
  else
    host="$(printf '%s' "$meta" | jq -r '.childHost // empty')"
    case "$host" in
      orca)
        megabrain_dispatch_terminal_status "$meta" || {
          megabrain_error "dispatch $dispatch_id cannot be stopped: Orca terminal identity check failed"
          return 1
        }
        terminal_status="${MEGABRAIN_TERMINAL_STATUS:-unknown}"
        case "$terminal_status" in
          proven) ;;
          missing)
            megabrain_error "dispatch $dispatch_id cannot be stopped: Orca terminal identity is missing; cannot safely interrupt"
            return 1
            ;;
          *)
            megabrain_error "dispatch $dispatch_id cannot be stopped: Orca terminal identity is unproven; cannot safely interrupt"
            return 1
            ;;
        esac
        attempted_text="interrupt attempted for dispatch $dispatch_id with --interrupt; terminal identity is proven, but working liveness and pending-check frame are unavailable on Orca"
        megabrain_dispatch_message_append "$dispatch_id" parent interrupt "$attempted_text" "$MEGABRAIN_SESSION_ID" >/dev/null || return 1
        megabrain_dispatch_native_interrupt "$meta" || true
        interrupt_status="${MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_STATUS:-not-landed}"
        interrupt_reason="${MEGABRAIN_DISPATCH_NATIVE_INTERRUPT_REASON:-}"
        ;;
      superset)
        megabrain_error "dispatch $dispatch_id cannot be stopped: Superset terminals send offers no interrupt capability"
        return 1
        ;;
      *)
        megabrain_error "dispatch $dispatch_id cannot be stopped: interrupt capability is unavailable for host ${host:-unknown}"
        return 1
        ;;
    esac
  fi
  if [ "$interrupt_status" = landed ] || [ "$interrupt_status" = queued ]; then
    result_text="interrupt landed for dispatch $dispatch_id"
    result_text="${result_text/landed/$interrupt_status}"
    megabrain_dispatch_message_append "$dispatch_id" parent interrupt-result "$result_text" "$MEGABRAIN_SESSION_ID" >/dev/null || return 1
    if [ "$json" = true ]; then
      jq -n --arg dispatchId "$dispatch_id" --arg status interrupted --arg result "$interrupt_status" \
        '{dispatchId: $dispatchId, status: $status, result: $result, interrupted: true}'
    else
      printf 'interrupted: %s\nresult: %s\n' "$dispatch_id" "$interrupt_status"
    fi
    return 0
  fi
  result_text="interrupt did not land for dispatch $dispatch_id"
  [ -n "$interrupt_reason" ] && result_text="$result_text: $interrupt_reason"
  megabrain_dispatch_message_append "$dispatch_id" parent interrupt-result "$result_text" "$MEGABRAIN_SESSION_ID" >/dev/null || return 1
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg status not-interrupted --arg result "$interrupt_status" \
      '{dispatchId: $dispatchId, status: $status, result: $result, interrupted: false}'
  else
    printf 'interrupted: false\nresult: %s\n' "$interrupt_status"
  fi
  return 1
}

megabrain_dispatch_change() {
  local dispatch_id="${1:-}" answer="" json=false arg meta state lock stop_reason stop_rc temp_path
  case "$dispatch_id" in
    -h|--help) megabrain_usage_show orchestrate-change; return 0 ;;
  esac
  [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-change; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --text) answer="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-change; return 0 ;;
      *) megabrain_error "unknown orchestrate change option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [ -n "$answer" ] || { megabrain_error "--text is required"; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_dispatch_require_session || return 1
  meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
  state="$(printf '%s' "$meta" | jq -r '.state // empty')"
  megabrain_dispatch_reply_state_allowed "$state" || {
    megabrain_error "dispatch $dispatch_id cannot receive a change in state $state"
    return 1
  }
  MEGABRAIN_LAST_SUPERSEDE_QUEUED=0
  MEGABRAIN_LAST_SUPERSEDE_DELIVERED=0
  MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES='[]'
  lock="$(megabrain_dispatch_messages_dir "$dispatch_id")/.lock"
  megabrain_dispatch_lock_acquire "$lock" || return 1
  if ! megabrain_dispatch_supersede_replies_locked "$dispatch_id" "$MEGABRAIN_SESSION_ID" ||
    ! megabrain_dispatch_message_append_locked "$dispatch_id" parent reply "$answer" "$MEGABRAIN_SESSION_ID" >/dev/null; then
    rmdir "$lock"
    return 1
  fi
  rmdir "$lock"
  [ "$state" = done ] || megabrain_dispatch_meta_update_state "$dispatch_id" running || return 1
  temp_path="$(mktemp "${TMPDIR:-/tmp}/megabrain-change.XXXXXX")" || return 1
  if megabrain_dispatch_stop "$dispatch_id" --json >/dev/null 2>"$temp_path"; then
    stop_rc=0
  else
    stop_rc=$?
  fi
  stop_reason="$(cat "$temp_path")"
  rm -f "$temp_path"
  if [ "$stop_rc" -eq 0 ]; then
    if [ "$json" = true ]; then
      jq -n --arg dispatchId "$dispatch_id" --argjson queued "$MEGABRAIN_LAST_SUPERSEDE_QUEUED" \
        --argjson delivered "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED" \
        --argjson deliveredSequences "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES" \
        '{dispatchId: $dispatchId, queueChanged: true, interrupted: true, supersededQueued: $queued, supersededDelivered: $delivered, deliveredSequences: $deliveredSequences}'
    else
      printf 'changed: %s\ninterrupted: true\n' "$dispatch_id"
    fi
    return 0
  fi
  if [ "$json" = true ]; then
    jq -n --arg dispatchId "$dispatch_id" --arg reason "$stop_reason" \
      --argjson queued "$MEGABRAIN_LAST_SUPERSEDE_QUEUED" \
      --argjson delivered "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED" \
      --argjson deliveredSequences "$MEGABRAIN_LAST_SUPERSEDE_DELIVERED_SEQUENCES" \
      '{dispatchId: $dispatchId, queueChanged: true, interrupted: false, supersededQueued: $queued, supersededDelivered: $delivered, deliveredSequences: $deliveredSequences, reason: $reason, message: "queue changed; agent was not interrupted"}'
  else
    printf 'changed: %s\ninterrupted: false\nqueue changed; agent was not interrupted\n' "$dispatch_id"
  fi
  return 0
}

megabrain_dispatch_close() {
  local dispatch_id="${1:-}" json=false force_release=false arg meta runtime child_host terminal_state process_state
  case "$dispatch_id" in
    -h|--help) megabrain_usage_show orchestrate-close; return 0 ;;
  esac
  [ -n "$dispatch_id" ] || { megabrain_usage_fail orchestrate-close; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      --force-release) force_release=true; shift ;;
      -h|--help) megabrain_usage_show orchestrate-close; return 0 ;;
      *) megabrain_error "unknown orchestrate close option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  meta="$(megabrain_dispatch_require_parent "$dispatch_id")" || return 1
  megabrain_dispatch_close_refuse_caller "$meta" || return 1
  terminal_state="$(printf '%s' "$meta" | jq -r '.terminalState // "owned"')"
  if [ "$terminal_state" = retained ] && [ "$force_release" != true ]; then
    megabrain_error "dispatch $dispatch_id terminal is retained because identity is unproven; refusing release; verify it manually or rerun with --force-release"
    return 1
  fi
  if [ "$(printf '%s' "$meta" | jq -r '.state')" = closed ]; then
    if [ "$json" = true ]; then
      jq -n --arg dispatchId "$dispatch_id" '{dispatchId: $dispatchId, status: "closed", duplicate: true}'
    else
      printf 'closed: %s\n' "$dispatch_id"
    fi
    return 0
  fi
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  child_host="$(printf '%s' "$meta" | jq -r '.childHost')"
  megabrain_dispatch_stop_transcript "$meta"
  if ! megabrain_dispatch_native_close "$meta"; then
    if [ -n "$MEGABRAIN_DISPATCH_CLOSE_ERROR" ]; then
      megabrain_error "could not close dispatch $dispatch_id: $MEGABRAIN_DISPATCH_CLOSE_ERROR"
    else
      megabrain_error "could not close dispatch $dispatch_id"
    fi
    return 1
  fi
  megabrain_dispatch_meta_update_state "$dispatch_id" closed || return 1
  process_state="$(printf '%s' "$meta" | jq -r '.processState // empty')"
  case "$process_state" in
    starting|start-unproven|running|stopping|stop-unproven) megabrain_dispatch_meta_update_process_state "$dispatch_id" stopped || return 1 ;;
  esac
  megabrain_dispatch_meta_update_terminal_state "$dispatch_id" released || return 1
  if [ "$json" = true ]; then
    if [ "$runtime" = tmux ] && [ "$MEGABRAIN_DISPATCH_CLOSE_OUTCOME" = shared-pane ]; then
      jq -n --arg dispatchId "$dispatch_id" '{dispatchId: $dispatchId, status: "closed", message: "tmux pane removed; the shared tmux session and host terminal tab were kept."}'
    elif [ "$runtime" = tmux ] && [ "$MEGABRAIN_DISPATCH_CLOSE_OUTCOME" = exclusive-pane ]; then
      jq -n --arg dispatchId "$dispatch_id" '{dispatchId: $dispatchId, status: "closed", message: "tmux pane removed; the exclusive tmux session and host terminal tab were kept for remaining panes."}'
    elif [ "$runtime" = tmux ] && [ "$MEGABRAIN_DISPATCH_CLOSE_OUTCOME" = exclusive-session ]; then
      jq -n --arg dispatchId "$dispatch_id" '{dispatchId: $dispatchId, status: "closed", message: "last tmux pane removed; the exclusive tmux session and host terminal tab were closed."}'
    elif [ "$child_host" = superset ]; then
      jq -n --arg dispatchId "$dispatch_id" '{dispatchId: $dispatchId, status: "closed", message: "Superset leaves the pane visible as Desconectado until the human dismisses it with the pane X."}'
    else
      jq -n --arg dispatchId "$dispatch_id" '{dispatchId: $dispatchId, status: "closed"}'
    fi
  else
    printf 'closed: %s\n' "$dispatch_id"
    if [ "$runtime" = tmux ] && [ "$MEGABRAIN_DISPATCH_CLOSE_OUTCOME" = shared-pane ]; then
      printf 'tmux pane removed; the shared tmux session and host terminal tab were kept.\n'
    elif [ "$runtime" = tmux ] && [ "$MEGABRAIN_DISPATCH_CLOSE_OUTCOME" = exclusive-pane ]; then
      printf 'tmux pane removed; the exclusive tmux session and host terminal tab were kept for remaining panes.\n'
    elif [ "$runtime" = tmux ] && [ "$MEGABRAIN_DISPATCH_CLOSE_OUTCOME" = exclusive-session ]; then
      printf 'last tmux pane removed; the exclusive tmux session and host terminal tab were closed.\n'
    elif [ "$child_host" = superset ]; then
      printf 'Superset leaves the pane visible as Desconectado until the human dismisses it with the pane X.\n'
    fi
  fi
}

megabrain_dispatch_child_message() {
  local type="$1" text="$2" dispatch_id meta process_state state
  case "$type" in
    received|ask|done) ;;
    *) megabrain_error "unsupported child message type: $type"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
  megabrain_dispatch_find_child || return 1
  dispatch_id="$MEGABRAIN_FOUND_DISPATCH"
  megabrain_dispatch_message_append "$dispatch_id" child "$type" "$text" "$MEGABRAIN_SESSION_ID" >/dev/null || return 1
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  process_state="$(printf '%s' "$meta" | jq -r '.processState // empty')"
  case "$process_state" in
    starting|start-unproven) megabrain_dispatch_meta_update_process_state "$dispatch_id" running || return 1 ;;
  esac
  if [ "$type" = received ]; then
    # WHY: received is the authoritative prompt-delivery fact. Honor it in the child
    # writer so a receipt that arrives after the parent's bounded wait is not stranded
    # until a human runs reconcile. Terminal dispatches retain their terminal state.
    megabrain_dispatch_sync_prompt_receipt "$dispatch_id" || return 1
    meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
    state="$(printf '%s' "$meta" | jq -r '.state // empty')"
    if [ "$state" = spawning ]; then
      megabrain_dispatch_meta_update_state "$dispatch_id" running || return 1
    fi
    printf '%s sent: %s\n' "$type" "$dispatch_id"
    return 0
  elif [ "$type" = ask ]; then
    megabrain_dispatch_meta_update_state "$dispatch_id" waiting_for_reply || return 1
    megabrain_dispatch_meta_update_process_state "$dispatch_id" running || return 1
  else
    megabrain_dispatch_meta_update_process_state "$dispatch_id" succeeded || return 1
    megabrain_dispatch_meta_update_state "$dispatch_id" done || return 1
  fi
  printf '%s sent: %s\n' "$type" "$dispatch_id"
}

command_ask() {
  # WHY: --help must not look up a child dispatch and enqueue a question.
  case "${1:-}" in
    -h|--help) megabrain_usage_show ask; return 0 ;;
  esac
  [ "$#" -eq 1 ] && [ -n "$1" ] || { megabrain_usage_fail ask; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_dispatch_child_message ask "$1"
}

command_received() {
  case "${1:-}" in
    -h|--help) megabrain_usage_show received; return 0 ;;
  esac
  [ "$#" -eq 0 ] || { megabrain_usage_fail received; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_dispatch_child_message received 'prompt received'
}

command_done() {
  case "${1:-}" in
    -h|--help) megabrain_usage_show done; return 0 ;;
  esac
  [ "$#" -eq 1 ] && [ -n "$1" ] || { megabrain_usage_fail done; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_dispatch_child_message done "$1"
}

command_check() {
  megabrain_dispatch_child_check "$@"
}

command_ack() {
  megabrain_dispatch_child_ack "$@"
}
