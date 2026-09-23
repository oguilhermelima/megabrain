#!/usr/bin/env bash

MEGABRAIN_SKILL_STAMP_DIR="$MEGABRAIN_STATE_DIR/skill-sync"
MEGABRAIN_SKILL_TARGET_COUNT=0
MEGABRAIN_SKILL_DRIFT_COUNT=0
MEGABRAIN_SKILL_FAILURE_COUNT=0
MEGABRAIN_SKILL_REPAIRED_COUNT=0
MEGABRAIN_SKILL_TARGET_RESULT=""
MEGABRAIN_SKILL_TARGET_ERROR=""
MEGABRAIN_SKILL_SOURCE_HASH=""
MEGABRAIN_SKILL_SOURCE_HASH_ATTEMPTED=false

megabrain_sha256_file() {
  local path="$1" output=''
  if megabrain_require_command shasum; then
    output="$(shasum -a 256 "$path" 2>/dev/null)" || return 1
    printf '%s\n' "${output%% *}"
    return 0
  fi
  if megabrain_require_command sha256sum; then
    output="$(sha256sum "$path" 2>/dev/null)" || return 1
    printf '%s\n' "${output%% *}"
    return 0
  fi
  return 1
}

megabrain_skill_hash_file() {
  megabrain_sha256_file "$1"
}

megabrain_skill_source_hash() {
  local source="$1"
  if [ "$MEGABRAIN_SKILL_SOURCE_HASH_ATTEMPTED" != true ]; then
    MEGABRAIN_SKILL_SOURCE_HASH_ATTEMPTED=true
    MEGABRAIN_SKILL_SOURCE_HASH="$(megabrain_skill_hash_file "$source" 2>/dev/null || true)"
  fi
  [ -n "$MEGABRAIN_SKILL_SOURCE_HASH" ] || return 1
  printf '%s\n' "$MEGABRAIN_SKILL_SOURCE_HASH"
}

megabrain_skill_source() {
  local root="${MEGABRAIN_ROOT:-}"
  if [ -z "$root" ]; then
    root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)" || return 1
  fi
  printf '%s/skills/megabrain/SKILL.md\n' "$root"
}

megabrain_skill_target_paths() {
  local target
  for target in \
    "$HOME/.claude/plugins/cache/megabrain-local/megabrain/"*/skills/megabrain/SKILL.md \
    "$HOME/.codex/plugins/cache/megabrain-local/megabrain/"*/skills/megabrain/SKILL.md; do
    [ -f "$target" ] || continue
    printf '%s\n' "$target"
  done
  target="$PWD/.claude/skills/megabrain/SKILL.md"
  [ -f "$target" ] && printf '%s\n' "$target"
}

megabrain_skill_stamp_path() {
  local target="$1" key=''
  key="${target//%/%25}"
  key="${key//\//%2F}"
  printf '%s/path-%s.stamp\n' "$MEGABRAIN_SKILL_STAMP_DIR" "$key"
}

megabrain_skill_file_metadata() {
  local metadata='' metadata_clean=''
  metadata="$(stat -f '%m %z' "$@" 2>/dev/null || true)"
  metadata_clean="${metadata//$'\n'/ }"
  case "$metadata_clean" in
    ''|*[!0-9\ ]*) metadata='' ;;
  esac
  if [ -z "$metadata" ]; then
    metadata="$(stat -c '%Y %s' "$@" 2>/dev/null || true)"
    metadata_clean="${metadata//$'\n'/ }"
  fi
  case "$metadata_clean" in
    ''|*[!0-9\ ]*) return 1 ;;
  esac
  printf '%s\n' "$metadata"
}

megabrain_skill_write_stamp() {
  local target="$1" source_hash="$2" target_hash="$3" source_mtime="$4" source_size="$5"
  local target_mtime="$6" target_size="$7"
  local stamp='' temp=''
  stamp="$(megabrain_skill_stamp_path "$target")" || return 1
  mkdir -p "$MEGABRAIN_SKILL_STAMP_DIR" || return 1
  temp="$(mktemp "${stamp}.XXXXXX")" || return 1
  if ! printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$source_hash" "$target_hash" "$source_mtime" "$source_size" "$target_mtime" "$target_size" >"$temp"; then
    rm -f "$temp"
    return 1
  fi
  mv -f "$temp" "$stamp"
}

