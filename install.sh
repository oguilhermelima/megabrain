#!/usr/bin/env bash

set -u

REPOSITORY_URL="https://github.com/oguilhermelima/megabrain"
REPOSITORY_REF="main"
TARBALL_URL="$REPOSITORY_URL/archive/refs/heads/$REPOSITORY_REF.tar.gz"
INSTALL_ROOT="$HOME/.megabrain-local"
SKILL_MODE=""
AGENTS_MODE=""
AGENTS_REQUEST=""
MODULES_REQUEST=""
AVAILABLE_AGENTS=""
SELECTED_AGENTS=""
SELECTED_MODULES=""
ASSUME_YES=false
SOURCE_ROOT=""
SOURCE_FROM_CHECKOUT=false
INSTALL_ACTION="reconfigure"
INSTALL_MANIFEST=""
INSTALL_FRESH=false
BINARY_BUILT=false
SUMMARY_LINES=()
INSTALLER_MENU_OPTIONS=()
INSTALLER_MENU_SELECTED=()
INSTALLER_MENU_RESULT=""
INSTALLER_INPUT_SOURCE=""
INSTALLER_TERMINAL_OUTPUT=""
INSTALLER_INTERACTIVE=false
INSTALLER_COLOR=false
INSTALLER_STYLE_RESET=""
INSTALLER_STYLE_BOLD=""
INSTALLER_STYLE_DIM=""
INSTALLER_STYLE_GREEN=""
INSTALLER_STYLE_YELLOW=""
INSTALLER_STYLE_RED=""

installer_error() {
  printf 'install.sh: %s\n' "$*" >&2
}

installer_summary() {
  SUMMARY_LINES+=("$*")
}

installer_print_summary_line() {
  local line="$1" glyph='·' style="$INSTALLER_STYLE_DIM"
  case "$line" in
    *needs-your-action*) glyph='!'; style="$INSTALLER_STYLE_YELLOW" ;;
    *failed*|*failure*|*could\ not*|*error*) glyph='✗'; style="$INSTALLER_STYLE_RED" ;;
    *skipped*) glyph='–'; style="$INSTALLER_STYLE_DIM" ;;
    *already-current*|*"already current"*) glyph='·'; style="$INSTALLER_STYLE_DIM" ;;
    *installed*|*updated*|*removed*|*reconfigured*) glyph='✓'; style="$INSTALLER_STYLE_GREEN" ;;
  esac
  printf '%s%s %s%s\n' "$style" "$glyph" "$line" "$INSTALLER_STYLE_RESET"
}

installer_usage() {
  cat <<'EOF'
Usage: ./install.sh [--agents claude,codex,agy|none] [--skill none|global|project]
                    [--agents-md none|global|project] [--modules list|all|none] [--yes]

--agents selects installed agent CLIs to configure. With --skill global, Claude is
registered as a user-level marketplace plugin; --skill project keeps the legacy
project-local bare skill copy because Claude plugins have no project scope.
EOF
}

installer_parse_args() {
  local arg value
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --skill|--agents-md)
        [ "$#" -gt 1 ] || { installer_error "$arg requires none, global, or project"; return 2; }
        value="$2"
        case "$value" in
          none|global|project) ;;
          *) installer_error "$arg must be none, global, or project"; return 2 ;;
        esac
        if [ "$arg" = --skill ]; then
          SKILL_MODE="$value"
        else
          AGENTS_MODE="$value"
        fi
        shift 2
        ;;
      --agents)
        [ "$#" -gt 1 ] || { installer_error "$arg requires a comma-separated list of claude, codex, agy, or none"; return 2; }
        AGENTS_REQUEST="$2"
        shift 2
        ;;
      --modules)
        [ "$#" -gt 1 ] || { installer_error "--modules requires a comma-separated list or all/none"; return 2; }
        MODULES_REQUEST="$2"
        shift 2
        ;;
      --yes) ASSUME_YES=true; shift ;;
      -h|--help) installer_usage; exit 0 ;;
      *) installer_error "unknown option: $arg"; installer_usage >&2; return 2 ;;
    esac
  done
}

installer_detect_agents() {
  local agent
  AVAILABLE_AGENTS=""
  for agent in claude codex agy; do
    if command -v "$agent" >/dev/null 2>&1; then
      if [ -n "$AVAILABLE_AGENTS" ]; then
        AVAILABLE_AGENTS="$AVAILABLE_AGENTS,$agent"
      else
        AVAILABLE_AGENTS="$agent"
      fi
    fi
  done
}

installer_list_contains() {
  local list="$1" candidate="$2" item
  [ -n "$list" ] || return 1
  IFS=',' read -r -a _installer_items <<<"$list"
  for item in "${_installer_items[@]}"; do
    [ "$item" = "$candidate" ] && return 0
  done
  return 1
}

