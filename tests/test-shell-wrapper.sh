#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-wrapper.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
  return 0
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

run_wrapper() { # run_wrapper <home> <login shell>
  env HOME="$1" SHELL="$2" MEGABRAIN_STATE_DIR="$1/state" \
    "$root/.build/megabrain" tmux wrapper --yes 2>&1
}

# WHY: the wrapper is a zsh function sourced from .zshrc. On a machine whose login shell is
# bash, writing it changes nothing the user will ever load, and the command used to report
# "tmux agent wrapper applied" anyway and create a .zshrc for someone who does not use zsh.
# A command that cannot do its job has to say so rather than claim success and leave litter.
bash_home="$work_dir/bash-user"
mkdir -p "$bash_home"
printf '# a bash user\n' >"$bash_home/.bashrc"

set +e
bash_output="$(run_wrapper "$bash_home" /bin/bash)"
bash_status=$?
set -e

[ "$bash_status" -eq 0 ] || fail "the wrapper refused a bash login shell: $bash_output"
[ ! -f "$bash_home/.zshrc" ] || fail 'a .zshrc was created for a user whose shell is not zsh'
[ -f "$bash_home/.megabrain/bash/megabrain-agent-tmux.bash" ] || fail 'the bash wrapper file was not installed'
grep -q megabrain "$bash_home/.bashrc" || fail 'the bash user rc file did not get the wrapper block'
bash -n "$bash_home/.megabrain/bash/megabrain-agent-tmux.bash" || fail 'the installed bash wrapper is not valid bash'
printf 'a bash login shell gets the bash wrapper and no stray zsh file\n'

# WHY the other half: refusing has to stay narrow. A zsh user must still get the wrapper, or
# the check above would pass just as well against a command that never works.
zsh_home="$work_dir/zsh-user"
mkdir -p "$zsh_home"
printf '# a zsh user\n' >"$zsh_home/.zshrc"

zsh_output="$(run_wrapper "$zsh_home" /bin/zsh)"
assert_contains "$zsh_output" applied
[ -f "$zsh_home/.megabrain/zsh/megabrain-agent-tmux.zsh" ] || fail 'the wrapper file was not installed for a zsh user'
grep -q megabrain "$zsh_home/.zshrc" || fail 'the zsh user rc file did not get the wrapper block'
printf 'a zsh login shell still gets the wrapper\n'

# WHY a third shell: refusing has to stay narrow, and fish is the shape of every shell
# the wrapper does not ship for.
fish_home="$work_dir/fish-user"
mkdir -p "$fish_home"
set +e
fish_output="$(run_wrapper "$fish_home" /usr/bin/fish)"
fish_status=$?
set -e
[ "$fish_status" -ne 0 ] || fail "the wrapper claimed success on a shell it does not ship for: $fish_output"
[ -z "$(find "$fish_home" -type f 2>/dev/null)" ] || fail 'a shell it cannot serve still had files written for it'
printf 'a shell it does not ship for is refused, and nothing is written\n'

printf 'ok: the shell wrapper serves zsh and bash, and refuses the rest\n'
