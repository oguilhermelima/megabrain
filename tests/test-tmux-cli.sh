#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-tmux-cli.XXXXXX")"
binary="$root/.build/megabrain"
trap 'rm -rf "$work"' EXIT

if [ ! -x "$binary" ]; then
  printf 'skip: compiled tmux binary is missing at %s; run bun run build\n' "$binary"
  exit 0
fi

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$work/bin"
cat >"$work/bin/date" <<'EOF'
#!/usr/bin/env bash
printf '20260918T000000Z\n'
EOF
cat >"$work/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$MEGABRAIN_TMUX_CALLS"
case "${1:-}" in
  list-sessions)
    [ "${MEGABRAIN_TMUX_SERVER:-absent}" = running ] && exit 0
    exit 1
    ;;
  show-options)
    [ "${MEGABRAIN_TMUX_SERVER:-absent}" = running ] || exit 1
    printf 'xterm-256color:RGB\n'
    ;;
  source-file)
    [ "${MEGABRAIN_TMUX_SERVER:-absent}" = running ] && exit 0
    exit 1
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$work/bin/date" "$work/bin/tmux"

fixture="$work/fixture"
tmux_server_mode=absent
shell_stdout="$work/shell.stdout"
shell_stderr="$work/shell.stderr"
binary_stdout="$work/binary.stdout"
binary_stderr="$work/binary.stderr"

prepare_fixture() {
  rm -rf "$fixture"
  mkdir -p "$fixture/home" "$fixture/state"
  printf '# operator config\nset -g status on\n' >"$fixture/home/.tmux.conf"
  printf '# operator rc\nalias ll="ls -la"\n' >"$fixture/home/.zshrc"
  printf '' >"$work/tmux.calls"
}

snapshot_paths() {
  find "$fixture" -print | sort
}

config_path() {
  [ "$1" = tune ] && printf '%s\n' "$fixture/home/.tmux.conf" || printf '%s\n' "$fixture/home/.zshrc"
}

run_side() {
  local side="$1" verb="$2"; shift 2
  local executable="$root/megabrain"
  local implementation="MEGABRAIN_TMUX_$(printf '%s' "$verb" | tr '[:lower:]' '[:upper:]')_IMPLEMENTATION=shell"
  [ "$side" = binary ] && executable="$binary" && implementation=""
  env -i \
    HOME="$fixture/home" \
    PATH="$work/bin:$PATH" \
    MEGABRAIN_ROOT="$root" \
    MEGABRAIN_STATE_DIR="$fixture/state" \
    MEGABRAIN_TMUX_CALLS="$work/tmux.calls" \
    MEGABRAIN_TMUX_SERVER="$tmux_server_mode" \
    SHELL=/bin/zsh \
    ${implementation:+"$implementation"} \
    "$executable" tmux "$verb" "$@"
}

run_capture() {
  local side="$1" verb="$2"; shift 2
  local output="$side"_stdout error="$side"_stderr status=0
  if run_side "$side" "$verb" "$@" >"${!output}" 2>"${!error}"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status"
}

compare_capture() {
  local label="$1" verb="$2"; shift 2
  local shell_status binary_status
  prepare_fixture
  shell_status="$(run_capture shell "$verb" "$@")"
  prepare_fixture
  binary_status="$(run_capture binary "$verb" "$@")"
  [ "$shell_status" = "$binary_status" ] || fail "$label: status differs: shell=$shell_status binary=$binary_status"
  cmp -s "$shell_stdout" "$binary_stdout" || fail "$label: stdout differs"
  cmp -s "$shell_stderr" "$binary_stderr" || fail "$label: stderr differs"
}

compare_fresh_fixture() {
  local label="$1" verb="$2"; shift 2
  prepare_fixture
  local before_paths after_shell_paths after_binary_paths before_hash after_shell_hash after_binary_hash shell_status binary_status
  before_paths="$(snapshot_paths)"
  before_hash="$(shasum -a 256 "$(config_path "$verb")")"
  shell_status="$(run_capture shell "$verb" "$@")"
  after_shell_paths="$(snapshot_paths)"
  after_shell_hash="$(shasum -a 256 "$(config_path "$verb")")"
  [ "$before_hash" = "$after_shell_hash" ] || fail "$label: shell changed the config"
  [ "$before_paths" = "$after_shell_paths" ] || fail "$label: shell changed fixture paths"
  prepare_fixture
  before_paths="$(snapshot_paths)"
  before_hash="$(shasum -a 256 "$(config_path "$verb")")"
  binary_status="$(run_capture binary "$verb" "$@")"
  after_binary_paths="$(snapshot_paths)"
  after_binary_hash="$(shasum -a 256 "$(config_path "$verb")")"
  [ "$before_hash" = "$after_binary_hash" ] || fail "$label: binary changed the config"
  [ "$before_paths" = "$after_binary_paths" ] || fail "$label: binary changed fixture paths"
  [ "$shell_status" = "$binary_status" ] || fail "$label: status differs"
  cmp -s "$shell_stdout" "$binary_stdout" || fail "$label: stdout differs"
  cmp -s "$shell_stderr" "$binary_stderr" || fail "$label: stderr differs"
}

