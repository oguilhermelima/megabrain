#!/usr/bin/env bash

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-doctor.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
  return 0
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir/state"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# A module doctor that printed advice to stdout used to land a human sentence inside
# the captured JSON, so the whole run came back as a jq parse error.
all_json="$("$root/megabrain" doctor --json 2>/dev/null)"
printf '%s' "$all_json" | jq -e 'type == "array" and length > 0' >/dev/null ||
  fail "doctor --json did not produce a JSON array: $all_json"
printf '%s' "$all_json" | jq -e 'all(.[]; has("module") and has("status"))' >/dev/null ||
  fail "doctor --json entries are missing module or status"

while IFS= read -r module_name; do
  module_json="$("$root/megabrain" doctor "$module_name" --json 2>/dev/null)"
  printf '%s' "$module_json" | jq -e --arg module_name "$module_name" '.module == $module_name' >/dev/null ||
    fail "doctor $module_name --json did not produce that module's object: $module_json"
done < <(printf '%s' "$all_json" | jq -r '.[].module')

advice="$("$root/megabrain" doctor --json 2>&1 >/dev/null)"
case "$advice" in
  *'CODEX ACTION REQUIRED'*) printf 'advice for the operator still reaches stderr\n' ;;
  *) printf 'no operator advice in this environment; stderr stayed empty\n' ;;
esac

# WHY: module_orchestration_doctor is gone (the install command and its per-module shell
# doctor bodies were deleted once install routed to the binary); the compiled doctor already
# implements this exact "tmux-only" branch, so this drives the compiled binary directly as a
# black box, with a PATH that offers only a fake tmux and no orca or superset. Invoking
# .build/megabrain directly (rather than the bash wrapper) means PATH can be replaced outright
# without also hiding the "env"/"bash" the wrapper's own shebang would need to resolve.
binary="$root/.build/megabrain"
if [ -x "$binary" ]; then
  tmux_only_state="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-doctor-tmux-only.XXXXXX")"
  tmux_only_bin="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-doctor-tmux-only-bin.XXXXXX")"
  cat >"$tmux_only_bin/tmux" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$tmux_only_bin/tmux"
  printf '%s\n' '{"tmux-runtime":{"installed":true}}' >"$tmux_only_state/state.json"
  # WHY: /usr/bin:/bin still supplies "which" itself (which the binary's own availability
  # checks shell out to) without risking a real orca or superset from a developer's PATH.
  tmux_only_json="$(PATH="$tmux_only_bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$tmux_only_state" HOME="$tmux_only_state" "$binary" doctor orchestration --json 2>/dev/null)"
  tmux_only_status="$(printf '%s' "$tmux_only_json" | jq -r '.status')"
  tmux_only_reason="$(printf '%s' "$tmux_only_json" | jq -r '.reason')"
  [ "$tmux_only_status" = ok ] || fail "tmux-only orchestration doctor status was $tmux_only_status"
  case "$tmux_only_reason" in
    *optional*) ;;
    *) fail "tmux-only orchestration doctor did not mark host CLIs optional: $tmux_only_reason" ;;
  esac
  rm -rf "$tmux_only_state" "$tmux_only_bin"
  printf 'tmux runtime makes absent orchestration CLIs optional\n'
else
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
fi

printf 'ok: doctor --json is machine readable for every module\n'