installer_resolve_input_source() {
  # Under curl | bash, stdin contains the script rather than the user's input.
  if [ -t 0 ]; then
    INSTALLER_INPUT_SOURCE=/dev/stdin
    INSTALLER_INTERACTIVE=true
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
      INSTALLER_TERMINAL_OUTPUT=/dev/tty
    else
      INSTALLER_TERMINAL_OUTPUT=/dev/stdout
    fi
  elif [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    INSTALLER_INPUT_SOURCE=/dev/tty
    INSTALLER_TERMINAL_OUTPUT=/dev/tty
    INSTALLER_INTERACTIVE=true
  fi
}

installer_init_style() {
  local colors
  INSTALLER_COLOR=false
  INSTALLER_STYLE_RESET=""
  INSTALLER_STYLE_BOLD=""
  INSTALLER_STYLE_DIM=""
  INSTALLER_STYLE_GREEN=""
  INSTALLER_STYLE_YELLOW=""
  INSTALLER_STYLE_RED=""
  # Check the destination terminal before styling so piped logs remain plain.
  [ -t 1 ] || return 0
  [ -z "${NO_COLOR+x}" ] || return 0
  [ "${TERM:-}" != dumb ] || return 0
  command -v tput >/dev/null 2>&1 || return 0
  colors="$(tput colors 2>/dev/null)" || return 0
  case "$colors" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$colors" -ge 8 ] || return 0
  if ! INSTALLER_STYLE_RESET="$(tput sgr0 2>/dev/null)" ||
    ! INSTALLER_STYLE_BOLD="$(tput bold 2>/dev/null)" ||
    ! INSTALLER_STYLE_DIM="$(tput dim 2>/dev/null)" ||
    ! INSTALLER_STYLE_GREEN="$(tput setaf 2 2>/dev/null)" ||
    ! INSTALLER_STYLE_YELLOW="$(tput setaf 3 2>/dev/null)" ||
    ! INSTALLER_STYLE_RED="$(tput setaf 1 2>/dev/null)"; then
    INSTALLER_STYLE_RESET=""
    INSTALLER_STYLE_BOLD=""
    INSTALLER_STYLE_DIM=""
    INSTALLER_STYLE_GREEN=""
    INSTALLER_STYLE_YELLOW=""
    INSTALLER_STYLE_RED=""
    return 0
  fi
  INSTALLER_COLOR=true
}

installer_menu_printf() {
  printf "$@" >>"$INSTALLER_TERMINAL_OUTPUT"
}

installer_menu() {
  local mode="$1" header="$2" initial="$3" key rest index num
  shift 3
  INSTALLER_MENU_OPTIONS=("$@")
  INSTALLER_MENU_SELECTED=()
  INSTALLER_MENU_RESULT=""
  local total="${#INSTALLER_MENU_OPTIONS[@]}"
  local total_rows="$total"
  local selected=1
  local value option glyph glyph_style cursor_prefix cursor_suffix marker
  [ "$total" -gt 0 ] || return 1
  if [ "$mode" = multi ]; then
    total_rows=$((total + 1))
  fi
  for option in "${INSTALLER_MENU_OPTIONS[@]}"; do
    value=false
    if [ "$mode" = multi ] && installer_list_contains "$initial" "$option"; then
      value=true
    fi
    INSTALLER_MENU_SELECTED+=("$value")
  done
  while true; do
    if [ "$INSTALLER_TERMINAL_OUTPUT" != /dev/stdout ] || [ -t 1 ]; then
      printf '\033[2J\033[H' >"$INSTALLER_TERMINAL_OUTPUT"
    fi
    installer_menu_printf '%s%s%s\n\n' "$INSTALLER_STYLE_BOLD" "$header" "$INSTALLER_STYLE_RESET"
    if [ "$mode" = multi ]; then
      installer_menu_printf '%sUse ↑/↓ or numbers to move; Space/Enter toggle; choose Avançar to continue.%s\n\n' "$INSTALLER_STYLE_DIM" "$INSTALLER_STYLE_RESET"
    else
      installer_menu_printf '%sUse ↑/↓ or a number, then Enter to confirm.%s\n\n' "$INSTALLER_STYLE_DIM" "$INSTALLER_STYLE_RESET"
    fi
    index=1
    for option in "${INSTALLER_MENU_OPTIONS[@]}"; do
      cursor_prefix=''
      cursor_suffix=''
      marker='  '
      if [ "$index" -eq "$selected" ]; then
        cursor_prefix="$INSTALLER_STYLE_BOLD"
        cursor_suffix="$INSTALLER_STYLE_RESET"
        marker='➜ '
      fi
      if [ "$mode" = multi ]; then
        if [ "${INSTALLER_MENU_SELECTED[$((index - 1))]}" = true ]; then
          glyph='●'
          glyph_style="$INSTALLER_STYLE_GREEN"
        else
          glyph='○'
          glyph_style="$INSTALLER_STYLE_DIM"
        fi
      elif [ "$index" -eq "$selected" ]; then
        glyph='●'
        glyph_style="$INSTALLER_STYLE_GREEN"
      else
        glyph='○'
        glyph_style="$INSTALLER_STYLE_DIM"
      fi
      installer_menu_printf '%s%s[%s%s%s] %s[%2d]%s %s%s%s\n' \
        "$cursor_prefix" "$marker" "$glyph_style" "$glyph" "$INSTALLER_STYLE_RESET" \
        "$INSTALLER_STYLE_DIM" "$index" "$INSTALLER_STYLE_RESET" \
        "$INSTALLER_STYLE_BOLD" "$option" "$cursor_suffix"
      index=$((index + 1))
    done
    if [ "$mode" = multi ]; then
      installer_menu_printf '\n'
      cursor_prefix=''
      cursor_suffix=''
      marker='  '
      if [ "$selected" -eq "$total_rows" ]; then
        cursor_prefix="$INSTALLER_STYLE_BOLD"
        cursor_suffix="$INSTALLER_STYLE_RESET"
        marker='➜ '
      fi
      installer_menu_printf '%s%s[%s→%s] %sAvançar%s\n' \
        "$cursor_prefix" "$marker" "$INSTALLER_STYLE_YELLOW" "$INSTALLER_STYLE_RESET" \
        "$INSTALLER_STYLE_BOLD" "$cursor_suffix"
    fi
    installer_menu_printf '\n'
    # Preserve whitespace keys so Space cannot enter the confirmation branch.
    if ! IFS= read -r -s -n 1 key <"$INSTALLER_INPUT_SOURCE"; then
      return 1
    fi
    if [ "$key" = $'\033' ]; then
      rest=''
      read -r -s -n 2 -t 1 rest <"$INSTALLER_INPUT_SOURCE" || true
      key="$key$rest"
    fi
    # Keep the advance action distinct so normal-item keys can never confirm.
    case "$key" in
      $'\033[A'|$'\033OA'|k|K)
        selected=$((selected - 1))
        if [ "$selected" -lt 1 ]; then
          if [ "$mode" = multi ]; then
            selected="$total_rows"
          else
            selected="$total"
          fi
        fi
        ;;
      $'\033[B'|$'\033OB'|j|J)
        selected=$((selected + 1))
        [ "$selected" -le "$total_rows" ] || selected=1
        ;;
      [0-9])
        num="$key"
        if [ "$num" -ge 1 ] && [ "$num" -le "$total" ]; then
          selected="$num"
          if [ "$mode" = multi ]; then
            if [ "${INSTALLER_MENU_SELECTED[$((selected - 1))]}" = true ]; then
              INSTALLER_MENU_SELECTED[$((selected - 1))]=false
            else
              INSTALLER_MENU_SELECTED[$((selected - 1))]=true
            fi
          else
            break
          fi
        fi
        ;;
      ' ')
        if [ "$mode" = multi ]; then
          [ "$selected" -eq "$total_rows" ] && break
          if [ "${INSTALLER_MENU_SELECTED[$((selected - 1))]}" = true ]; then
            INSTALLER_MENU_SELECTED[$((selected - 1))]=false
          else
            INSTALLER_MENU_SELECTED[$((selected - 1))]=true
          fi
        fi
        ;;
      ''|$'\n'|$'\r')
        if [ "$mode" = multi ]; then
          [ "$selected" -eq "$total_rows" ] && break
          if [ "${INSTALLER_MENU_SELECTED[$((selected - 1))]}" = true ]; then
            INSTALLER_MENU_SELECTED[$((selected - 1))]=false
          else
            INSTALLER_MENU_SELECTED[$((selected - 1))]=true
          fi
        else
          break
        fi
        ;;
      q|Q|$'\003') return 130 ;;
    esac
  done
  if [ "$mode" = multi ]; then
    INSTALLER_MENU_RESULT=''
    index=1
    for option in "${INSTALLER_MENU_OPTIONS[@]}"; do
      if [ "${INSTALLER_MENU_SELECTED[$((index - 1))]}" = true ]; then
        [ -n "$INSTALLER_MENU_RESULT" ] && INSTALLER_MENU_RESULT="$INSTALLER_MENU_RESULT,"
        INSTALLER_MENU_RESULT="$INSTALLER_MENU_RESULT$option"
      fi
      index=$((index + 1))
    done
  else
    INSTALLER_MENU_RESULT="${INSTALLER_MENU_OPTIONS[$((selected - 1))]}"
  fi
  installer_menu_printf '\n'
}

