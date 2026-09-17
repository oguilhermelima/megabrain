#!/usr/bin/env bash

MEGABRAIN_HOOK_RESPONSE='{}'
[ "${MEGABRAIN_HOOK_AGENT:-}" = cursor ] && MEGABRAIN_HOOK_RESPONSE='{"continue":true}'

megabrain_hook_finish() {
  printf '%s\n' "$MEGABRAIN_HOOK_RESPONSE"
  exit 0
}

[ -n "${SUPERSET_TERMINAL_ID:-}" ] || [ -n "${ORCA_TERMINAL_HANDLE:-}" ] || megabrain_hook_finish

MEGABRAIN_HOOK_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)" || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/common.sh" >/dev/null 2>&1 || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/module-tmux-runtime.sh" >/dev/null 2>&1 || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/module-orchestrate.sh" >/dev/null 2>&1 || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/module-context.sh" >/dev/null 2>&1 || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/module-parent-notify.sh" >/dev/null 2>&1 || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/module-worktree.sh" >/dev/null 2>&1 || megabrain_hook_finish
source "$MEGABRAIN_HOOK_ROOT/lib/module-chain.sh" >/dev/null 2>&1 || megabrain_hook_finish

megabrain_session_id >/dev/null 2>&1 || megabrain_hook_finish
[ -n "${MEGABRAIN_SESSION_ID:-}" ] || megabrain_hook_finish

megabrain_hook_parent_notify() {
  local meta_path dispatch_id meta state dispatch_rows done_ids done_count done_first_meta refusal_reason
  local open_states_json=""
  done_ids=""
  done_count=0
  done_first_meta=""
  # WHY: this runs at the end of every turn of every agent, forever, and the dispatch
  # directory only grows. One jq per file cost 0.8s against the 83 dispatches on the
  # machine this was written on; one jq over all of them costs 0.007s. Fall back to the
  # per-file scan if the batch fails, because jq stops at the first unreadable file and
  # would silently skip every dispatch after it.
  open_states_json="$(megabrain_dispatch_open_states_json 2>/dev/null || printf '[]')"
  dispatch_rows="$(jq -r --argjson openStates "$open_states_json" '(.state // "") as $state | select((($openStates | index($state)) != null) or ($state == "done" and (.terminalState // "owned") == "owned")) | [(.dispatchId // ""), $state] | @tsv' "$MEGABRAIN_DISPATCH_DIR"/*/meta.json 2>/dev/null)" || dispatch_rows=""
  if [ -z "$dispatch_rows" ] && [ -n "$(echo "$MEGABRAIN_DISPATCH_DIR"/*/meta.json)" ]; then
    for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
      [ -f "$meta_path" ] || continue
      state="$(jq -r '.state // empty' "$meta_path" 2>/dev/null || true)"
      if ! megabrain_dispatch_state_is_open "$state" && { [ "$state" != done ] || [ "$(jq -r '.terminalState // "owned"' "$meta_path" 2>/dev/null || true)" != owned ]; }; then
        continue
      fi
      dispatch_id="$(jq -r '.dispatchId // empty' "$meta_path" 2>/dev/null || true)"
      [ -n "$dispatch_id" ] && dispatch_rows="$dispatch_rows$dispatch_id	$state
"
    done
  fi
  while IFS=$'\t' read -r dispatch_id state; do
    [ -n "$dispatch_id" ] || continue
    meta="$(megabrain_dispatch_require_parent "$dispatch_id" 2>/dev/null || true)"
    [ -n "$meta" ] || continue
    megabrain_parent_notify_context_matches "$meta" || continue
    megabrain_parent_notify_waiter_active "$dispatch_id" && continue
    if [ "$state" = done ]; then
      [ -n "$done_first_meta" ] || done_first_meta="$meta"
      if [ -n "$done_ids" ]; then
        done_ids="$done_ids, $dispatch_id"
      else
        done_ids="$dispatch_id"
      fi
      done_count=$((done_count + 1))
      continue
    fi
    if ! megabrain_dispatch_has_prompt_receipt "$dispatch_id"; then
      megabrain_dispatch_limit_refusal_read "$dispatch_id"
      if [ "${MEGABRAIN_DISPATCH_LIMIT_REFUSAL:-false}" = true ]; then
        refusal_reason="${MEGABRAIN_DISPATCH_LIMIT_REFUSAL_REASON:-agent refused the dispatch for a usage limit}"
        megabrain_dispatch_mark_limit_refused "$dispatch_id" "$refusal_reason" >/dev/null 2>&1 || continue
        # The refusal is an event-backed failed step. A missing continuation context
        # leaves the durable failure visible for a later operator decision.
        megabrain_chain_continue_refused "$dispatch_id" >/dev/null 2>&1 || true
        continue
      fi
    fi
  done < <(printf '%s\n' "$dispatch_rows")
  if [ "$done_count" -gt 0 ]; then
    megabrain_parent_notify "$done_first_meta" "$(megabrain_parent_notify_pointer_many "$done_count" "$done_ids" close)" >/dev/null 2>&1 || true
  fi
}