megabrain_skill_target_reconcile() {
  local source="$1" source_mtime="$2" source_size="$3" target="$4" target_mtime="$5"
  local target_size="$6" repair="$7"
  local target_hash='' target_metadata='' target_metadata_line='' stamp=''
  local source_hash='' stamp_source='' stamp_target='' stamp_source_mtime='' stamp_source_size=''
  local stamp_target_mtime='' stamp_target_size='' stamp_line=0 stamp_line_value='' temp=''
  MEGABRAIN_SKILL_TARGET_RESULT=error
  MEGABRAIN_SKILL_TARGET_ERROR=""

  stamp="$(megabrain_skill_stamp_path "$target" 2>/dev/null || true)"
  if [ -n "$stamp" ] && [ -f "$stamp" ]; then
    while IFS= read -r stamp_line_value; do
      stamp_line=$((stamp_line + 1))
      case "$stamp_line" in
        1) stamp_source="$stamp_line_value" ;;
        2) stamp_target="$stamp_line_value" ;;
        3) stamp_source_mtime="$stamp_line_value" ;;
        4) stamp_source_size="$stamp_line_value" ;;
        5) stamp_target_mtime="$stamp_line_value" ;;
        6) stamp_target_size="$stamp_line_value" ;;
      esac
    done <"$stamp"
    if [ -n "$stamp_source" ] && [ -n "$stamp_target" ] &&
      [ -n "$source_mtime" ] && [ -n "$source_size" ] &&
      [ -n "$target_mtime" ] && [ -n "$target_size" ] &&
      [ "$stamp_source_mtime" = "$source_mtime" ] && [ "$stamp_source_size" = "$source_size" ] &&
      [ "$stamp_target_mtime" = "$target_mtime" ] && [ "$stamp_target_size" = "$target_size" ]; then
      MEGABRAIN_SKILL_TARGET_RESULT=current
      return 0
    fi
  fi

  source_hash="$(megabrain_skill_source_hash "$source" 2>/dev/null || true)"
  if [ -z "$source_hash" ]; then
    MEGABRAIN_SKILL_TARGET_ERROR="could not hash installed skill source: $source"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    return 1
  fi
  target_hash="$(megabrain_skill_hash_file "$target" 2>/dev/null || true)"
  if [ -z "$target_hash" ]; then
    MEGABRAIN_SKILL_TARGET_ERROR="could not hash skill target: $target"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    return 1
  fi
  if [ "$target_hash" = "$source_hash" ]; then
    if ! megabrain_skill_write_stamp "$target" "$source_hash" "$target_hash" \
      "$source_mtime" "$source_size" "$target_mtime" "$target_size"; then
      MEGABRAIN_SKILL_TARGET_ERROR="could not write skill sync stamp for: $target"
      printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
      return 1
    fi
    MEGABRAIN_SKILL_TARGET_RESULT=current
    return 0
  fi

  if [ "$repair" != true ]; then
    MEGABRAIN_SKILL_TARGET_RESULT=drift
    return 1
  fi
  if [ ! -w "$target" ] || [ ! -w "$(dirname "$target")" ]; then
    MEGABRAIN_SKILL_TARGET_RESULT=unwritable
    MEGABRAIN_SKILL_TARGET_ERROR="skill target is not writable: $target"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    return 1
  fi
  temp="$(mktemp "$(dirname "$target")/.megabrain-skill.XXXXXX" 2>/dev/null || true)"
  if [ -z "$temp" ] || ! cp -p "$source" "$temp"; then
    [ -z "$temp" ] || rm -f "$temp"
    MEGABRAIN_SKILL_TARGET_ERROR="could not write repaired skill target: $target"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    return 1
  fi
  if ! mv -f "$temp" "$target"; then
    rm -f "$temp"
    MEGABRAIN_SKILL_TARGET_ERROR="could not replace repaired skill target: $target"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    return 1
  fi
  target_metadata="$(megabrain_skill_file_metadata "$target" 2>/dev/null || true)"
  target_metadata_line="${target_metadata%%$'\n'*}"
  target_mtime="${target_metadata_line%% *}"
  target_size="${target_metadata_line#* }"
  if ! megabrain_skill_write_stamp "$target" "$source_hash" "$source_hash" \
    "$source_mtime" "$source_size" "$target_mtime" "$target_size"; then
    MEGABRAIN_SKILL_TARGET_ERROR="could not write skill sync stamp for: $target"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    return 1
  fi
  MEGABRAIN_SKILL_TARGET_RESULT=repaired
  return 0
}