installer_select_agents() {
  local raw="$AGENTS_REQUEST" token normalized option
  local -a requested=()
  SELECTED_AGENTS=""
  if [ -z "$raw" ]; then
    if [ -z "$AVAILABLE_AGENTS" ]; then
      installer_error "no supported agent CLI (claude, codex, or agy) is installed; pass --agents none or install one"
      return 1
    fi
    if [ "$INSTALLER_INTERACTIVE" = false ]; then
      installer_error "agent selection requires --agents in a non-interactive shell"
      return 1
    fi
    local options=()
    IFS=',' read -r -a options <<<"$AVAILABLE_AGENTS,none"
    installer_menu multi 'Configure agent CLIs' "$AVAILABLE_AGENTS" "${options[@]}" || return $?
    raw="$INSTALLER_MENU_RESULT"
    if [ -z "$raw" ]; then
      installer_error "choose at least one installed agent or none"
      return 2
    fi
    if installer_list_contains "$raw" none; then
      raw=none
    fi
  fi
  IFS=',' read -r -a requested <<<"$raw"
  for token in "${requested[@]}"; do
    normalized="$(printf '%s' "$token" | tr -d '[:space:]')"
    case "$normalized" in
      none)
        [ "${#requested[@]}" -eq 1 ] || { installer_error "none cannot be combined with another agent"; return 2; }
        SELECTED_AGENTS=""
        return 0
        ;;
      claude|codex|agy)
        installer_list_contains "$AVAILABLE_AGENTS" "$normalized" || {
          installer_error "$normalized is not installed or is not available on PATH"
          return 1
        }
        if ! installer_list_contains "$SELECTED_AGENTS" "$normalized"; then
          if [ -n "$SELECTED_AGENTS" ]; then
            SELECTED_AGENTS="$SELECTED_AGENTS,$normalized"
          else
            SELECTED_AGENTS="$normalized"
          fi
        fi
        ;;
      *)
        installer_error "unsupported agent '$normalized'; choose from claude, codex, agy, or none"
        return 2
        ;;
    esac
  done
  [ -n "$SELECTED_AGENTS" ] || { installer_error "choose at least one installed agent or none"; return 2; }
}

installer_source_root() {
  local script_dir="" checkout_dir="$INSTALL_ROOT" temp_dir archive extract_dir payload
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  fi
  if [ -n "$script_dir" ] && [ -x "$script_dir/megabrain" ] && [ -d "$script_dir/lib" ]; then
    SOURCE_ROOT="$script_dir"
    SOURCE_FROM_CHECKOUT=true
    return 0
  fi
  if [ -x "$checkout_dir/megabrain" ] && [ -d "$checkout_dir/lib" ]; then
    SOURCE_ROOT="$checkout_dir"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || { installer_error "curl is required to install from curl"; return 1; }
  command -v tar >/dev/null 2>&1 || { installer_error "tar is required to install from curl"; return 1; }
  if [ -x "$checkout_dir/megabrain" ] && [ -d "$checkout_dir/lib" ]; then
    SOURCE_ROOT="$checkout_dir"
    return 0
  fi
  [ ! -e "$checkout_dir" ] || { installer_error "install path exists but is not a megabrain install: $checkout_dir"; return 1; }
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-local.XXXXXX")" || { installer_error "could not create a temporary directory"; return 1; }
  archive="$temp_dir/megabrain-local.tar.gz"
  extract_dir="$temp_dir/extract"
  mkdir -p "$extract_dir" || { rm -rf "$temp_dir"; return 1; }
  if ! curl -fsSL -o "$archive" "$TARBALL_URL"; then
    rm -rf "$temp_dir"
    installer_error "could not download $TARBALL_URL"
    return 1
  fi
  if ! tar -xzf "$archive" -C "$extract_dir"; then
    rm -rf "$temp_dir"
    installer_error "could not extract $TARBALL_URL"
    return 1
  fi
  payload="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$payload" ] || { rm -rf "$temp_dir"; installer_error "downloaded archive has no top-level directory"; return 1; }
  mkdir -p "$checkout_dir" || { rm -rf "$temp_dir"; installer_error "could not create $checkout_dir"; return 1; }
  cp -R "$payload/." "$checkout_dir/" || { rm -rf "$temp_dir"; installer_error "could not install extracted archive at $checkout_dir"; return 1; }
  rm -rf "$temp_dir"
  SOURCE_ROOT="$checkout_dir"
  INSTALL_FRESH=true
}

