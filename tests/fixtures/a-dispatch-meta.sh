#!/usr/bin/env bash

# Lane-A test fixture: build a dispatch meta.json directly with jq, matching the shape the
# compiled binary itself writes (src/cli/commands/orchestrate-spawn.ts's initialMeta) and reads
# (src/adapters/dispatch-store.ts). No lib/ sourcing: tests that need dispatch state on disk
# call this instead of the retired megabrain_dispatch_meta_write shell function.
#
# Usage: write_dispatch_meta <state-dir> <dispatch-id> [key=value ...]
# Recognised keys (all optional, defaults shown): parentSessionId=parent-terminal
# parentHost=superset childHost=superset workspaceId= terminalId=<dispatch-id>-terminal
# worktreePath=. branch=main agent=codex agentId=<agent> model=gpt-5 effort=
# modelHonored=true runtime=host spawnRuntime=<ide|tmux> tmuxSession= tmuxPane=
# parentTerminalId= parentTmuxSession= parentTmuxPane= parentWorkspaceId= label=<agent label>
# state=running
write_dispatch_meta() {
  local state_dir="$1" dispatch_id="$2" dispatch_dir now
  shift 2
  local parentSessionId=parent-terminal parentHost=superset childHost=superset workspaceId=""
  local terminalId="$dispatch_id-terminal" worktreePath="." branch=main agent=codex agentId=""
  local model=gpt-5 effort="" modelHonored=true runtime=host spawnRuntime="" tmuxSession=""
  local tmuxPane="" parentTerminalId="" parentTmuxSession="" parentTmuxPane="" parentWorkspaceId=""
  local label="" state=running
  local assignment key value
  for assignment in "$@"; do
    key="${assignment%%=*}"
    value="${assignment#*=}"
    case "$key" in
      parentSessionId) parentSessionId="$value" ;;
      parentHost) parentHost="$value" ;;
      childHost) childHost="$value" ;;
      workspaceId) workspaceId="$value" ;;
      terminalId) terminalId="$value" ;;
      worktreePath) worktreePath="$value" ;;
      branch) branch="$value" ;;
      agent) agent="$value" ;;
      agentId) agentId="$value" ;;
      model) model="$value" ;;
      effort) effort="$value" ;;
      modelHonored) modelHonored="$value" ;;
      runtime) runtime="$value" ;;
      spawnRuntime) spawnRuntime="$value" ;;
      tmuxSession) tmuxSession="$value" ;;
      tmuxPane) tmuxPane="$value" ;;
      parentTerminalId) parentTerminalId="$value" ;;
      parentTmuxSession) parentTmuxSession="$value" ;;
      parentTmuxPane) parentTmuxPane="$value" ;;
      parentWorkspaceId) parentWorkspaceId="$value" ;;
      label) label="$value" ;;
      state) state="$value" ;;
      *) printf 'write_dispatch_meta: unknown field %s\n' "$key" >&2; return 1 ;;
    esac
  done
  [ -n "$agentId" ] || agentId="$agent"
  [ -n "$spawnRuntime" ] || { [ "$runtime" = tmux ] && spawnRuntime=tmux || spawnRuntime=ide; }
  [ -n "$label" ] || label="$agent $worktreePath"
  dispatch_dir="$state_dir/dispatches/$dispatch_id"
  mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries"
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  jq -n \
    --arg dispatchId "$dispatch_id" --arg parentSessionId "$parentSessionId" --arg parentHost "$parentHost" \
    --arg parentTerminalId "$parentTerminalId" --arg parentWorkspaceId "$parentWorkspaceId" \
    --arg parentTmuxSession "$parentTmuxSession" --arg parentTmuxPane "$parentTmuxPane" \
    --arg childHost "$childHost" --arg workspaceId "$workspaceId" --arg terminalId "$terminalId" \
    --arg worktreePath "$worktreePath" --arg branch "$branch" --arg agent "$agent" --arg agentId "$agentId" \
    --arg model "$model" --arg effort "$effort" --argjson modelHonored "$modelHonored" \
    --arg runtime "$runtime" --arg spawnRuntime "$spawnRuntime" --arg tmuxSession "$tmuxSession" \
    --arg tmuxPane "$tmuxPane" --arg labelText "$label" --arg state "$state" --arg now "$now" \
    '{
      dispatchId: $dispatchId,
      parentSessionId: $parentSessionId,
      parentHost: $parentHost,
      parentTerminalId: (if $parentTerminalId == "" then null else $parentTerminalId end),
      parentWorkspaceId: (if $parentWorkspaceId == "" then null else $parentWorkspaceId end),
      parentTmuxSession: (if $parentTmuxSession == "" then null else $parentTmuxSession end),
      parentTmuxPane: (if $parentTmuxPane == "" then null else $parentTmuxPane end),
      childHost: $childHost,
      workspaceId: (if $workspaceId == "" then null else $workspaceId end),
      terminalId: $terminalId,
      worktreePath: $worktreePath,
      branch: $branch,
      agent: $agent,
      agentId: $agentId,
      model: $model,
      effort: (if $effort == "" then null else $effort end),
      modelHonored: $modelHonored,
      modelSubstitution: null,
      runtime: $runtime,
      spawnRuntime: $spawnRuntime,
      tmuxSession: (if $tmuxSession == "" then null else $tmuxSession end),
      tmuxPane: (if $tmuxPane == "" then null else $tmuxPane end),
      "label": $labelText,
      chain: null,
      state: $state,
      promptDelivered: ($state != "spawning"),
      promptDelivery: (if $state == "spawning" then "pending" else "delivered" end),
      promptDeliveryReason: null,
      promptPublication: "delivered",
      promptTransport: "delivered",
      promptReceipt: "received",
      promptState: (if $state == "spawning" then "awaiting-publication" else "confirmed" end),
      processState: (if $state == "spawning" then "starting" elif $state == "running" then "running" elif $state == "waiting_for_reply" then "running" elif $state == "done" then "succeeded" elif $state == "failed" then "failed" elif $state == "closed" then "stopped" else "start-unproven" end),
      terminalState: "owned",
      terminalReason: null,
      failureCount: 0,
      stage: null,
      reason: null,
      reconcileOutcome: null,
      createdAt: $now,
      updatedAt: $now
    }' >"$dispatch_dir/meta.json"
  jq -n '{lastReadSeq: 0}' >"$dispatch_dir/cursor.json"
  printf '%s\n' "$dispatch_id"
}

