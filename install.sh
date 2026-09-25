#!/usr/bin/env bash

set -u

REPOSITORY_URL="https://github.com/oguilhermelima/megabrain"
REPOSITORY_REF="main"
TARBALL_URL="$REPOSITORY_URL/archive/refs/heads/$REPOSITORY_REF.tar.gz"
INSTALL_ROOT="$HOME/.megabrain-local"
SOURCE_ROOT=""

installer_error() {
  printf 'install.sh: %s\n' "$*" >&2
}

installer_usage() {
  cat <<'USAGE'
Usage: install.sh [--help]

Deliver the megabrain CLI and link it at ~/.local/bin/megabrain.
Run `megabrain install --yes` to configure agents and modules.
USAGE
}

installer_parse_args() {
  case "${1:-}" in
    '') return 0 ;;
    -h|--help) installer_usage; exit 0 ;;
    *) installer_error "unknown delivery option: $1"; installer_usage >&2; return 2 ;;
  esac
}

installer_backup_path() {
  local path="$1" stamp suffix=1 backup
  [ -e "$path" ] || [ -L "$path" ] || return 0
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  backup="${path}.megabrain-backup-${stamp}"
  while [ -e "$backup" ] || [ -L "$backup" ]; do
    backup="${path}.megabrain-backup-${stamp}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "$backup"
}

installer_canonical_path() {
  local path="$1"
  if [ -d "$path" ]; then
    (cd -P "$path" && pwd)
  elif [ -e "$path" ]; then
    (cd -P "$(dirname "$path")" && printf '%s/%s\n' "$(pwd)" "$(basename "$path")")
  else
    printf '%s\n' "$path"
  fi
}

installer_link_one() {
  local link="$1" target="$2" backup link_target
  if [ -L "$link" ]; then
    link_target="$(readlink "$link")"
    case "$link_target" in
      /*) ;;
      *) link_target="$(dirname "$link")/$link_target" ;;
    esac
    if [ "$(installer_canonical_path "$link_target")" = "$(installer_canonical_path "$target")" ]; then
      return 0
    fi
  elif [ -e "$link" ] && [ -d "$link" ]; then
    installer_error "refusing to replace directory: $link"
    return 1
  fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    backup="$(installer_backup_path "$link")"
    mv "$link" "$backup" || { installer_error "could not back up $link to $backup"; return 1; }
    printf 'backed up %s to %s\n' "$link" "$backup"
  fi
  ln -s "$target" "$link" || { installer_error "could not link $link"; return 1; }
  printf 'linked megabrain at %s\n' "$link"
}

installer_source_root() {
  local script_dir="" temp_dir archive extract_dir payload checkout_dir="$INSTALL_ROOT"
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  fi
  if [ -n "$script_dir" ] && [ -x "$script_dir/megabrain" ] && [ -d "$script_dir/lib" ]; then
    SOURCE_ROOT="$script_dir"
    return 0
  fi
  if [ -x "$checkout_dir/megabrain" ] && [ -d "$checkout_dir/lib" ]; then
    SOURCE_ROOT="$checkout_dir"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || { installer_error "curl is required to install megabrain"; return 1; }
  command -v tar >/dev/null 2>&1 || { installer_error "tar is required to install megabrain"; return 1; }
  [ ! -e "$checkout_dir" ] || { installer_error "install path exists but is not a megabrain install: $checkout_dir"; return 1; }
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-local.XXXXXX")" || { installer_error "could not create a temporary directory"; return 1; }
  archive="$temp_dir/megabrain-local.tar.gz"
  extract_dir="$temp_dir/extract"
  mkdir -p "$extract_dir" || { rm -rf "$temp_dir"; return 1; }
  if ! curl -fsSL -o "$archive" "$TARBALL_URL" || ! tar -xzf "$archive" -C "$extract_dir"; then
    rm -rf "$temp_dir"
    installer_error "could not download or extract $TARBALL_URL"
    return 1
  fi
  payload="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$payload" ] || { rm -rf "$temp_dir"; installer_error "downloaded archive has no top-level directory"; return 1; }
  mkdir -p "$checkout_dir" || { rm -rf "$temp_dir"; installer_error "could not create $checkout_dir"; return 1; }
  cp -R "$payload/." "$checkout_dir/" || { rm -rf "$temp_dir"; installer_error "could not install extracted archive at $checkout_dir"; return 1; }
  rm -rf "$temp_dir"
  SOURCE_ROOT="$checkout_dir"
}

installer_require_bun() {
  command -v bun >/dev/null 2>&1 || {
    installer_error "bun is required to install megabrain; install it from https://bun.sh/docs/installation"
    return 1
  }
}

installer_build_binary() {
  [ -f "$SOURCE_ROOT/package.json" ] || { installer_error "megabrain package manifest is missing: $SOURCE_ROOT/package.json"; return 1; }
  if ! (cd "$SOURCE_ROOT" && bun run build); then
    installer_error "could not compile the megabrain binary with bun run build"
    return 1
  fi
  [ -x "$SOURCE_ROOT/.build/megabrain" ] || { installer_error "bun run build did not produce $SOURCE_ROOT/.build/megabrain"; return 1; }
}

installer_main() {
  installer_parse_args "$@" || return $?
  installer_require_bun || return 1
  installer_source_root || return 1
  [ -x "$SOURCE_ROOT/megabrain" ] && [ -d "$SOURCE_ROOT/lib" ] || { installer_error "megabrain delivery is incomplete: $SOURCE_ROOT"; return 1; }
  installer_build_binary || return 1
  mkdir -p "$HOME/.local/bin" || { installer_error "could not create $HOME/.local/bin"; return 1; }
  installer_link_one "$HOME/.local/bin/megabrain" "$SOURCE_ROOT/megabrain" || return 1
  printf 'megabrain delivered from %s\n' "$SOURCE_ROOT"
  printf 'Run megabrain install --yes to configure agents and modules.\n'
}

installer_main "$@"
