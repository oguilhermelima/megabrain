#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-integrations.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# This scenario exercises the zsh wrapper; keep it independent of the shell that runs CI.
export SHELL=/bin/zsh

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_file() {
  [ -f "$1" ] || fail "expected file: $1"
}

assert_symlink_target() {
  [ -L "$1" ] || fail "expected symlink: $1"
  assert_equal "$(readlink "$1")" "$2"
}

assert_backup_matches() {
  local path="$1" original="$2" backup
  backup="$(find "$(dirname "$path")" -maxdepth 1 -name "$(basename "$path").megabrain-backup-*" -type f -print -quit)"
  [ -n "$backup" ] || fail "expected backup for $path"
  cmp -s "$original" "$backup" || fail "backup for $path differs from original"
}

assert_contains "$("$root/megabrain" --version)" megabrain
assert_contains "$("$root/mb" --version)" megabrain
manifest_version="$(jq -r '.version' "$root/.claude-plugin/plugin.json")"
assert_equal "$("$root/megabrain" --version)" "megabrain $manifest_version"
printf 'command entry points: megabrain and mb report the manifest version\n'

nested_state="$work/nested-state"
write_dispatch_meta "$nested_state" nested-dispatch \
  childHost=superset workspaceId=workspace terminalId=nested-child worktreePath="$root" state=spawning >/dev/null
nested_output="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$nested_state" SUPERSET_TERMINAL_ID=nested-child bash -c 'MEGABRAIN_STATE_DIR="$1" SUPERSET_TERMINAL_ID="$2" "$3" received' _ "$nested_state" nested-child "$root/megabrain")"
assert_contains "$nested_output" 'received sent: nested-dispatch'
assert_equal "$(find "$nested_state/dispatches/nested-dispatch/messages" -name '*-child-received.json' | wc -l | tr -d ' ')" 1
assert_equal "$(jq -r '.state' "$nested_state/dispatches/nested-dispatch/meta.json")" running
printf 'state propagation: nested invocation inherits one state directory\n'

integration_home="$work/integration-home"
mkdir -p "$integration_home"
printf 'export EXISTING=1\n' >"$integration_home/.zshrc"
original_zshrc="$work/original-zshrc"
cp "$integration_home/.zshrc" "$original_zshrc"
HOME="$integration_home" "$root/megabrain" tmux wrapper --yes >/dev/null
HOME="$integration_home" "$root/megabrain" tmux tune --yes >/dev/null
grep -Fxc '# >>> megabrain tmux wrapper >>>' "$integration_home/.zshrc" | grep -Fx 1
grep -Fxc '# >>> megabrain tmux tuning >>>' "$integration_home/.tmux.conf" | grep -Fx 1
assert_backup_matches "$integration_home/.zshrc" "$original_zshrc"
HOME="$integration_home" "$root/megabrain" tmux wrapper --revert >/dev/null
HOME="$integration_home" "$root/megabrain" tmux tune --revert >/dev/null
cmp -s "$original_zshrc" "$integration_home/.zshrc" || fail 'zshrc was not restored by reverse operation'
printf 'marked integrations: backed up, replaced once, and reverted\n'

fixture_root="$work/fixture/megabrain-local"
for agent in claude codex agy cursor; do
  mkdir -p "$integration_home/.$agent"
  config="$integration_home/.$agent/hooks.json"
  [ "$agent" = claude ] && config="$integration_home/.$agent/settings.json"
  # A legacy entry pointing at the deleted wrapper script in a different (fake, never-created)
  # checkout — proving install finds and migrates it in place, not just a fresh, unconfigured
  # agent.
  case "$agent" in
    cursor)
      jq -n --arg command "MEGABRAIN_HOOK_AGENT=$agent $fixture_root/hooks/megabrain-turn-end.sh" \
        '{hooks:{afterAgentResponse:[{command:"keep"},{command:$command},{command:$command}]}}' >"$config"
      ;;
    *)
      jq -n --arg command "MEGABRAIN_HOOK_AGENT=$agent $fixture_root/hooks/megabrain-turn-end.sh" \
        '{hooks:{Stop:[{hooks:[{type:"command",command:"keep"},{type:"command",command:$command},{type:"command",command:$command}]}]}}' >"$config"
      ;;
  esac
  cp "$config" "$work/${agent}-hooks.json"
  mkdir -p "$work/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$work/bin/$agent"
  chmod +x "$work/bin/$agent"
