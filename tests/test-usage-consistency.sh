#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-usage.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
  return 0
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir/state"
source "$root/lib/common.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "$3" ;;
  esac
}

# Group commands list their subcommands instead of documenting one invocation, and
# AGENTS.md spells the appium verbs out one per line, so neither has a doc entry.
no_doc_entry=' worktree chain model native-appium '

usage_keys() {
  awk '/^megabrain_usage_line\(\) \{/ { inside = 1; next }
       inside && /^\}/ { inside = 0 }
       inside' "$root/lib/common.sh" |
    sed -n 's/^    \([a-z][a-z-]*\)).*/\1/p'
}

agents_md="$(cat "$root/AGENTS.md")"
readme_md="$(cat "$root/README.md")"
checked=0
coverage_failures=()

record_coverage_failure() {
  coverage_failures+=("$1")
}

while IFS= read -r key; do
  [ -n "$key" ] || continue
  line="$(megabrain_usage_line "$key")" || fail "no usage line for key: $key"

  # Keys are the command path with spaces replaced by dashes.
  read -r -a argv <<<"$(printf '%s' "$key" | tr '-' ' ')"
  if ! help_output="$("$root/megabrain" "${argv[@]}" --help 2>&1)"; then
    fail "megabrain ${argv[*]} --help exited non-zero"
  fi
  assert_contains "$help_output" "Usage: megabrain $line" \
    "help for '${argv[*]}' does not match the usage table: $help_output"

  case "$no_doc_entry" in
    *" $key "*) ;;
    *)
      assert_contains "$agents_md" "- Run megabrain $line." \
        "AGENTS.md has no entry matching the usage table for '$key'"
      ;;
  esac
  checked=$((checked + 1))
done < <(usage_keys)

[ "$checked" -ge 40 ] || fail "expected at least 40 usage keys, checked $checked"

# A missing argument must quote the same line the help prints, which is the drift
# that put three different close usages in one file.
close_error="$("$root/megabrain" orchestrate close 2>&1 || true)"
assert_contains "$close_error" "Usage: megabrain $(megabrain_usage_line orchestrate-close)" \
  "orchestrate close error text drifted from its help text: $close_error"

watch_error="$("$root/megabrain" orchestrate watch 2>&1 || true)"
assert_contains "$watch_error" "Usage: megabrain $(megabrain_usage_line orchestrate-watch)" \
  "orchestrate watch error text drifted from its help text: $watch_error"

# The skill is what a fresh agent session actually reads, and it is the piece that
# went stale unnoticed: it documented chain list but never chain run, so sessions
# picked an agent and model by hand. It may shorten a usage line for readability, but
# it must never name a flag the command does not have.
skill="$root/skills/megabrain/SKILL.md"
[ -f "$skill" ] || fail "the skill is missing: $skill"

skill_key() {
  local first="$1" second="$2"
  if [ -n "$second" ] && megabrain_usage_line "$first-$second" >/dev/null 2>&1; then
    printf '%s-%s\n' "$first" "$second"
  elif megabrain_usage_line "$first" >/dev/null 2>&1; then
    printf '%s\n' "$first"
  fi
}

usage_top_level_commands() {
  local key line
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    line="$(megabrain_usage_line "$key")" || fail "no usage line for key: $key"
    printf '%s\n' "$line" | awk '{print $1}'
  done < <(usage_keys) | sort -u
}

skill_covers_usage_key() {
  local key="$1" words parent group_line
  words="$(printf '%s' "$key" | tr '-' ' ')"
  case "$skill_text" in
    *"megabrain $words"*) return 0 ;;
  esac

  parent="${key%%-*}"
  [ "$parent" != "$key" ] || return 1
  group_line="$(megabrain_usage_line "$parent" 2>/dev/null || true)"
  case "$group_line" in
    *'|'*) ;;
    *) return 1 ;;
  esac
  case "$skill_text" in
    *"megabrain $group_line"*) return 0 ;;
  esac
  return 1
}

skill_checked=0
while IFS= read -r line; do
  set -- $line
  shift
  key="$(skill_key "${1:-}" "${2:-}")"
  [ -n "$key" ] || continue
  canonical="$(megabrain_usage_line "$key")"
  for flag in $(printf '%s\n' "$line" | grep -oE '\-\-[a-z][a-z-]*' | sort -u); do
    case "$canonical" in
      *"$flag"*) ;;
      *) fail "the skill documents $flag for '$key', which its usage line does not have: $canonical" ;;
    esac
  done
  skill_checked=$((skill_checked + 1))
done < <(grep -oE '^megabrain [a-z][a-z-]*( [a-z][a-z-]*)?[^|]*' "$skill")

[ "$skill_checked" -ge 25 ] || fail "expected at least 25 skill command lines, checked $skill_checked"

# A command the skill never names does not exist as far as a fresh session is
# concerned. A documented group invocation covers its children only when that
# group syntax is itself present in the usage table and the skill.
skill_text="$(cat "$skill")"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  skill_covers_usage_key "$key" || record_coverage_failure \
    "SKILL.md never names usage key '$key'"
done < <(usage_keys)

while IFS= read -r module_id; do
  [ -n "$module_id" ] || continue
  case "$skill_text" in
    *"$module_id"*) ;;
    *) record_coverage_failure "SKILL.md never names module id '$module_id'" ;;
  esac
done < <(megabrain_module_ids)

until_keys_line="$(awk '/\(\$until \| keys\) - \[/ { print; exit }' "$root/lib/chain-validation.jq")"
[ -n "$until_keys_line" ] || fail "could not find until key schema in chain-validation.jq"
until_keys="$(printf '%s\n' "$until_keys_line" | awk -F '[' '{print $2}' | awk -F ']' '{print $1}' | tr -d '"' | tr ',' '\n' | sed 's/^ *//;s/ *$//')"
while IFS= read -r until_key; do
  [ -n "$until_key" ] || continue
  case "$skill_text" in
    *"$until_key"*) ;;
    *) record_coverage_failure "SKILL.md never names until key '$until_key'" ;;
  esac
done <<EOF
$until_keys
EOF

while IFS= read -r top_level; do
  [ -n "$top_level" ] || continue
  case "$readme_md" in
    *"megabrain $top_level"*) ;;
    *) record_coverage_failure "README.md never names top-level command '$top_level'" ;;
  esac
done < <(usage_top_level_commands)

while IFS= read -r module_id; do
  [ -n "$module_id" ] || continue
  case "$readme_md" in
    *"$module_id"*) ;;
    *) record_coverage_failure "README.md never names module id '$module_id'" ;;
  esac
done < <(megabrain_module_ids)

# Homebrew is an installation method rather than a command or module, so this
# is the one deliberately manual anchor in the otherwise derived checks.
case "$readme_md" in
  *Homebrew*) ;;
  *) record_coverage_failure "README.md never names the Homebrew installation method" ;;
esac

if [ "${#coverage_failures[@]}" -gt 0 ]; then
  printf 'documentation coverage failures:\n' >&2
  for coverage_failure in "${coverage_failures[@]}"; do
    printf '%s\n' "$coverage_failure" >&2
  done
  exit 1
fi

printf 'ok: the skill names %s commands and invents no flags\n' "$skill_checked"

printf 'ok: %s usage keys agree across help, errors, and AGENTS.md\n' "$checked"