compare_capture help-tune tune --help
compare_capture help-wrapper wrapper --help
compare_capture tune-dry-run-json tune --dry-run --json
compare_capture tune-dry-run-text tune --dry-run
compare_capture wrapper-dry-run-json wrapper --dry-run --json
compare_capture wrapper-dry-run-text wrapper --dry-run
compare_fresh_fixture tune-dry-run-byte-identical tune --dry-run --json
compare_fresh_fixture wrapper-dry-run-byte-identical wrapper --dry-run --json
compare_capture invalid-combination-tune tune --dry-run --revert --json
compare_capture invalid-combination-wrapper wrapper --dry-run --revert --json

compare_capture tune-apply tune --yes --json
case "$(grep -Fxc '# >>> megabrain tmux tuning >>>' "$fixture/home/.tmux.conf")" in
  1) ;;
  *) fail 'tune apply did not install exactly one block' ;;
esac
[ -f "$fixture/home/.megabrain/tmux/megabrain.tmux.conf" ] || fail 'tune apply did not install the shared file'
case "$(find "$fixture/home" -name '.tmux.conf.megabrain-backup-*' -type f | wc -l | tr -d ' ')" in
  1) ;;
  *) fail 'tune apply did not create exactly one backup' ;;
esac
case "$(cat "$work/tmux.calls")" in
  list-sessions) ;;
  *) fail 'tune test reached an unexpected tmux operation' ;;
esac

tmux_server_mode=running
compare_capture tune-running-server tune --yes --json
case "$(cat "$work/tmux.calls")" in
  *'list-sessions
show-options -gqv terminal-features
source-file '*) ;;
  *) fail 'tune running-server scenario did not query RGB and source the file' ;;
esac
tmux_server_mode=absent

compare_capture wrapper-apply wrapper --yes --json
case "$(grep -Fxc '# >>> megabrain tmux wrapper >>>' "$fixture/home/.zshrc")" in
  1) ;;
  *) fail 'wrapper apply did not install exactly one block' ;;
esac
[ -f "$fixture/home/.megabrain/zsh/megabrain-agent-tmux.zsh" ] || fail 'wrapper apply did not install the zsh file'
case "$(find "$fixture/home" -name '.zshrc.megabrain-backup-*' -type f | wc -l | tr -d ' ')" in
  1) ;;
  *) fail 'wrapper apply did not create exactly one backup' ;;
esac

for verb in tune wrapper; do
  prepare_fixture
  run_side shell "$verb" --yes --json >"$work/first-$verb.out" 2>"$work/first-$verb.err"
  run_side shell "$verb" --yes --json >"$work/second-$verb.out" 2>"$work/second-$verb.err"
  config="$fixture/home/.tmux.conf"
  backup_glob='.tmux.conf.megabrain-backup-*'
  marker='# >>> megabrain tmux tuning >>>'
  if [ "$verb" = wrapper ]; then
    config="$fixture/home/.zshrc"
    backup_glob='.zshrc.megabrain-backup-*'
    marker='# >>> megabrain tmux wrapper >>>'
  fi
  [ "$(grep -Fxc "$marker" "$config")" = 1 ] || fail "$verb apply twice duplicated its block"
  [ "$(find "$fixture/home" -name "$backup_glob" -type f | wc -l | tr -d ' ')" = 2 ] || fail "$verb apply twice did not preserve both backups"
  case "$(cat "$work/second-$verb.out")" in
    *"20260918T000000Z-1"*) ;;
    *) fail "$verb did not choose the suffixed backup path" ;;
  esac
done

for side in shell binary; do
  for verb in tune wrapper; do
    prepare_fixture
    config="$fixture/home/.tmux.conf"
    [ "$verb" = wrapper ] && config="$fixture/home/.zshrc"
    original="$(shasum -a 256 "$config")"
    run_side "$side" "$verb" --yes --json >"$work/$side-$verb-apply.out" 2>"$work/$side-$verb-apply.err"
    run_side "$side" "$verb" --revert --json >"$work/$side-$verb-revert.out" 2>"$work/$side-$verb-revert.err"
    [ "$(shasum -a 256 "$config")" = "$original" ] || fail "$side $verb revert did not restore the original file"
  done
done

printf 'ok: tmux tune and wrapper agree across shell and binary\n'