megabrain_skill_scan() {
  local repair="$1" source='' source_mtime='' source_size='' source_metadata='' metadata_rest=''
  local source_metadata_line='' target='' target_metadata_line='' target_mtime='' target_size='' scan_rc=0
  local target_count=0
  MEGABRAIN_SKILL_TARGET_COUNT=0
  MEGABRAIN_SKILL_DRIFT_COUNT=0
  MEGABRAIN_SKILL_FAILURE_COUNT=0
  MEGABRAIN_SKILL_REPAIRED_COUNT=0
  MEGABRAIN_SKILL_SOURCE_HASH=""
  MEGABRAIN_SKILL_SOURCE_HASH_ATTEMPTED=false
  source="$(megabrain_skill_source)"
  if [ ! -f "$source" ]; then
    MEGABRAIN_SKILL_TARGET_ERROR="installed skill source is missing: $source"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    MEGABRAIN_SKILL_FAILURE_COUNT=1
    return 1
  fi
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    if [ "$target_count" -eq 0 ]; then
      set -- "$target"
    else
      set -- "$@" "$target"
    fi
    target_count=$((target_count + 1))
  done < <(megabrain_skill_target_paths)
  if [ "$target_count" -gt 0 ]; then
    source_metadata="$(megabrain_skill_file_metadata "$source" "$@" 2>/dev/null || true)"
  else
    source_metadata="$(megabrain_skill_file_metadata "$source" 2>/dev/null || true)"
  fi
  source_metadata_line="${source_metadata%%$'\n'*}"
  metadata_rest="${source_metadata#*$'\n'}"
  source_mtime="${source_metadata_line%% *}"
  source_size="${source_metadata_line#* }"
  metadata_rest="${metadata_rest#*$'\n'}"
  if [ -z "$source_mtime" ] || [ -z "$source_size" ]; then
    MEGABRAIN_SKILL_TARGET_ERROR="could not read installed skill source metadata: $source"
    printf 'megabrain: %s\n' "$MEGABRAIN_SKILL_TARGET_ERROR" >&2
    MEGABRAIN_SKILL_FAILURE_COUNT=1
    return 1
  fi
  if [ "$target_count" -gt 0 ]; then
    for target in "$@"; do
      target_metadata_line="${metadata_rest%%$'\n'*}"
      metadata_rest="${metadata_rest#*$'\n'}"
      target_mtime="${target_metadata_line%% *}"
      target_size="${target_metadata_line#* }"
      MEGABRAIN_SKILL_TARGET_COUNT=$((MEGABRAIN_SKILL_TARGET_COUNT + 1))
      megabrain_skill_target_reconcile "$source" "$source_mtime" "$source_size" "$target" \
        "$target_mtime" "$target_size" "$repair" || scan_rc=1
      case "$MEGABRAIN_SKILL_TARGET_RESULT" in
        drift) MEGABRAIN_SKILL_DRIFT_COUNT=$((MEGABRAIN_SKILL_DRIFT_COUNT + 1)) ;;
        repaired) MEGABRAIN_SKILL_REPAIRED_COUNT=$((MEGABRAIN_SKILL_REPAIRED_COUNT + 1)) ;;
        error|unwritable) MEGABRAIN_SKILL_FAILURE_COUNT=$((MEGABRAIN_SKILL_FAILURE_COUNT + 1)) ;;
      esac
    done
  fi
  return "$scan_rc"
}

module_skill_sync_doctor() {
  local scan_rc=0
  megabrain_skill_scan false || scan_rc=1
  if [ "$MEGABRAIN_SKILL_DRIFT_COUNT" -gt 0 ]; then
    megabrain_set_status misconfigured "skill drift detected in $MEGABRAIN_SKILL_DRIFT_COUNT target(s)"
    return 1
  fi
  if [ "$MEGABRAIN_SKILL_FAILURE_COUNT" -gt 0 ]; then
    megabrain_set_status misconfigured "skill synchronization failed: ${MEGABRAIN_SKILL_TARGET_ERROR:-target unavailable}"
    return 1
  fi
  if [ "$MEGABRAIN_SKILL_TARGET_COUNT" -eq 0 ]; then
    megabrain_set_status ok 'no registered skill copies found'
  else
    megabrain_set_status ok "skill copies current: $MEGABRAIN_SKILL_TARGET_COUNT"
  fi
  return "$scan_rc"
}

module_skill_sync_install() {
  megabrain_skill_scan true
}