installer_require_bun() {
  command -v bun >/dev/null 2>&1 || {
    installer_error "bun is required to install megabrain; install it from https://bun.sh/docs/installation"
    return 1
  }
}

installer_build_binary() {
  installer_require_bun || return 1
  [ -f "$SOURCE_ROOT/package.json" ] || {
    installer_error "megabrain package manifest is missing: $SOURCE_ROOT/package.json"
    return 1
  }
  # WHY: build through package.json so the installer and release checks use the same command.
  if ! (cd "$SOURCE_ROOT" && bun run build); then
    installer_error "could not compile the megabrain binary with bun run build"
    return 1
  fi
  [ -x "$SOURCE_ROOT/.build/megabrain" ] || {
    installer_error "bun run build did not produce $SOURCE_ROOT/.build/megabrain"
    return 1
  }
  BINARY_BUILT=true
  installer_summary "compiled megabrain binary at $SOURCE_ROOT/.build/megabrain"
}

installer_manifest_path() {
  INSTALL_MANIFEST="$INSTALL_ROOT/install-manifest.json"
}

installer_manifest_summary() {
  local manifest="$INSTALL_MANIFEST"
  [ -f "$manifest" ] || return 0
  printf 'Existing megabrain installation:\n'
  if command -v jq >/dev/null 2>&1 && jq empty "$manifest" >/dev/null 2>&1; then
    jq -r '"  version: " + (.version // "unknown"), "  source: " + (.sourceRef // "unknown"), "  installed: " + (.installedAt // "unknown"), "  agents: " + ((.agents // []) | join(", ") // "none"), "  modules: " + ((.modules // []) | join(", ") // "none"), "  runtime: " + (.runtime // "host")' "$manifest"
  else
    sed 's/^/  /' "$manifest"
  fi
}

installer_prepare_existing_install() {
  local existing=false choice
  installer_manifest_path
  [ "$INSTALL_FRESH" = true ] && return 0
  if [ -f "$INSTALL_MANIFEST" ] || [ -x "$INSTALL_ROOT/megabrain" ]; then
    existing=true
  fi
  [ "$existing" = true ] || return 0
  installer_manifest_summary
  if [ "$SOURCE_FROM_CHECKOUT" = true ] && [ "$(installer_canonical_path "$SOURCE_ROOT")" = "$(installer_canonical_path "$INSTALL_ROOT")" ]; then
    installer_summary "installation already current"
    return 0
  fi
  if [ "$INSTALLER_INTERACTIVE" = false ]; then
    installer_summary "existing installation reconfigured (updated)"
    INSTALL_ACTION=reconfigure
    return 0
  fi
  installer_menu single 'Existing installation found: choose an action' '' update reconfigure abort || return $?
  choice="$INSTALLER_MENU_RESULT"
  case "$choice" in
    update) INSTALL_ACTION=update ;;
    reconfigure) INSTALL_ACTION=reconfigure ;;
    abort) installer_summary "installation skipped"; return 1 ;;
  esac
}

installer_update_from_tarball() {
  local temp_dir archive extract_dir payload staging backup
  command -v curl >/dev/null 2>&1 || { installer_error "curl is required to update from curl"; return 1; }
  command -v tar >/dev/null 2>&1 || { installer_error "tar is required to update from curl"; return 1; }
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-local-update.XXXXXX")" || return 1
  archive="$temp_dir/megabrain-local.tar.gz"
  extract_dir="$temp_dir/extract"
  staging="$temp_dir/staging"
  mkdir -p "$extract_dir" "$staging" || { rm -rf "$temp_dir"; return 1; }
  if ! curl -fsSL -o "$archive" "$TARBALL_URL" || ! tar -xzf "$archive" -C "$extract_dir"; then
    rm -rf "$temp_dir"
    installer_error "could not download or extract $TARBALL_URL"
    return 1
  fi
  payload="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$payload" ] || { rm -rf "$temp_dir"; installer_error "downloaded archive has no top-level directory"; return 1; }
  cp -R "$payload/." "$staging/" || { rm -rf "$temp_dir"; installer_error "could not stage the downloaded archive"; return 1; }
  SOURCE_ROOT="$staging"
  SOURCE_FROM_CHECKOUT=false
  installer_build_binary || { rm -rf "$temp_dir"; return 1; }
  backup="$temp_dir/previous"
  if [ -e "$INSTALL_ROOT" ]; then
    mv "$INSTALL_ROOT" "$backup" || { rm -rf "$temp_dir"; installer_error "could not preserve the previous installation"; return 1; }
  fi
  if ! mv "$staging" "$INSTALL_ROOT"; then
    mv "$backup" "$INSTALL_ROOT" 2>/dev/null || true
    rm -rf "$temp_dir"
    installer_error "could not activate the updated installation"
    return 1
  fi
  rm -rf "$backup" "$temp_dir"
  SOURCE_ROOT="$INSTALL_ROOT"
  SOURCE_FROM_CHECKOUT=false
  installer_summary "installation updated"
}