done
PATH="$work/bin:$PATH" HOME="$integration_home" MEGABRAIN_STATE_DIR="$integration_home/state" \
  "$root/megabrain" install orchestration-hooks --yes >/dev/null
for agent in claude codex agy cursor; do
  config="$integration_home/.$agent/hooks.json"
  [ "$agent" = claude ] && config="$integration_home/.$agent/settings.json"
  assert_file "$config"
  assert_backup_matches "$config" "$work/${agent}-hooks.json"
  legacy_count="$(jq '[.. | objects | .command? // empty | select(test("megabrain-turn-end[.]sh"))] | length' "$config")"
  assert_equal "$legacy_count" 0
  count="$(jq '[.. | objects | .command? // empty | select(test(" hook turn-end$"))] | length' "$config")"
  assert_equal "$count" 1
  assert_equal "$(jq -r '.. | objects | .command? // empty | select(test(" hook turn-end$"))' "$config")" \
    "MEGABRAIN_HOOK_AGENT=$agent '$root/.build/megabrain' hook turn-end"
done
printf 'agent hooks: all four migrated in place from the legacy wrapper, with backups and one current entry each\n'

PATH="$work/bin:$PATH" HOME="$integration_home" MEGABRAIN_STATE_DIR="$integration_home/state" \
  "$root/megabrain" install orchestration-hooks --revert >/dev/null
for agent in claude codex agy cursor; do
  config="$integration_home/.$agent/hooks.json"
  [ "$agent" = claude ] && config="$integration_home/.$agent/settings.json"
  cmp -s "$work/${agent}-hooks.json" "$config" || fail "$agent hooks were not restored"
done
printf 'agent hooks: reverse operation restored the previous current entries\n'

moved_root="$work/moved/megabrain-local"
mkdir -p "$(dirname "$moved_root")"
cp -Rp "$root" "$moved_root"
moved_root="$(cd -P "$moved_root" && pwd -P)"
PATH="$work/bin:$PATH" HOME="$integration_home" MEGABRAIN_STATE_DIR="$integration_home/state" \
  "$moved_root/megabrain" install orchestration-hooks --yes >/dev/null
for agent in claude codex agy cursor; do
  config="$integration_home/.$agent/hooks.json"
  [ "$agent" = claude ] && config="$integration_home/.$agent/settings.json"
  moved_entry="$(jq -r '.. | objects | .command? // empty | select(test(" hook turn-end$"))' "$config")"
  assert_equal "$moved_entry" "MEGABRAIN_HOOK_AGENT=$agent '$moved_root/.build/megabrain' hook turn-end"
  assert_file "$moved_root/.build/megabrain"
  [ -x "$moved_root/.build/megabrain" ] || fail 'moved binary is not executable'
done
printf 'agent hooks: repair resolved the moved checkout dynamically\n'

install_home="$work/install-home"
mkdir -p "$install_home/.megabrain-local"
shared_binary_inode_before="$(ls -di "$root/.build/megabrain" | awk '{print $1}')"
HOME="$install_home" MEGABRAIN_STATE_DIR="$install_home/state" \
  "$moved_root/install.sh" >/dev/null
shared_binary_inode_after="$(ls -di "$root/.build/megabrain" | awk '{print $1}')"
assert_equal "$shared_binary_inode_after" "$shared_binary_inode_before"
assert_symlink_target "$install_home/.local/bin/megabrain" "$moved_root/megabrain"
printf 'installer: megabrain command link is present\n'

printf 'installer setup: defaults, skill sync, and plugin retirement are covered by TypeScript tests\n'

printf 'ok: current command, state, integration, and installer surfaces\n'
