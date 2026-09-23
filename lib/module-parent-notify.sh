#!/usr/bin/env bash

megabrain_parent_notify_waiter_register() {
  local dispatch_id="$1" meta="$2" path tmp lock
  path="$(megabrain_parent_notify_waiter_path "$dispatch_id")" || return 1
  [ -d "$(dirname "$path")" ] || return 1
  lock="$(dirname "$path")/.waiter.lock"
  while ! mkdir "$lock" 2>/dev/null; do sleep 0.02; done
  tmp="$(mktemp "$(dirname "$path")/.waiter.XXXXXX")" || { rmdir "$lock"; return 1; }
  if ! jq -n --argjson meta "$meta" --argjson pid "$$" --arg now "$(megabrain_iso_now)" \
    '{pid: $pid, parentSessionId: $meta.parentSessionId, parentHost: $meta.parentHost, createdAt: $now}' >"$tmp"; then
    rm -f "$tmp"
    rmdir "$lock"
    return 1
  fi
  mv -f "$tmp" "$path"
  rmdir "$lock"
}

megabrain_parent_notify_waiter_unregister() {
  local dispatch_id="$1" path
  path="$(megabrain_parent_notify_waiter_path "$dispatch_id")" || return 1
  rm -f "$path"
}

megabrain_parent_notify_wait_for_wake() {
  local dispatch_id="$1" timeout="$2" path lines wake result fifo_dir fifo tail_pid
  path="$(megabrain_parent_notify_wake_path "$dispatch_id")" || return 1
  : >>"$path" || return 1
  lines="$(wc -l <"$path" | tr -d ' ')"
  # WHY: the follower must be reaped by a pid this function owns. It writes nothing
  # after the wake line, so it never takes SIGPIPE when the read side closes, and a
  # process substitution does not give back a pid that $! reports reliably here.
  fifo_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-wake.XXXXXX")" || return 1
  fifo="$fifo_dir/wake"
  mkfifo "$fifo" || { rm -rf "$fifo_dir"; return 1; }
  tail -n +$((lines + 1)) -f "$path" >"$fifo" 2>/dev/null &
  tail_pid=$!
  # Opening read-write keeps the open from blocking on a writer that never arrives.
  if IFS= read -r -t "$timeout" wake <>"$fifo"; then
    result=0
  else
    result=1
  fi
  kill "$tail_pid" 2>/dev/null
  wait "$tail_pid" 2>/dev/null || true
  rm -rf "$fifo_dir"
  return "$result"
}