if ! megabrain_dispatch_find_child >/dev/null 2>&1; then
  megabrain_hook_parent_notify
  megabrain_hook_finish
fi

MEGABRAIN_HOOK_DISPATCH="$MEGABRAIN_FOUND_DISPATCH"
MEGABRAIN_HOOK_META="$(megabrain_dispatch_meta_read "$MEGABRAIN_HOOK_DISPATCH" 2>/dev/null)" || megabrain_hook_finish
MEGABRAIN_HOOK_STATE="$(printf '%s' "$MEGABRAIN_HOOK_META" | jq -r '.state // empty' 2>/dev/null)"

megabrain_hook_check_reply() {
  local output message_count
  output="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --wait-mode poll --json 2>/dev/null || true)"
  message_count="$(printf '%s' "$output" | jq -r '(.messages // []) | length' 2>/dev/null || printf '0')"
  [[ "$message_count" =~ ^[1-9][0-9]*$ ]] || return 0
  if [ "${MEGABRAIN_HOOK_AGENT:-}" = cursor ]; then
    MEGABRAIN_HOOK_RESPONSE='{"continue":true}'
  else
    MEGABRAIN_HOOK_RESPONSE='{"decision":"block","reason":"megabrain reply available; run megabrain check and act on it"}'
  fi
  MEGABRAIN_HOOK_REPLY_AVAILABLE=true
}

MEGABRAIN_HOOK_REPLY_AVAILABLE=false
megabrain_hook_check_reply
[ "$MEGABRAIN_HOOK_REPLY_AVAILABLE" = true ] && megabrain_hook_finish

case "$MEGABRAIN_HOOK_STATE" in
  waiting_for_reply|done|closed|orphaned) megabrain_hook_finish ;;
esac

megabrain_dispatch_stalled_is_due "$MEGABRAIN_HOOK_META" || megabrain_hook_finish

if [ -n "${1:-}" ]; then
  MEGABRAIN_HOOK_PAYLOAD="$1"
else
  MEGABRAIN_HOOK_PAYLOAD="$(cat 2>/dev/null)"
fi

MEGABRAIN_HOOK_TEXT="$(printf '%s' "$MEGABRAIN_HOOK_PAYLOAD" | jq -r '.last_assistant_message // .lastAssistantMessage // empty' 2>/dev/null)"
MEGABRAIN_HOOK_TRANSCRIPT="$(printf '%s' "$MEGABRAIN_HOOK_PAYLOAD" | jq -r '.transcript_path // .transcriptPath // empty' 2>/dev/null)"
if [ -z "$MEGABRAIN_HOOK_TEXT" ] && [ -r "$MEGABRAIN_HOOK_TRANSCRIPT" ]; then
  MEGABRAIN_HOOK_TEXT="$(tail -n 20 "$MEGABRAIN_HOOK_TRANSCRIPT" 2>/dev/null | tail -c 8000)"
fi
[ -n "$MEGABRAIN_HOOK_TEXT" ] || MEGABRAIN_HOOK_TEXT='child turn ended without ask or done'

megabrain_dispatch_message_append "$MEGABRAIN_HOOK_DISPATCH" child stalled "$MEGABRAIN_HOOK_TEXT" "$MEGABRAIN_SESSION_ID" >/dev/null 2>&1 || megabrain_hook_finish
megabrain_hook_finish