installer_write_manifest() {
  local version="1.0.0" temp status backup manifest_current=false
  if [ -x "$SOURCE_ROOT/megabrain" ]; then
    version="$($SOURCE_ROOT/megabrain --version 2>/dev/null | awk '{print $2}' | head -n 1)"
    [ -n "$version" ] || version="1.0.0"
  fi
  mkdir -p "$INSTALL_ROOT" || { installer_error "could not create $INSTALL_ROOT for the install manifest"; return 1; }
  if [ -f "$INSTALL_MANIFEST" ]; then
    installer_manifest_matches_selection && manifest_current=true
    backup="$(installer_backup_path "$INSTALL_MANIFEST")"
    cp -p "$INSTALL_MANIFEST" "$backup" || { installer_error "could not back up $INSTALL_MANIFEST to $backup"; return 1; }
    installer_summary "backed up $INSTALL_MANIFEST to $backup"
  fi
  temp="$(mktemp "${INSTALL_MANIFEST}.XXXXXX")" || return 1
  if ! jq -n \
    --arg version "$version" \
    --arg sourceRef "$REPOSITORY_REF" \
    --arg installedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg sourceRoot "$SOURCE_ROOT" \
    --arg agents "$SELECTED_AGENTS" \
    --arg modules "$SELECTED_MODULES" \
    --arg skill "$SKILL_MODE" \
    --arg agentsMd "$AGENTS_MODE" \
    '{version: $version, sourceRef: $sourceRef, installedAt: $installedAt, sourceRoot: $sourceRoot,
      skill: (if $skill == "" then null else $skill end),
      agentsMd: (if $agentsMd == "" then null else $agentsMd end),
      agents: (if $agents == "" then [] else ($agents | split(",")) end),
      modules: (if $modules == "" then [] else ($modules | split(",")) end),
      runtime: (if ($modules == "") then "host" elif (($modules | split(",")) | index("tmux-runtime")) then "tmux" else "host" end)}' >"$temp"; then
    rm -f "$temp"
    installer_error "could not write install manifest"
    return 1
  fi
  if [ -f "$INSTALL_MANIFEST" ]; then
    status=updated
  else
    status=installed
  fi
  mv -f "$temp" "$INSTALL_MANIFEST" || { rm -f "$temp"; return 1; }
  if [ "$manifest_current" = true ]; then
    installer_summary "installation manifest configuration already-current"
  else
    installer_summary "installation manifest configuration reconciled"
  fi
  installer_summary "installation manifest $status at $INSTALL_MANIFEST"
}

installer_prompt_mode() {
  local label="$1"
  [ "$INSTALLER_INTERACTIVE" = true ] || { installer_error "$label requires --skill or --agents-md in a non-interactive shell"; return 1; }
  installer_menu single "$label" '' none global project || return $?
  PROMPT_MODE="$INSTALLER_MENU_RESULT"
}

# WHY: the modules the core workflow needs. Without tmux-runtime every spawn silently
# falls back to an IDE tab instead of a child pane, and without orchestration-hooks
# nothing notices a child whose turn ended without reporting. The simulator and adb
# modules stay out: they are platform specific and pull in extra tooling.
# tmux-runtime joins the default only when tmux is already on PATH, because the module
# would otherwise install tmux without being asked.
installer_default_modules() {
  # WHY tmux-runtime leads: the orchestration module treats orca and superset as optional only
  # once the tmux runtime is enabled, so installing it last made the default install fail on its
  # first module on any machine without an orchestrator.
  # Each module joins the default set only when this machine can actually use it, so the
  # default install finishes rather than stopping on a prerequisite the operator never had.
  local defaults='orchestration,orchestration-hooks'
  command -v tmux >/dev/null 2>&1 && defaults="tmux-runtime,$defaults"
  if command -v superset >/dev/null 2>&1 || [ -x "$HOME/.superset/bin/superset" ]; then
    defaults="$defaults,worktree"
  fi
  printf '%s\n' "$defaults"
}

installer_select_modules() {
  local raw="$MODULES_REQUEST" token normalized
  local -a modules=(orchestration orchestration-hooks worktree simulator-web simulator-native simulator-tv tv-adb tmux-runtime)
  SELECTED_MODULES=""
  if [ -z "$raw" ]; then
    # WHY: selecting nothing here left a fresh machine with the CLI installed and the
    # tool unable to work the way it documents.
    raw="$(installer_default_modules)"
    if [ "$INSTALLER_INTERACTIVE" = true ]; then
      installer_menu multi 'Select megabrain modules to install' "$raw" "${modules[@]}" || return $?
      raw="$INSTALLER_MENU_RESULT"
    fi
  fi
  [ -n "$raw" ] || return 0
  if [ "$raw" = all ]; then
    SELECTED_MODULES="$(IFS=','; printf '%s' "${modules[*]}")"
    return 0
  fi
  IFS=',' read -r -a _installer_requested_modules <<<"$raw"
  for token in "${_installer_requested_modules[@]}"; do
    normalized="$(printf '%s' "$token" | tr -d '[:space:]')"
    [ "$normalized" = none ] && { [ "${#_installer_requested_modules[@]}" -eq 1 ] || { installer_error "none cannot be combined with modules"; return 2; }; return 0; }
    installer_list_contains "$(IFS=','; printf '%s' "${modules[*]}")" "$normalized" || { installer_error "unknown module '$normalized'"; return 2; }
    if ! installer_list_contains "$SELECTED_MODULES" "$normalized"; then
      [ -n "$SELECTED_MODULES" ] && SELECTED_MODULES="$SELECTED_MODULES,"
      SELECTED_MODULES="$SELECTED_MODULES$normalized"
    fi
  done
}

