#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-shared-build-isolation.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export MEGABRAIN_STATE_DIR="$work/state"
mkdir -p "$MEGABRAIN_STATE_DIR"

# This test is static because the container copies the checkout before running contracts. A
# runtime watcher would observe the copy rather than the checkout and would miss the ownership
# mistake this guard is meant to prevent.
is_write_line() {
  local write_command_regex='(^|[;&|()]|then)[[:space:]]*(mv|rm|install|touch|chmod|chown|truncate|dd)[[:space:]]'
  [[ "$1" =~ $write_command_regex ]] && return 0
  case "$1" in
    *'cp '*)
      local last_argument_regex='"[^" ]*\$'
      last_argument_regex="${last_argument_regex}${2}([^A-Za-z0-9_][^\"]*)?\"[[:space:]]*$"
      [[ "$1" =~ $last_argument_regex ]] && return 0
      ;;
  esac
  local redirect_regex='>>?[[:space:]]*"?\$'
  redirect_regex="${redirect_regex}${2}([^A-Za-z0-9_]|$)"
  if [[ "$1" =~ $redirect_regex ]]; then
    return 0
  fi
  return 1
}

violations="$work/violations"
: >"$violations"

while IFS= read -r file; do
  case "$file" in
    */test-shared-build-isolation.sh|*/container/run.sh) continue ;;
  esac

  build_vars=''
  line_number=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      ''|'#'*) continue ;;
    esac

    assignment=''
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]]; then
      assignment="${BASH_REMATCH[1]}"
    fi
    if [ -n "$assignment" ]; then
      case "$line" in
        *'.build'*)
          case " $build_vars " in
            *" $assignment "*) ;;
            *) build_vars="$build_vars $assignment" ;;
          esac
          ;;
        *)
          for variable in $build_vars; do
            if [[ "$line" =~ \$${variable}([^A-Za-z0-9_]|$) ]]; then
              build_vars="$build_vars $assignment"
              break
            fi
          done
          ;;
      esac
    fi

    for variable in $build_vars; do
      if [[ "$line" =~ \$${variable}([^A-Za-z0-9_]|$) ]] && is_write_line "$line" "$variable"; then
        printf '%s:%s: writes the checkout build directory through $%s\n' \
          "$file" "$line_number" "$variable" >>"$violations"
        break
      fi
    done
  done <"$file"
done <<EOF
$(find "$root/tests" -type f -name '*.sh' -print)
EOF

if [ -s "$violations" ]; then
  cat "$violations" >&2
  exit 1
fi

printf 'shared build directory has no contract writers\n'