# Lane-A test fixture: append a queue message directly, matching the message shape and the
# actionable/protocol classification + delivery-creation rules the compiled binary itself uses
# (src/core/queue-write.ts's classifyQueueMail/recipientForQueueMessage, wired into appendMessage
# in src/cli/commands/queue-write.ts). No lib/ sourcing: tests that need a message already sitting
# in a dispatch's queue call this instead of the retired megabrain_dispatch_message_append shell
# function.
#
# Usage: append_dispatch_message <state-dir> <dispatch-id> <from> <type> <text> [session-id]
append_dispatch_message() {
  local state_dir="$1" dispatch_id="$2" from="$3" type="$4" text="$5" session_id="${6:-}"
  local dispatch_dir="$state_dir/dispatches/$dispatch_id" messages_dir seq name now
  local has_prior_done=false recipient="" delivery_id
  messages_dir="$dispatch_dir/messages"
  mkdir -p "$messages_dir" "$dispatch_dir/deliveries"
  seq=1
  local existing
  for existing in "$messages_dir"/*.json; do
    [ -e "$existing" ] || continue
    case "$(basename "$existing")" in
      *-child-done.json) has_prior_done=true ;;
    esac
    local existing_seq
    existing_seq="$(basename "$existing" | sed -n 's/^\([0-9][0-9]*\)-.*/\1/p')"
    [ -n "$existing_seq" ] && [ "$existing_seq" -ge "$seq" ] && seq=$((existing_seq + 1))
  done
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  name="$(printf '%04d-%s-%s.json' "$seq" "$from" "$type")"
  jq -n --argjson seq "$seq" --arg from "$from" --arg type "$type" --arg text "$text" \
    --arg now "$now" --arg sessionId "$session_id" \
    '{seq: $seq, from: $from, type: $type, text: $text, createdAt: $now, sessionId: $sessionId}' \
    >"$messages_dir/$name"
  if [ "$from" = parent ] && { [ "$type" = reply ] || [ "$type" = withdrawal ] || [ "$type" = interrupt ] || [ "$type" = interrupt-result ]; }; then
    recipient=child
  elif [ "$from" = child ] && [ "$type" = done ] && [ "$has_prior_done" = true ]; then
    recipient=""
  elif { [ "$from" = child ] && { [ "$type" = ask ] || [ "$type" = done ] || [ "$type" = stalled ]; }; } || { [ "$from" = megabrain ] && [ "$type" = usage ]; } || { [ "$from" = parent ] && [ "$type" = withdrawal ]; }; then
    recipient=parent
  fi
  if [ -n "$recipient" ]; then
    delivery_id="delivery-$(date -u '+%Y%m%d%H%M%S')-$$-$RANDOM"
    jq -n --arg id "$delivery_id" --arg dispatchId "$dispatch_id" --arg recipient "$recipient" \
      --argjson seq "$seq" --arg now "$now" \
      '{id: $id, dispatchId: $dispatchId, recipient: $recipient, messageSeqs: [$seq], status: "outstanding", createdAt: $now, updatedAt: $now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null}' \
      >"$dispatch_dir/deliveries/$delivery_id.json"
  fi
  printf '%s\n' "$seq"
}