installer_warn_path() {
  local bin_dir="$HOME/.local/bin"
  case ":${PATH:-}:" in
    *:"$bin_dir":*) return 0 ;;
  esac
  printf 'Warning: %s is not on PATH. Add it with:\n' "$bin_dir" >&2
  printf 'export PATH="%s:$PATH"\n' "$bin_dir" >&2
  installer_summary "PATH needs-your-action: add $bin_dir"
  if [ "$ASSUME_YES" = false ] && [ "$INSTALLER_INTERACTIVE" = true ]; then
    read -r -p 'Press Enter to continue: ' _ <"$INSTALLER_INPUT_SOURCE" || true
  fi
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

installer_link_one() {
  local link="$1" target="$2" link_status=installed backup link_target
  if [ -L "$link" ]; then
    link_target="$(readlink "$link")"
    case "$link_target" in
      /*) ;;
      *) link_target="$(dirname "$link")/$link_target" ;;
    esac
    if [ "$(installer_canonical_path "$link_target")" = "$(installer_canonical_path "$target")" ]; then
      installer_summary "$(basename "$link") link already-current at $link"
      return 0
    fi
  elif [ -e "$link" ]; then
    if [ -d "$link" ]; then
      installer_error "refusing to replace directory: $link"
      return 1
    fi
  fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    backup="$(installer_backup_path "$link")"
    mv "$link" "$backup" || { installer_error "could not back up $link to $backup"; return 1; }
    installer_summary "backed up $link to $backup"
    link_status=updated
  fi
  ln -s "$target" "$link" || { installer_error "could not link $link"; return 1; }
  installer_summary "$(basename "$link") link $link_status at $link"
}

installer_link_megabrain() {
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir" || { installer_error "could not create $bin_dir"; return 1; }
  installer_link_one "$bin_dir/megabrain" "$SOURCE_ROOT/megabrain" || return 1
  installer_warn_path
}

installer_copy_skill() {
  local destination="$1" existing="" result="" backup
  existing="$destination/SKILL.md"
  if [ -f "$existing" ]; then
    if cmp -s "$SOURCE_ROOT/skills/megabrain/SKILL.md" "$existing"; then
      installer_summary "Claude Code skill already-current at $destination"
      return 0
    else
      result="updated differing existing skill"
      backup="$(installer_backup_path "$existing")"
      cp -p "$existing" "$backup" || { installer_error "could not back up $existing to $backup"; return 1; }
      installer_summary "backed up $existing to $backup"
    fi
  else
    result="installed"
  fi
  mkdir -p "$destination" || { installer_error "could not create $destination"; return 1; }
  cp -R "$SOURCE_ROOT/skills/megabrain/." "$destination/" || { installer_error "could not copy the Claude Code skill"; return 1; }
  installer_summary "Claude Code skill $result at $destination"
}

installer_verify_plugin() {
  local cli="$1"
  case "$cli" in
    claude)
      claude plugin list 2>/dev/null | grep -Eq 'megabrain@megabrain-local|❯ megabrain@megabrain-local' || return 1
      ;;
    codex)
      codex plugin list 2>/dev/null | grep -Eq 'megabrain@megabrain-local[[:space:]]+installed, enabled' || return 1
      ;;
    agy)
      # Agy imports the Claude Code plugin instead of storing a local copy. Measured
      # on 2026-09-09: plugin list exposes name, source and components only, with no
      # agy plugin path or skill content to compare.
      agy plugin list 2>/dev/null | jq -e '
        [.. | objects
          | select(.name? == "megabrain")
          | select(.source? == "claude-code")
          | select((.components? | type == "array") and ((.components | index("skills")) != null))]
        | length > 0
      ' >/dev/null 2>&1 || return 1
      ;;
  esac
}

installer_marketplace_root() {
  local agent="$1" output line path
  case "$agent" in
    claude) output="$(claude plugin marketplace list 2>/dev/null || true)" ;;
    codex) output="$(codex plugin marketplace list 2>/dev/null || true)" ;;
    *) return 1 ;;
  esac
  line="$(printf '%s\n' "$output" | awk '/megabrain-local/ { found=1; if (match($0, /\/[^"]+/)) { print substr($0, RSTART, RLENGTH); exit } next } found && ($0 ~ /^[[:space:]]/ || $0 ~ /^\//) { if (match($0, /\/[^"]+/)) { print substr($0, RSTART, RLENGTH); exit } }')"
  path="$(printf '%s' "$line" | sed -E 's/[),;]+$//')"
  [ -n "$path" ] || return 1
  if [ -d "$path" ]; then
    (cd -P "$path" && pwd)
  else
    printf '%s\n' "$path"
  fi
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

installer_reconcile_marketplace() {
  local agent="$1" existing choice
  existing="$(installer_marketplace_root "$agent" 2>/dev/null || true)"
  if [ -z "$existing" ]; then
    case "$agent" in
      claude) claude plugin marketplace add "$SOURCE_ROOT" || { installer_error "could not register the Claude marketplace"; return 1; } ;;
      codex) codex plugin marketplace add "$SOURCE_ROOT" || { installer_error "could not register the Codex marketplace"; return 1; } ;;
    esac
    installer_summary "$agent marketplace installed at $SOURCE_ROOT"
    return 0
  fi
  if [ "$(installer_canonical_path "$existing")" = "$(installer_canonical_path "$SOURCE_ROOT")" ]; then
    installer_summary "$agent marketplace already-current at $existing"
    return 0
  fi
  printf 'Existing %s marketplace: %s\n' "$agent" "$existing"
  printf 'Installer marketplace: %s\n' "$SOURCE_ROOT"
  if [ "$INSTALLER_INTERACTIVE" = true ]; then
    installer_menu single "The $agent marketplace name already points elsewhere" '' keep replace || return $?
    choice="$INSTALLER_MENU_RESULT"
  else
    # WHY: keeping the old path here left the install to ask a marketplace that was
    # never registered for the plugin, so --yes could only ever fail.
    choice=replace
    installer_summary "$agent marketplace repointed from $existing without asking (--yes)"
  fi
  if [ "$choice" = keep ]; then
    [ "$INSTALLER_INTERACTIVE" = true ] && installer_summary "$agent marketplace already-current; kept existing path $existing"
    return 0
  fi
  case "$agent" in
    claude) claude plugin marketplace remove megabrain-local || { installer_error "could not remove the existing Claude marketplace"; return 1; } ;;
    codex) codex plugin marketplace remove megabrain-local || { installer_error "could not remove the existing Codex marketplace"; return 1; } ;;
  esac
  case "$agent" in
    claude) claude plugin marketplace add "$SOURCE_ROOT" || { installer_error "could not register the Claude marketplace"; return 1; } ;;
    codex) codex plugin marketplace add "$SOURCE_ROOT" || { installer_error "could not register the Codex marketplace"; return 1; } ;;
  esac
  installer_summary "$agent marketplace updated to $SOURCE_ROOT"
}

# WHY: the plugin cache is keyed by version, and the version does not move while the
# tool is being developed, so an edited skill never reaches a new session. Measured:
# claude plugin update answers "already at the latest version" and copies nothing, which
# is how a machine ended up serving a months-old snapshot of the skill. Compare the
# cached skill against the source instead of trusting the version.
installer_plugin_cache_stale() {
  local agent="$1" source_skill="$SOURCE_ROOT/skills/megabrain/SKILL.md" cached found=false
  [ -f "$source_skill" ] || return 1
  case "$agent" in
    claude) set -- "$HOME"/.claude/plugins/cache/megabrain-local/megabrain/*/skills/megabrain/SKILL.md ;;
    codex) set -- "$HOME"/.codex/plugins/cache/megabrain-local/megabrain/*/skills/megabrain/SKILL.md ;;
    agy)
      if installer_verify_plugin agy; then
        return 1
      fi
      return 0
      ;;
    *) return 1 ;;
  esac
  for cached in "$@"; do
    [ -f "$cached" ] || continue
    found=true
    cmp -s "$source_skill" "$cached" || return 0
  done
  [ "$found" = true ] || return 1
  return 1
}

installer_refresh_plugin_cache() {
  local agent="$1"
  installer_plugin_cache_stale "$agent" || return 0
  case "$agent" in
    claude) claude plugin uninstall 'megabrain@megabrain-local' >/dev/null 2>&1 || true ;;
    codex) codex plugin remove 'megabrain@megabrain-local' >/dev/null 2>&1 || true ;;
    agy) agy plugin uninstall megabrain >/dev/null 2>&1 || true ;;
    *) return 0 ;;
  esac
  installer_summary "$agent plugin cache was stale and is being reinstalled from $SOURCE_ROOT"
}

installer_install_plugin_command() {
  local agent="$1" output rc=0
  shift
  installer_refresh_plugin_cache "$agent"
  if installer_verify_plugin "$agent"; then
    installer_summary "$agent plugin already-current"
    return 0
  fi
  output="$("$@" 2>&1)" || rc=$?
  [ -n "$output" ] && printf '%s\n' "$output"
  if [ "$rc" -ne 0 ] && ! printf '%s' "$output" | grep -Eiq 'already[[:space:]]+installed|already[[:space:]]+enabled'; then
    return "$rc"
  fi
  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -Eiq 'already[[:space:]]+installed|already[[:space:]]+enabled' && installer_verify_plugin "$agent"; then
      installer_summary "$agent plugin already-current"
      return 0
    fi
    return "$rc"
  fi
  installer_verify_plugin "$agent" || return 1
  installer_summary "$agent plugin installed"
}

installer_install_claude() {
  case "$SKILL_MODE" in
    global)
      installer_reconcile_marketplace claude || return 1
      installer_install_plugin_command claude claude plugin install "megabrain@megabrain-local" || { installer_error "could not install megabrain from the Claude marketplace"; return 1; }
      ;;
    project)
      installer_copy_skill "$PWD/.claude/skills/megabrain"
      ;;
    none)
      installer_summary "skipped Claude plugin installation (--skill none)"
      ;;
  esac
}

installer_install_codex() {
  installer_reconcile_marketplace codex || return 1
  installer_install_plugin_command codex codex plugin add "megabrain@megabrain-local" || { installer_error "could not install megabrain from the Codex marketplace"; return 1; }
}

installer_install_agy() {
  installer_install_plugin_command agy agy plugin install "$SOURCE_ROOT" || { installer_error "could not install the agy plugin from $SOURCE_ROOT"; return 1; }
}

installer_install_plugins() {
  local agent
  [ -n "$SELECTED_AGENTS" ] || return 0
  IFS=',' read -r -a _installer_selected_agents <<<"$SELECTED_AGENTS"
  for agent in "${_installer_selected_agents[@]}"; do
    case "$agent" in
      claude) installer_install_claude || return 1 ;;
      codex) installer_install_codex || return 1 ;;
      agy) installer_install_agy || return 1 ;;
    esac
  done
}

installer_install_modules() {
  local module state_file state_tmp
  if ! installer_list_contains "$SELECTED_MODULES" tmux-runtime; then
    state_file="$HOME/.megabrain/state.json"
    if [ -f "$state_file" ] && jq empty "$state_file" >/dev/null 2>&1; then
      state_tmp="$(mktemp "${state_file}.XXXXXX")" || return 1
      if ! jq 'del(."tmux-runtime")' "$state_file" >"$state_tmp"; then
        rm -f "$state_tmp"
        return 1
      fi
      mv -f "$state_tmp" "$state_file" || return 1
      installer_summary "tmux runtime disabled"
    fi
  fi
  if [ -z "$SELECTED_MODULES" ]; then
    installer_summary "megabrain modules skipped"
    return 0
  fi
  IFS=',' read -r -a _installer_selected_modules <<<"$SELECTED_MODULES"
  for module in "${_installer_selected_modules[@]}"; do
    if [ "$ASSUME_YES" = true ]; then
      "$SOURCE_ROOT/megabrain" install "$module" --yes
    else
      "$SOURCE_ROOT/megabrain" install "$module"
    fi
    if [ "$?" -eq 0 ]; then
      installer_summary "megabrain module $module installed"
    else
      installer_error "could not install megabrain module $module"
      return 1
    fi
  done
}

installer_pointer_paragraph() {
  awk 'NF { print; exit }' "$SOURCE_ROOT/AGENTS.md"
}

installer_append_pointer() {
  local file="$1" paragraph="$2" temp
  mkdir -p "$(dirname "$file")" || return 1
  if [ -f "$file" ] && grep -Fqx "$paragraph" "$file"; then
    installer_summary "AGENTS.md pointer already-current in $file"
    return 0
  fi
  if [ -f "$file" ] && grep -Eq '^# megabrain recipes([[:space:]]|$)' "$file"; then
    temp="$(mktemp "${file}.XXXXXX")" || return 1
    awk -v replacement="$paragraph" '
      BEGIN { replaced = 0 }
      /^# megabrain recipes([[:space:]]|$)/ {
        if (!replaced) print replacement
        replaced = 1
        next
      }
      { print }
      END { if (!replaced) print replacement }
    ' "$file" >"$temp" || { rm -f "$temp"; return 1; }
    mv -f "$temp" "$file" || { rm -f "$temp"; return 1; }
    installer_summary "AGENTS.md pointer updated in $file"
    return 0
  fi
  if [ -s "$file" ] && [ "$(tail -c 1 "$file" | wc -l | tr -d ' ')" -eq 0 ]; then
    printf '\n' >>"$file"
  fi
  printf '%s\n' "$paragraph" >>"$file"
  installer_summary "AGENTS.md pointer installed in $file"
}

installer_manifest_matches_selection() {
  [ -f "$INSTALL_MANIFEST" ] || return 1
  jq -e \
    --arg agents "$SELECTED_AGENTS" --arg modules "$SELECTED_MODULES" \
    --arg skill "$SKILL_MODE" --arg agentsMd "$AGENTS_MODE" '
      (.agents // []) == (if $agents == "" then [] else ($agents | split(",")) end)
      and (.modules // []) == (if $modules == "" then [] else ($modules | split(",")) end)
      and (.skill // null) == (if $skill == "" then null else $skill end)
      and (.agentsMd // null) == (if $agentsMd == "" then null else $agentsMd end)
    ' "$INSTALL_MANIFEST" >/dev/null 2>&1
}

installer_install_agents() {
  local paragraph
  paragraph="$(installer_pointer_paragraph)"
  [ -n "$paragraph" ] || { installer_error "could not read the AGENTS.md pointer paragraph"; return 1; }
  case "$AGENTS_MODE" in
    global)
      installer_append_pointer "$HOME/.codex/AGENTS.md" "$paragraph" || return 1
      installer_append_pointer "$HOME/.agy/AGENTS.md" "$paragraph" || return 1
      ;;
    project)
      installer_append_pointer "$PWD/AGENTS.md" "$paragraph" || return 1
      ;;
    none) installer_summary "skipped AGENTS.md snippet" ;;
  esac
}

installer_main() {
  local summary_line
  installer_parse_args "$@" || return $?
  installer_resolve_input_source
  installer_init_style
  installer_require_bun || return 1
  installer_source_root || return 1
  [ -x "$SOURCE_ROOT/megabrain" ] && [ -d "$SOURCE_ROOT/lib" ] || { installer_error "megabrain checkout is incomplete: $SOURCE_ROOT"; return 1; }
  [ -f "$SOURCE_ROOT/skills/megabrain/SKILL.md" ] || { installer_error "megabrain skill is missing from $SOURCE_ROOT"; return 1; }
  [ -f "$SOURCE_ROOT/AGENTS.md" ] || { installer_error "AGENTS.md is missing from $SOURCE_ROOT"; return 1; }
  [ -f "$SOURCE_ROOT/.claude-plugin/plugin.json" ] || { installer_error "Claude plugin manifest is missing from $SOURCE_ROOT"; return 1; }
  [ -f "$SOURCE_ROOT/.codex-plugin/plugin.json" ] || { installer_error "Codex plugin manifest is missing from $SOURCE_ROOT"; return 1; }
  installer_prepare_existing_install || return 1
  if [ "$INSTALL_ACTION" = update ]; then
    if [ "$SOURCE_FROM_CHECKOUT" = true ]; then
      installer_summary "installation updated from checkout"
    else
      installer_update_from_tarball || return 1
    fi
  fi
  [ "$BINARY_BUILT" = true ] || installer_build_binary || return 1
  installer_link_megabrain || return 1
  installer_detect_agents
  installer_select_agents || return $?
  installer_summary "selected agent CLIs: ${SELECTED_AGENTS:-none}"
  if installer_list_contains "$SELECTED_AGENTS" claude && [ -z "$SKILL_MODE" ]; then
    installer_prompt_mode 'Install the Claude Code skill?' || return 1
    SKILL_MODE="$PROMPT_MODE"
  fi
  installer_install_plugins || return 1
  if [ -z "$AGENTS_MODE" ]; then
    installer_prompt_mode 'Install the AGENTS.md snippet?' || return 1
    AGENTS_MODE="$PROMPT_MODE"
  fi
  installer_install_agents || return 1
  installer_select_modules || return $?
  installer_install_modules || return 1
  installer_write_manifest || return 1
  printf '\n%sInstallation summary:%s\n' "$INSTALLER_STYLE_BOLD" "$INSTALLER_STYLE_RESET"
  if [ "${#SUMMARY_LINES[@]}" -gt 0 ]; then
    for summary_line in "${SUMMARY_LINES[@]}"; do
      installer_print_summary_line "$summary_line"
    done
  fi
}

installer_main "$@"
