#!/usr/bin/env bash

MEGABRAIN_AGENT_OPTION_TEMPLATES='codex|-c|model="%s"|-c|model_reasoning_effort="%s"|-c|mcp_servers.playwright.enabled=%s
claude|--model|%s|--effort|%s|||
agy|--model|%s|||||'
# Codex has no --model or --effort flags, so its overrides use -c.
MEGABRAIN_AGY_MODEL_IDS='gemini-3.8-flash-high
gemini-3.8-flash-medium
gemini-3.8-flash-low
gemini-3.7-flash-high
gemini-3.7-flash-medium
gemini-3.7-flash-low
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.1-pro-high
gemini-3.1-pro-low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium'
MEGABRAIN_AGENT_LAUNCH_ARGS='codex|--dangerously-bypass-hook-trust
codex|--dangerously-bypass-approvals-and-sandbox
claude|--dangerously-skip-permissions
agy|--dangerously-skip-permissions'
MEGABRAIN_AGENT_READY_TIMEOUT_MS="${MEGABRAIN_AGENT_READY_TIMEOUT_MS:-10000}"
MEGABRAIN_TERMINAL_KILLED_TREE='[]'

megabrain_worktree_root() {
  local raw read_only=false
  if [ "${1:-}" = --read-only ]; then
    read_only=true
  fi
  if ! megabrain_superset_available; then
    megabrain_error "superset CLI is required for shared worktrees"
    return 1
  fi
  raw="$(megabrain_superset settings get worktreeBaseDir 2>/dev/null || true)"
  raw="$(printf '%s\n' "$raw" | megabrain_trim)"
  if [ -n "$raw" ] && [ "$raw" != "null" ]; then
    raw="$(printf '%s' "$raw" | jq -r 'if type == "object" then (.value // .result.value // .path // .result.path // empty) elif type == "string" then . else empty end' 2>/dev/null || printf '%s' "$raw")"
    raw="$(printf '%s\n' "$raw" | megabrain_trim)"
  fi
  if [ -z "$raw" ]; then
    if [ "$read_only" = true ] || [ ! -t 0 ]; then
      megabrain_error "Superset worktreeBaseDir is unset; run superset settings set worktreeBaseDir <path>"
      return 1
    fi
    read -r -p "Shared worktree root: " raw
    [ -n "$raw" ] || { megabrain_error "worktree root cannot be empty"; return 1; }
    megabrain_superset settings set worktreeBaseDir "$raw" >/dev/null || return 1
  fi
  raw="${raw/#\~/$HOME}"
  if [ "${raw#/}" = "$raw" ]; then
    raw="$PWD/$raw"
  fi
  MEGABRAIN_SHARED_ROOT="$(cd "$raw" 2>/dev/null && pwd -P || true)"
  if [ -z "$MEGABRAIN_SHARED_ROOT" ]; then
    MEGABRAIN_SHARED_ROOT="$raw"
  fi
  printf '%s\n' "$MEGABRAIN_SHARED_ROOT"
}

megabrain_repo_from_orca() {
  local selector="$1"
  local selector_lower path display_name display_lower base_name git_root common_dir canonical_root
  selector_lower="$(megabrain_lower "$selector")"
  if [ -d "$selector" ] && git -C "$selector" rev-parse --show-toplevel >/dev/null 2>&1; then
    git_root="$(git -C "$selector" rev-parse --show-toplevel)"
    common_dir="$(git -C "$selector" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    case "$common_dir" in
      */.git)
        canonical_root="${common_dir%/.git}"
        if git -C "$canonical_root" rev-parse --show-toplevel >/dev/null 2>&1; then
          printf '%s\n' "$(git -C "$canonical_root" rev-parse --show-toplevel)"
          return 0
        fi
        ;;
    esac
    printf '%s\n' "$git_root"
    return 0
  fi
  if [ -f "$selector" ] && git -C "$(dirname "$selector")" rev-parse --show-toplevel >/dev/null 2>&1; then
    git -C "$(dirname "$selector")" rev-parse --show-toplevel
    return 0
  fi
  if ! megabrain_require_command orca; then
    megabrain_error "repo must be a git path when orca is not installed"
    return 1
  fi
  while IFS=$'\t' read -r display_name path; do
    [ -n "$path" ] || continue
    display_lower="$(megabrain_lower "$display_name")"
    base_name="$(megabrain_lower "$(basename "$path")")"
    if [ "$selector_lower" = "$display_lower" ] || [ "$selector_lower" = "$base_name" ]; then
      printf '%s\n' "$path"
      return 0
    fi
  done < <(orca repo list --json 2>/dev/null | jq -r '.result.repos[]? | [(.displayName // ""), (.path // "")] | @tsv' 2>/dev/null)
  megabrain_error "repo not found: $selector"
  return 1
}

megabrain_repo_default_base() {
  local repo="$1"
  local base
  base="$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  base="${base#origin/}"
  if [ -z "$base" ]; then
    base="$(git -C "$repo" config --get init.defaultBranch 2>/dev/null || true)"
  fi
  if [ -z "$base" ]; then
    base="main"
  fi
  printf '%s\n' "$base"
}

megabrain_slug_from_branch() {
  local branch="$1"
  branch="${branch//\//-}"
  if [ -z "$branch" ] || [ "$branch" = "." ] || [ "$branch" = ".." ] || [[ "$branch" == *"/"* ]] || [[ "$branch" == *$'\n'* ]]; then
    return 1
  fi
  printf '%s\n' "$branch"
}

megabrain_agy_model_known() {
  if declare -F megabrain_model_known >/dev/null 2>&1 && megabrain_model_known agy "$1"; then
    return 0
  fi
  printf '%s\n' "$MEGABRAIN_AGY_MODEL_IDS" | grep -Fx -- "$1" >/dev/null 2>&1
}

megabrain_agy_model_error() {
  megabrain_error "$1"
  printf 'Valid agy model ids:\n%s\n' "$MEGABRAIN_AGY_MODEL_IDS" >&2
}

megabrain_agy_model_id() {
  local model="$1" effort="$2" base candidate
  case "$model" in
    *-high) base="${model%-high}" ;;
    *-medium) base="${model%-medium}" ;;
    *-low) base="${model%-low}" ;;
    *) base="$model" ;;
  esac
  if declare -F megabrain_model_known >/dev/null 2>&1 && megabrain_model_known agy "$model"; then
    if megabrain_model_validate_reasoning agy "$model" "$effort" >/dev/null 2>&1; then
      printf '%s\n' "$model"
      return 0
    fi
  fi
  candidate="${base}-${effort}"
  if megabrain_agy_model_known "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  megabrain_agy_model_error "agy cannot honor effort '$effort' for model '$model'"
  return 1
}

megabrain_superset_projects_json() {
  megabrain_superset projects list --json 2>/dev/null
}

megabrain_superset_workspaces_json() {
  megabrain_superset workspaces list --local --json 2>/dev/null
}

megabrain_project_id_for_path() {
  local repo_path="$1"
  megabrain_superset_projects_json | jq -r --arg path "$repo_path" '
    (if type == "array" then . else (.result.projects? // .projects? // .result? // []) end)[]? |
    select((.path // .localPath // .repoPath // "") == $path) |
    (.id // .projectId // .project.id // empty)' 2>/dev/null | head -n 1
}

megabrain_project_name_for_path() {
  local repo_path="$1"
  local name
  name="$(orca repo list --json 2>/dev/null | jq -r --arg path "$repo_path" '.result.repos[]? | select(.path == $path) | .displayName' 2>/dev/null | head -n 1)"
  if [ -z "$name" ]; then
    name="$(basename "$repo_path")"
  fi
  printf '%s\n' "$name"
}

megabrain_ensure_superset_project() {
  local repo_path="$1" record=false
  local project_id project_name response created=false
  [ "${2:-}" = --record ] && record=true
  project_id="$(megabrain_project_id_for_path "$repo_path")"
  if [ -n "$project_id" ]; then
    if [ "$record" = true ]; then
      jq -n --arg id "$project_id" '{id: $id, created: false}'
    else
      printf '%s\n' "$project_id"
    fi
    return 0
  fi
  project_name="$(megabrain_project_name_for_path "$repo_path")"
  response="$(megabrain_superset projects create --local --import "$repo_path" --name "$project_name" --json 2>/dev/null || true)"
  project_id="$(printf '%s' "$response" | jq -r '.result.project.id // .result.id // .project.id // .id // empty' 2>/dev/null)"
  [ -n "$project_id" ] && created=true
  if [ -z "$project_id" ]; then
    project_id="$(megabrain_project_id_for_path "$repo_path")"
  fi
  [ -n "$project_id" ] || { megabrain_error "could not register Superset project for $repo_path"; return 1; }
  if [ "$record" = true ]; then
    jq -n --arg id "$project_id" --arg created "$(if [ "$created" = true ]; then printf true; else printf unknown; fi)" \
      '{id: $id, created: (if $created == "true" then true elif $created == "unknown" then "unknown" else false end)}'
  else
    printf '%s\n' "$project_id"
  fi
}

megabrain_workspace_id_for_target() {
  local target="$1"
  megabrain_superset_workspaces_json | jq -r --arg target "$target" '
    (if type == "array" then . else (.result.workspaces? // .workspaces? // .result? // []) end)[]? |
    select((.branch // .git.branch // "" | sub("^refs/heads/"; "")) == $target or
           (.worktreePath // .path // .worktree.path // "") == $target or
           (.name // "") == $target) |
    (.id // .workspaceId // .workspace.id // empty)' 2>/dev/null | head -n 1
}

megabrain_workspace_path_for_target() {
  local target="$1"
  megabrain_superset_workspaces_json | jq -r --arg target "$target" '
    (if type == "array" then . else (.result.workspaces? // .workspaces? // .result? // []) end)[]? |
    select((.branch // .git.branch // "" | sub("^refs/heads/"; "")) == $target or
           (.worktreePath // .path // .worktree.path // "") == $target or
           (.name // "") == $target) |
    (.worktreePath // .path // .worktree.path // empty)' 2>/dev/null | head -n 1
}

megabrain_superset_tag_from_branch() {
  local branch="$1"
  # Superset tag slash acceptance was not measured against its server (2026-09-09).
  # Keep the grouping key a pure, selector-independent function of the parent branch.
  branch="$(printf '%s' "$branch" | tr '/' '-')"
  printf '%s\n' "$branch"
}

megabrain_worktree_parent_resolve() {
  local selector="$1" repo_path="$2" kind="" value="" path="" branch="" line="" current_path=""
  case "$selector" in
    branch:)
      megabrain_error "parent worktree could not be resolved: $selector"
      return 1
      ;;
    branch:*)
      kind=branch
      value="$(printf '%s' "$selector" | sed 's/^branch://')"
      ;;
    path:*)
      kind=path
      value="$(printf '%s' "$selector" | sed 's/^path://')"
      ;;
    *)
      megabrain_error "parent worktree could not be resolved: $selector (use branch:<branch> or path:<path>)"
      return 1
      ;;
  esac
  if [ -z "$value" ]; then
    megabrain_error "parent worktree could not be resolved: $selector"
    return 1
  fi
  if [ "$kind" = path ]; then
    path="$(git -C "$value" rev-parse --show-toplevel 2>/dev/null || true)"
  else
    current_path=""
    while IFS= read -r line; do
      case "$line" in
        'worktree '*) current_path="$(printf '%s' "$line" | sed 's/^worktree //')" ;;
        "branch refs/heads/$value") path="$current_path"; break ;;
      esac
    done < <(git -C "$repo_path" worktree list --porcelain 2>/dev/null || true)
  fi
  if [ -z "$path" ] || ! git -C "$path" rev-parse --show-toplevel >/dev/null 2>&1; then
    megabrain_error "parent worktree could not be resolved: $selector"
    return 1
  fi
  branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$branch" ]; then
    megabrain_error "parent worktree is detached: $selector"
    return 1
  fi
  MEGABRAIN_PARENT_PATH="$(git -C "$path" rev-parse --show-toplevel)"
  MEGABRAIN_PARENT_BRANCH="$branch"
  MEGABRAIN_PARENT_TAG="$(megabrain_superset_tag_from_branch "$branch")"
}

megabrain_worktree_parent_branch() {
  local path="$1" branch response
  branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ -n "$branch" ] || return 1
  git -C "$path" config --get "branch.$branch.megabrain-parent" 2>/dev/null && return 0
  if megabrain_require_command orca; then
    response="$(orca worktree show --worktree "path:$path" --json 2>/dev/null || true)"
    printf '%s' "$response" | jq -r '
      .result.worktree.parentWorktree.branch //
      .result.worktree.parent.branch //
      .result.parentWorktree.branch //
      .parentWorktree.branch // empty
    ' 2>/dev/null | head -n 1
  fi
}

megabrain_worktree_target_path() {
  local target="$1" shared_root="${2:-}" path
  if [ -d "$target" ]; then
    git -C "$target" rev-parse --show-toplevel 2>/dev/null && return 0
  fi
  if [ -n "$shared_root" ]; then
    path="$(megabrain_find_worktree_path "$target" "$shared_root" 2>/dev/null || true)"
    [ -n "$path" ] && { printf '%s\n' "$path"; return 0; }
  fi
  git worktree list --porcelain 2>/dev/null | awk -v target="$target" '
    /^worktree / { path = $0; sub(/^worktree /, "", path) }
    /^branch / {
      branch = $0; sub(/^branch refs\/heads\//, "", branch)
      if (branch == target || path ~ "/" target "$" ) print path
    }
  ' | head -n 1
}

megabrain_workspace_create() {
  local project_id="$1" branch="$2" slug="$3" record=false
  local response id existing_id created=false command_status=0 tag="" pr_number=""
  MEGABRAIN_WORKSPACE_TAG_SET=false
  MEGABRAIN_WORKSPACE_TAG_ERROR=""
  shift 3
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --record) record=true; shift ;;
      --tag) tag="$2"; shift 2 ;;
      --pr) pr_number="$2"; shift 2 ;;
      *) megabrain_error "unknown Superset workspace option: $1"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  existing_id="$(megabrain_workspace_id_for_target "$branch")"
  if [ -n "$existing_id" ] && [ -n "$tag" ]; then
    response=""
    command_status=0
    response="$(megabrain_superset workspaces update "$existing_id" --tag "$tag" --json 2>/dev/null)" || command_status=$?
    id="$existing_id"
    if [ "$command_status" -eq 0 ]; then
      MEGABRAIN_WORKSPACE_TAG_SET=true
    else
      MEGABRAIN_WORKSPACE_TAG_ERROR="Superset workspace tag was not set for $existing_id"
    fi
  else
    command_status=0
    if [ -n "$pr_number" ]; then
      response="$(megabrain_superset workspaces create --local --project "$project_id" --pr "$pr_number" --name "$slug" --json 2>/dev/null)" || command_status=$?
    else
      response="$(megabrain_superset workspaces create --local --project "$project_id" --branch "$branch" --name "$slug" --json 2>/dev/null)" || command_status=$?
    fi
    id="$(printf '%s' "$response" | jq -r '.result.workspace.id // .result.id // .workspace.id // .id // empty' 2>/dev/null)"
    [ -n "$id" ] && created=true
    if [ -z "$id" ]; then
      id="$(megabrain_workspace_id_for_target "$branch")"
    fi
    if [ -n "$id" ] && [ -n "$tag" ]; then
      command_status=0
      response="$(megabrain_superset workspaces update "$id" --tag "$tag" --json 2>/dev/null)" || command_status=$?
      if [ "$command_status" -eq 0 ]; then
        MEGABRAIN_WORKSPACE_TAG_SET=true
      else
        MEGABRAIN_WORKSPACE_TAG_ERROR="Superset workspace tag was not set for $branch"
      fi
    fi
  fi
  [ -n "$id" ] || { megabrain_error "could not create or find Superset workspace for $branch"; return 1; }
  [ -n "$existing_id" ] && created=false
  if [ "$record" = true ]; then
    jq -n --arg id "$id" --arg created "$(if [ "$created" = true ]; then printf true; elif [ -n "$existing_id" ]; then printf false; else printf unknown; fi)" \
      --argjson tagSet "$MEGABRAIN_WORKSPACE_TAG_SET" --arg tagError "$MEGABRAIN_WORKSPACE_TAG_ERROR" \
      '{id: $id, created: (if $created == "true" then true elif $created == "unknown" then "unknown" else false end), tagSet: $tagSet, tagError: (if $tagError|length > 0 then $tagError else null end)}'
  else
    printf '%s\n' "$id"
  fi
}

megabrain_agent_command() {
  local agent="$1" model="$2" effort="$3"
  local browser=false agent_lower model_flag model_format effort_flag effort_format model_value effort_value
  local browser_flag browser_format browser_value
  local option_template known_agent known_model_flag known_model_format known_effort_flag known_effort_format known_browser_flag known_browser_format
  local launch_agent launch_arg
  shift 3
  if [ "${1:-}" = true ] || [ "${1:-}" = false ]; then
    browser="$1"
    shift
  fi
  local -a command_parts passthrough_args=()
  [ "$#" -eq 0 ] || passthrough_args=("$@")
  command_parts=("$agent")
  agent_lower="$(megabrain_lower "$agent")"
  if [ "$agent_lower" = agy ] && [ -n "$model" ]; then
    [ -n "$effort" ] || {
      megabrain_agy_model_error "agy requires an effort that is part of the model id"
      return 1
    }
    model="$(megabrain_agy_model_id "$model" "$effort")" || return 1
  fi
  while IFS='|' read -r launch_agent launch_arg; do
    [ "$launch_agent" = "$agent_lower" ] && command_parts+=("$launch_arg")
  done <<EOF
$MEGABRAIN_AGENT_LAUNCH_ARGS
EOF
  option_template='--model|%s|--effort|%s'
  while IFS='|' read -r known_agent known_model_flag known_model_format known_effort_flag known_effort_format known_browser_flag known_browser_format; do
    if [ "$known_agent" = "$agent_lower" ]; then
      option_template="$known_model_flag|$known_model_format|$known_effort_flag|$known_effort_format"
      browser_flag="$known_browser_flag"
      browser_format="$known_browser_format"
      break
    fi
  done <<EOF
$MEGABRAIN_AGENT_OPTION_TEMPLATES
EOF
  IFS='|' read -r model_flag model_format effort_flag effort_format <<<"$option_template"
  if [ -n "$model" ]; then
    printf -v model_value "$model_format" "$model"
    command_parts+=("$model_flag" "$model_value")
  fi
  if [ -n "$effort" ] && [ -n "$effort_flag" ]; then
    printf -v effort_value "$effort_format" "$effort"
    command_parts+=("$effort_flag" "$effort_value")
  fi
  if [ -n "$browser_flag" ]; then
    printf -v browser_value "$browser_format" "$browser"
    command_parts+=("$browser_flag" "$browser_value")
  fi
  if [ "${#passthrough_args[@]}" -gt 0 ]; then
    command_parts+=("${passthrough_args[@]}")
  fi
  printf '%q ' "${command_parts[@]}"
}

megabrain_terminal_command_with_agent_permissions() {
  local command_text="$1" prefix agent_lower launch_agent launch_arg launch_args="" rest
  if [[ "$command_text" =~ ^([[:space:]]*(env[[:space:]]+)?([a-zA-Z_][a-zA-Z0-9_]*=[^[:space:]]*[[:space:]]+)*)(codex|claude|agy)([[:space:]]|$) ]]; then
    prefix="${BASH_REMATCH[1]}"
    agent_lower="${BASH_REMATCH[4]}"
  else
    printf '%s\n' "$command_text"
    return 0
  fi
  rest="${command_text:${#prefix}+${#agent_lower}}"
  while IFS='|' read -r launch_agent launch_arg; do
    if [ "$launch_agent" = "$agent_lower" ]; then
      case " $command_text " in
        *" $launch_arg "*) ;;
        *) launch_args="$launch_args $(printf '%q' "$launch_arg")" ;;
      esac
    fi
  done <<EOF
$MEGABRAIN_AGENT_LAUNCH_ARGS
EOF
  printf '%s%s%s%s\n' "$prefix" "$agent_lower" "$launch_args" "$rest"
}

megabrain_resolve_spawn_runtime() {
  local requested="${1:-auto}"
  MEGABRAIN_SPAWN_RUNTIME=""
  MEGABRAIN_SPAWN_CONTEXT=""
  case "$requested" in
    auto)
      if megabrain_runtime_enabled; then
        requested=tmux
      else
        requested=host
      fi
      ;;
    true) requested=tmux ;;
    false) requested=host ;;
    tmux|host) ;;
    *) megabrain_error "invalid spawn runtime: $requested"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
  if [ "$requested" = tmux ]; then
    megabrain_tmux_available || { megabrain_error "tmux spawn runtime was selected but tmux is not on PATH"; return 1; }
  fi
  megabrain_session_id >/dev/null
  if [ -z "$MEGABRAIN_SESSION_ID" ]; then
    if [ "$requested" = host ]; then
      megabrain_error "IDE spawn runtime requires a managed Orca or Superset terminal"
      return 1
    fi
    megabrain_error "tmux spawn runtime requires a managed Orca or Superset terminal"
    return 1
  fi
  MEGABRAIN_SPAWN_RUNTIME="$requested"
  MEGABRAIN_SPAWN_CONTEXT="$MEGABRAIN_SESSION_HOST"
  case "$MEGABRAIN_SPAWN_CONTEXT" in
    orca|superset) ;;
    tmux)
      [ "$requested" = tmux ] || { megabrain_error "IDE spawn runtime requires a managed Orca or Superset terminal"; return 1; }
      ;;
    *) megabrain_error "cannot launch agent from unknown orchestration host"; return 1 ;;
  esac
}

megabrain_project_run_command() {
  local repo_root="$1" config_path="$1/.superset/config.json" command_text
  [ -f "$config_path" ] || return 1
  command_text="$(jq -er '
    if (.run? | type) == "array" then
      [.run[]? | select(type == "string" and length > 0)] |
      if length > 0 then join(" && ") else empty end
    else
      empty
    end
  ' "$config_path" 2>/dev/null)" || return 1
  [ -n "$command_text" ] || return 1
  printf '%s\n' "$command_text"
}

megabrain_tmux_cleanup_launch() {
  local context="$1" workspace_id="$2" terminal_id="$3" tmux_session="$4" tmux_pane="$5" host_terminal_created="$6"
  if [ -n "$tmux_pane" ] && declare -F megabrain_tmux_pipe_pane_stop >/dev/null 2>&1; then
    megabrain_tmux_pipe_pane_stop "$tmux_pane" >/dev/null 2>&1 || true
  fi
  if [ "$host_terminal_created" = true ]; then
    tmux kill-session -t "$tmux_session" >/dev/null 2>&1 || true
    [ -n "$terminal_id" ] || return 0
    case "$context" in
      superset) megabrain_superset terminals close --workspace "$workspace_id" --terminal "$terminal_id" --json >/dev/null 2>&1 || true ;;
      orca) orca terminal close --terminal "$terminal_id" --json >/dev/null 2>&1 || true ;;
    esac
  elif [ -n "$tmux_pane" ]; then
    tmux kill-pane -t "$tmux_pane" >/dev/null 2>&1 || true
  fi
}

megabrain_host_cleanup_launch() {
  local context="$1" workspace_id="$2" terminal_id="$3"
  case "$context" in
    superset) megabrain_superset terminals close --workspace "$workspace_id" --terminal "$terminal_id" --json >/dev/null 2>&1 || true ;;
    orca) orca terminal close --terminal "$terminal_id" --json >/dev/null 2>&1 || true ;;
  esac
}

megabrain_dispatch_browser_notice() {
  case "${1:-false}" in
    true)
      printf 'browser MCP is enabled for this dispatch.\n'
      ;;
    false)
      printf 'browser MCP is unavailable for this dispatch; if the task requires browser access, report that plainly and rerun with --browser.\n'
      ;;
    *)
      megabrain_error "browser MCP setting must be true or false"
      return "$MEGABRAIN_USAGE_ERROR"
      ;;
  esac
}

megabrain_host_terminal_readback() {
  local context="$1" workspace_id="$2" terminal_id="$3" response
  # WHY: Read-back fails at creation instead of waiting 30 seconds for a receipt from an unreachable terminal.
  case "$context" in
    superset)
      response="$(megabrain_superset terminals read --workspace "$workspace_id" --terminal "$terminal_id" --json 2>/dev/null)" || {
        megabrain_error "Superset terminal $terminal_id could not be read immediately after creation"
        return 1
      }
      ;;
    orca)
      response="$(orca terminal read --terminal "$terminal_id" --json 2>/dev/null)" || {
        megabrain_error "orca terminal $terminal_id could not be read immediately after creation"
        return 1
      }
      ;;
    *)
      megabrain_error "unsupported host terminal context: $context"
      return 1
      ;;
  esac
  printf '%s' "$response" | jq -e . >/dev/null 2>&1 || {
    megabrain_error "$context terminal $terminal_id returned invalid read-back data"
    return 1
  }
}

megabrain_superset_wait_for_terminal_ready() {
  local workspace_id="$1" terminal_id="$2" timeout_ms="${MEGABRAIN_AGENT_READY_TIMEOUT_MS:-10000}"
  local attempts=$(( (timeout_ms + 99) / 100 )) attempt output rendered previous=""
  [ "$attempts" -gt 0 ] || attempts=1
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    output="$(megabrain_superset terminals read --workspace "$workspace_id" --terminal "$terminal_id" --json 2>/dev/null || true)"
    rendered="$(printf '%s' "$output" | jq -r '
      if type == "string" then .
      elif type == "object" then (.text // .output // .content // .result.text // .result.output // tostring)
      else tostring
      end
    ' 2>/dev/null || true)"
    if [ -n "$(printf '%s' "$rendered" | tr -d '[:space:]')" ] && [ "$rendered" = "$previous" ]; then
      return 0
    fi
    previous="$rendered"
    sleep 0.1
  done
  megabrain_error "Superset terminal $terminal_id did not settle within ${timeout_ms}ms"
  return 1
}

megabrain_spawn_mark_prompt_published() {
  megabrain_dispatch_meta_update_prompt_layers "$1" published pending pending awaiting-transport __clear__
}

megabrain_spawn_publish_prompt() {
  local dispatch_id="$1" text="$2"
  if ! megabrain_dispatch_message_append "$dispatch_id" parent prompt "$text" "$MEGABRAIN_SESSION_ID" >/dev/null; then
    megabrain_dispatch_meta_update_prompt_layers "$dispatch_id" not-published pending pending failed publication-failed >/dev/null 2>&1 || true
    return 1
  fi
  megabrain_spawn_mark_prompt_published "$dispatch_id"
}

megabrain_spawn_mark_prompt_transported() {
  megabrain_dispatch_meta_update_prompt_layers "$1" __keep__ transported __keep__ awaiting-receipt __keep__
}

megabrain_spawn_mark_prompt_awaiting_receipt() {
  megabrain_dispatch_meta_update_prompt_layers "$1" __keep__ __keep__ __keep__ awaiting-receipt __keep__
}

megabrain_spawn_mark_prompt_delivered() {
  megabrain_dispatch_meta_update_prompt "$1" true delivered
}

megabrain_spawn_mark_prompt_failed() {
  local dispatch_id="$1" reason="$2"
  megabrain_dispatch_meta_update_prompt_layers "$dispatch_id" __keep__ __keep__ __keep__ failed "$reason" >/dev/null 2>&1 || true
  megabrain_dispatch_meta_update_prompt "$dispatch_id" false not-delivered "$reason" >/dev/null 2>&1 || true
  megabrain_dispatch_meta_update_state "$dispatch_id" failed >/dev/null 2>&1 || true
  megabrain_dispatch_meta_update_process_state "$dispatch_id" failed >/dev/null 2>&1 || true
  megabrain_dispatch_meta_update_fields "$dispatch_id" __keep__ __keep__ __keep__ prompt-delivery "$reason" __keep__ __keep__ __keep__ >/dev/null 2>&1 || true
}

megabrain_dispatch_send_prompt_with_receipt() {
  local dispatch_id="$1" text="$2" attempt meta attempts runtime tmux_pane receipt_status transport_state
  attempts="${MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS:-3}"
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || {
    megabrain_error "prompt receipt attempts is invalid: $attempts"
    return 1
  }
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
    runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
    if [ "$runtime" = tmux ]; then
      tmux_pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
      [ -n "$tmux_pane" ] || { megabrain_error "tmux dispatch metadata has no pane: $dispatch_id"; return 1; }
      if [ "$attempt" -gt 1 ]; then
        megabrain_tmux_retry_prompt "$tmux_pane" || return 1
      else
        if ! megabrain_tmux_send_agent "$tmux_pane" "$text" prompt; then
          transport_state="$(megabrain_dispatch_meta_read "$dispatch_id" | jq -r '.promptTransport // "pending"')"
          [ "$transport_state" = transported ] || megabrain_dispatch_meta_update_prompt_layers "$dispatch_id" __keep__ not-transported __keep__ __keep__ __keep__ || return 1
          return 1
        fi
      fi
    else
      if ! megabrain_dispatch_native_send "$meta" "$text"; then
        transport_state="$(megabrain_dispatch_meta_read "$dispatch_id" | jq -r '.promptTransport // "pending"')"
        [ "$transport_state" = transported ] || megabrain_dispatch_meta_update_prompt_layers "$dispatch_id" __keep__ not-transported __keep__ __keep__ __keep__ || return 1
        return 1
      fi
    fi
    megabrain_spawn_mark_prompt_transported "$dispatch_id" || return 1
    megabrain_dispatch_wait_for_prompt_receipt "$dispatch_id"
    receipt_status=$?
    [ "$receipt_status" -eq 0 ] && return 0
    [ "$receipt_status" -eq "$MEGABRAIN_PROMPT_RECEIPT_WAITING_STATUS" ] && continue
    return "$receipt_status"
  done
  return "$MEGABRAIN_PROMPT_RECEIPT_WAITING_STATUS"
}

megabrain_spawn_mark_running_if_spawning() {
  local dispatch_id="$1" state
  state="$(megabrain_dispatch_meta_read "$dispatch_id" | jq -r '.state // empty')" || return 1
  if megabrain_dispatch_mark_running_noop "$state"; then
    return 0
  fi
  if ! megabrain_dispatch_require_transition dispatch "$state" running; then
    megabrain_error "dispatch $dispatch_id cannot become running from state $state"
    return 1
  fi
  megabrain_dispatch_meta_update_state "$dispatch_id" running
}

megabrain_launch_agent() {
  local worktree_path="$1" workspace_id="$2" agent="$3" model="$4" effort="$5" prompt="$6" label="${7:-}" browser="${8:-false}"
  local context="" command_text="" response="" session_id="" final_prompt="" dispatch_preamble="" browser_notice="" parent_id="" parent_host="" child_host="" branch="" meta=""
  local parent_tmux_session="" parent_tmux_pane="" parent_workspace_id="${SUPERSET_WORKSPACE_ID:-}"
  local agent_used="" model_honored=false substitution_report="" dispatch_id="" runtime="" tmux_session="" tmux_pane="" existing_session="" tmux_command="" host_terminal_created=false prompt_status=0
  local -a passthrough_args=() launch_args=()
  shift 7
  if [ "${1:-}" = true ]; then
    browser=true
    shift
  elif [ "${1:-}" = false ]; then
    shift
  fi
  [ "$#" -eq 0 ] || passthrough_args=("$@")
  MEGABRAIN_LAST_DISPATCH=""
  megabrain_session_id >/dev/null
  parent_id="$MEGABRAIN_SESSION_ID"
  parent_host="$MEGABRAIN_SESSION_HOST"
  if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    parent_tmux_session="$(megabrain_dispatch_tmux_caller_session 2>/dev/null || true)"
    parent_tmux_pane="$TMUX_PANE"
  fi
  [ -n "$parent_id" ] || { megabrain_error "cannot spawn a managed dispatch from an unmanaged shell"; return 1; }
  if [ -z "${MEGABRAIN_SPAWN_RUNTIME:-}" ] || [ -z "${MEGABRAIN_SPAWN_CONTEXT:-}" ] || [ "$MEGABRAIN_SPAWN_CONTEXT" != "$parent_host" ]; then
    megabrain_resolve_spawn_runtime auto || return 1
  fi
  runtime="$MEGABRAIN_SPAWN_RUNTIME"
  context="$MEGABRAIN_SPAWN_CONTEXT"
  MEGABRAIN_LAST_RUNTIME="$runtime"
  if [ "$runtime" = tmux ]; then
    MEGABRAIN_LAST_SPAWN_RUNTIME=tmux
  else
    MEGABRAIN_LAST_SPAWN_RUNTIME=ide
  fi
  agent_used="$agent"
  branch="$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
  [ -n "$label" ] || label="$(megabrain_dispatch_default_label)"
  case "$label" in
    *$'\n'*) megabrain_error "dispatch label cannot contain a newline"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
  browser_notice="$(megabrain_dispatch_browser_notice "$browser")" || return 1
  dispatch_preamble="$(megabrain_dispatch_preamble "$worktree_path")" || return 1
  final_prompt="[megabrain dispatch: ${label}]

${browser_notice}

${dispatch_preamble}

${prompt}"
  if [ "$runtime" = tmux ]; then
    megabrain_validate_prompt_budget "$final_prompt" tmux prompt || return 1
  else
    megabrain_validate_prompt_budget "$final_prompt" argv prompt || return 1
  fi
  if [ "$runtime" = tmux ]; then
    dispatch_id="$(megabrain_dispatch_new_id)" || return 1
    if [ "$context" = superset ]; then
      megabrain_superset_available || { megabrain_error "superset CLI is not available"; return 1; }
    elif [ "$context" = orca ]; then
      megabrain_require_command orca || { megabrain_error "orca CLI is not available"; return 1; }
    elif [ "$context" != tmux ]; then
      megabrain_error "cannot launch agent from unknown orchestration host"
      return 1
    fi
    megabrain_tmux_existing_session_for_worktree "$worktree_path" || true
    existing_session="${MEGABRAIN_TMUX_EXISTING_SESSION:-}"
    if [ -z "$existing_session" ] && [ "$context" = tmux ]; then
      existing_session="$parent_tmux_session"
    fi
    if [ -n "$existing_session" ]; then
      tmux_session="$existing_session"
      session_id="$(megabrain_tmux_host_terminal_for_session "$tmux_session" 2>/dev/null || true)"
      [ -n "$session_id" ] || session_id="$parent_id"
      [ -n "$session_id" ] || session_id="unknown-host-terminal"
      tmux_pane="$(megabrain_tmux_split_pane "$tmux_session" "$worktree_path")" || {
        megabrain_error "could not split tmux session $tmux_session"
        return 1
      }
    else
      tmux_session="megabrain-$dispatch_id"
      # Start a shell first so terminal-identification replies cannot leak into the agent composer.
      tmux_command="tmux new-session -A -s $(printf '%q' "$tmux_session")"
      if [ "$context" = orca ]; then
        response="$(orca terminal create --worktree "path:$worktree_path" --title "$agent $worktree_path" --command "$tmux_command" --json)" || return 1
        host_terminal_created=true
        session_id="$(printf '%s' "$response" | jq -r '.result.terminal.handle // .terminal.handle // .handle // empty' 2>/dev/null)"
      else
        response="$(megabrain_superset terminals create --workspace "$workspace_id" --command "$tmux_command" --json)" || return 1
        host_terminal_created=true
        session_id="$(printf '%s' "$response" | jq -r '.terminalId // .sessionId // .result.terminalId // .result.sessionId // .terminal.sessionId // .result.terminal.sessionId // .terminal.id // .result.terminal.id // .id // empty' 2>/dev/null)"
      fi
      if [ -z "$session_id" ]; then
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "" "$tmux_session" "" "$host_terminal_created"
        megabrain_error "$context terminal create returned no terminal identity; raw response: $response"
        return 1
      fi
      megabrain_tmux_wait_for_session "$tmux_session" || {
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "" "$host_terminal_created"
        megabrain_error "tmux session $tmux_session did not become available"
        return 1
      }
      megabrain_tmux_set_state_dir "$tmux_session" || {
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "" "$host_terminal_created"
        megabrain_error "could not scope tmux child session $tmux_session to $MEGABRAIN_STATE_DIR"
        return 1
      }
      tmux_pane="$(megabrain_tmux_first_pane "$tmux_session")"
    fi
    if [ -z "$tmux_pane" ]; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "" "$host_terminal_created"
      megabrain_error "tmux session $tmux_session has no pane"
      return 1
    fi
    megabrain_tmux_apply_config "$tmux_session" || {
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_error "could not apply megabrain tmux configuration to $tmux_session"
      return 1
    }
    if [ "${#passthrough_args[@]}" -gt 0 ]; then
      command_text="$(megabrain_agent_command "$agent_used" "$model" "$effort" "$browser" "${passthrough_args[@]}")" || {
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
        return 1
      }
    else
      command_text="$(megabrain_agent_command "$agent_used" "$model" "$effort" "$browser")" || {
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
        return 1
      }
    fi
    command_text="cd $(printf '%q' "$worktree_path") && MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_id") MEGABRAIN_TMUX_SESSION=$(printf '%q' "$tmux_session") MEGABRAIN_TMUX_PANE=$(printf '%q' "$tmux_pane") $command_text"
    megabrain_dispatch_meta_write "$dispatch_id" "$parent_id" "$parent_host" "$context" "$workspace_id" "$session_id" "$worktree_path" "$branch" "$agent" "$label" spawning "$model" true "$agent_used" "$tmux_session" "$tmux_pane" tmux tmux "$parent_tmux_session" "$parent_tmux_pane" "$parent_workspace_id" "${MEGABRAIN_CHAIN_NAME:-}" "${MEGABRAIN_CHAIN_STEP:-}" "${MEGABRAIN_CHAIN_TOTAL:-}" "${MEGABRAIN_CHAIN_REASON:-}" "${MEGABRAIN_CHAIN_DEFAULT:-false}" "$effort" >/dev/null || {
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_error "could not persist dispatch metadata: $dispatch_id"
      return 1
    }
    if ! megabrain_dispatch_start_transcript "$dispatch_id" "$tmux_pane"; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" transcript-start-failed
      megabrain_error "could not start transcript for dispatch $dispatch_id"
      return 1
    fi
    if ! megabrain_spawn_publish_prompt "$dispatch_id" "$final_prompt"; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-publication-failed
      megabrain_dispatch_failure_error "$dispatch_id" "could not publish prompt for dispatch $dispatch_id"
      return 1
    fi
    if ! megabrain_tmux_send_agent "$tmux_pane" "$command_text"; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" command-not-submitted
      return 1
    fi
    substitution_report="$(megabrain_tmux_model_substitution_report "$tmux_pane" 2>/dev/null || true)"
    if [ -n "$substitution_report" ]; then
      megabrain_dispatch_meta_update_model_substitution "$dispatch_id" "$substitution_report" || {
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
        megabrain_spawn_mark_prompt_failed "$dispatch_id" model-substitution-record-failed
        return 1
      }
      megabrain_error "agent reported model substitution: $substitution_report"
    fi
    if ! megabrain_tmux_agent_output_clean "$tmux_pane"; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" readiness-output-invalid
      megabrain_dispatch_failure_error "$dispatch_id" "agent output contains terminal-identification escape leakage in pane $tmux_pane"
      return 1
    fi
    megabrain_dispatch_send_prompt_with_receipt "$dispatch_id" "$final_prompt"
    prompt_status=$?
    if [ "$prompt_status" -eq "$MEGABRAIN_PROMPT_RECEIPT_WAITING_STATUS" ]; then
      megabrain_spawn_mark_prompt_awaiting_receipt "$dispatch_id" || {
        megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
        megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-state-persist-failed
        return 1
      }
      MEGABRAIN_LAST_DISPATCH="$dispatch_id"
      megabrain_notice "dispatch $dispatch_id prompt awaiting receipt; run megabrain orchestrate reconcile $dispatch_id"
      printf '%s\n' "$response"
      return 0
    elif [ "$prompt_status" -ne 0 ]; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-transport-failed
      megabrain_dispatch_failure_error "$dispatch_id" "prompt transport failed for dispatch $dispatch_id"
      return 1
    fi
    if ! megabrain_spawn_mark_prompt_delivered "$dispatch_id"; then
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-confirmation-failed
      return 1
    fi
    megabrain_spawn_mark_running_if_spawning "$dispatch_id" || {
      megabrain_tmux_cleanup_launch "$context" "$workspace_id" "$session_id" "$tmux_session" "$tmux_pane" "$host_terminal_created"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" state-persist-failed
      megabrain_dispatch_failure_error "$dispatch_id" "could not persist tmux dispatch state: $dispatch_id"
      return 1
    }
    MEGABRAIN_LAST_DISPATCH="$dispatch_id"
    printf '%s\n' "$response"
    return 0
  fi
  if [ "${#passthrough_args[@]}" -gt 0 ]; then
    command_text="$(megabrain_agent_command "$agent" "$model" "$effort" "$browser" "${passthrough_args[@]}")" || {
      megabrain_error "could not build $agent launch command"
      return 1
    }
  else
    command_text="$(megabrain_agent_command "$agent" "$model" "$effort" "$browser")" || {
      megabrain_error "could not build $agent launch command"
      return 1
    }
  fi
  dispatch_id="$(megabrain_dispatch_new_id)" || return 1
  case "$context" in
    orca)
      megabrain_require_command orca || { megabrain_error "orca CLI is not available"; return 1; }
      response="$(orca terminal create --worktree "path:$worktree_path" --title "$agent $worktree_path" --json)" || {
        megabrain_error "orca terminal create failed for $worktree_path"
        return 1
      }
      session_id="$(printf '%s' "$response" | jq -r '.result.terminal.handle // .terminal.handle // .handle // empty' 2>/dev/null)"
      child_host=orca
      ;;
    superset)
      megabrain_superset_available || { megabrain_error "superset CLI is not available"; return 1; }
      response="$(megabrain_superset terminals create --workspace "$workspace_id" --json)" || {
        megabrain_error "Superset terminals create failed for workspace $workspace_id"
        return 1
      }
      session_id="$(printf '%s' "$response" | jq -r '.terminalId // .sessionId // .result.terminalId // .result.sessionId // .terminal.sessionId // .result.terminal.sessionId // .terminal.id // .result.terminal.id // .id // empty' 2>/dev/null)"
      [ -n "$session_id" ] || { megabrain_error "Superset terminals create returned no terminal identity"; return 1; }
      child_host=superset
      ;;
    *)
      megabrain_error "cannot launch agent from unknown orchestration host"
      return 1
      ;;
  esac
  [ -n "$session_id" ] || { megabrain_error "agent launch returned no terminal identity"; return 1; }
  if ! megabrain_host_terminal_readback "$context" "$workspace_id" "$session_id"; then
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    return 1
  fi
  model_honored=true
  megabrain_dispatch_meta_write "$dispatch_id" "$parent_id" "$parent_host" "$child_host" "$workspace_id" "$session_id" "$worktree_path" "$branch" "$agent" "$label" spawning "$model" "$model_honored" "$agent_used" "" "" host ide "$parent_tmux_session" "$parent_tmux_pane" "$parent_workspace_id" "${MEGABRAIN_CHAIN_NAME:-}" "${MEGABRAIN_CHAIN_STEP:-}" "${MEGABRAIN_CHAIN_TOTAL:-}" "${MEGABRAIN_CHAIN_REASON:-}" "${MEGABRAIN_CHAIN_DEFAULT:-false}" "$effort" >/dev/null || {
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_error "could not persist dispatch metadata: $dispatch_id"
    return 1
  }
  if ! megabrain_spawn_publish_prompt "$dispatch_id" "$final_prompt"; then
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-publication-failed
    megabrain_dispatch_failure_error "$dispatch_id" "could not publish prompt for dispatch $dispatch_id"
    return 1
  fi
  if [ "$child_host" = orca ]; then
    command_text="cd $(printf '%q' "$worktree_path") && env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR=$(printf '%q' "$MEGABRAIN_STATE_DIR") ORCA_TERMINAL_HANDLE=$(printf '%q' "$session_id") MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_id") $command_text"
  else
    command_text="cd $(printf '%q' "$worktree_path") && env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR=$(printf '%q' "$MEGABRAIN_STATE_DIR") SUPERSET_TERMINAL_ID=$(printf '%q' "$session_id") MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_id") $command_text"
  fi
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || {
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_spawn_mark_prompt_failed "$dispatch_id" metadata-read-failed
    megabrain_dispatch_failure_error "$dispatch_id" "could not read dispatch metadata: $dispatch_id"
    return 1
  }
  if ! megabrain_dispatch_native_send "$meta" "$command_text"; then
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_spawn_mark_prompt_failed "$dispatch_id" command-not-submitted
    megabrain_dispatch_failure_error "$dispatch_id" "could not start agent in $child_host terminal $session_id"
    return 1
  fi
  if [ "$child_host" = orca ]; then
    if ! orca terminal wait --terminal "$session_id" --for tui-idle --timeout-ms "$MEGABRAIN_AGENT_READY_TIMEOUT_MS" >/dev/null; then
      megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" readiness-timeout
      megabrain_dispatch_failure_error "$dispatch_id" "orca terminal $session_id did not become ready within ${MEGABRAIN_AGENT_READY_TIMEOUT_MS}ms"
      return 1
    fi
  elif ! megabrain_superset_wait_for_terminal_ready "$workspace_id" "$session_id"; then
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_spawn_mark_prompt_failed "$dispatch_id" readiness-timeout
    megabrain_dispatch_failure_error "$dispatch_id" "Superset terminal $session_id did not become ready"
    return 1
  fi
  meta="$(megabrain_dispatch_meta_read "$dispatch_id")" || return 1
  megabrain_dispatch_send_prompt_with_receipt "$dispatch_id" "$final_prompt"
  prompt_status=$?
  if [ "$prompt_status" -eq "$MEGABRAIN_PROMPT_RECEIPT_WAITING_STATUS" ]; then
    megabrain_spawn_mark_prompt_awaiting_receipt "$dispatch_id" || {
      megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
      megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-state-persist-failed
      return 1
    }
    MEGABRAIN_LAST_DISPATCH="$dispatch_id"
    printf '%s\n' "$response"
    return 0
  elif [ "$prompt_status" -ne 0 ]; then
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-transport-failed
    megabrain_dispatch_failure_error "$dispatch_id" "prompt transport failed for dispatch $dispatch_id"
    return 1
  fi
  if ! megabrain_spawn_mark_prompt_delivered "$dispatch_id"; then
    megabrain_host_cleanup_launch "$context" "$workspace_id" "$session_id"
    megabrain_spawn_mark_prompt_failed "$dispatch_id" prompt-confirmation-failed
    megabrain_dispatch_failure_error "$dispatch_id" "could not record prompt delivery for dispatch $dispatch_id"
    return 1
  fi
  megabrain_spawn_mark_running_if_spawning "$dispatch_id" || {
    megabrain_spawn_mark_prompt_failed "$dispatch_id" state-persist-failed
    megabrain_dispatch_failure_error "$dispatch_id" "could not persist host dispatch state: $session_id"
    return 1
  }
  MEGABRAIN_LAST_DISPATCH="$dispatch_id"
  printf '%s\n' "$response"
  return 0
}

megabrain_terminal_record_path() {
  local terminal_id="$1"
  case "$terminal_id" in
    ''|.|..|*'/'*|*$'\n'*) return 1 ;;
  esac
  printf '%s/%s.json\n' "$MEGABRAIN_TERMINAL_DIR" "$terminal_id"
}

megabrain_terminal_json_number() {
  local response="$1" expression="$2" value
  value="$(printf '%s' "$response" | jq -r "$expression // empty" 2>/dev/null || true)"
  case "$value" in
    ''|*[!0-9]*) printf 'null\n' ;;
    *) printf '%s\n' "$value" ;;
  esac
}

megabrain_terminal_id_from_response() {
  printf '%s' "$1" | jq -r '
    .terminalId // .sessionId // .result.terminalId // .result.sessionId //
    .terminal.handle // .result.terminal.handle // .handle // .result.handle //
    .terminal.sessionId // .result.terminalSessionId // .terminal.id //
    .result.terminal.id // .id // empty
  ' 2>/dev/null
}

megabrain_terminal_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

megabrain_terminal_identity_token() {
  local token
  token="$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')"
  [ -n "$token" ] || token="$(date -u '+%s')-$$"
  printf '%s\n' "$token"
}

megabrain_terminal_identity_wrap_command() {
  local command_text="$1" token="$2" quoted_command
  quoted_command="$(megabrain_terminal_shell_quote "$command_text")"
  printf "printf 'MEGABRAIN_TERMINAL_PID_%s=%%s\\n' \"\$\$\"; exec sh -c %s\n" "$token" "$quoted_command"
}

megabrain_terminal_pid_from_marker() {
  local response="$1" marker="$2" pid
  pid="$(printf '%s' "$response" | jq -r '.. | strings' 2>/dev/null | sed -n "s/.*${marker}=\([0-9][0-9]*\).*/\1/p" | head -n 1)"
  case "$pid" in
    ''|0|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$pid" ;;
  esac
}

megabrain_terminal_identity_from_host() {
  local host="$1" workspace_id="$2" terminal_id="$3" marker="$4"
  local timeout_ms="${MEGABRAIN_TERMINAL_IDENTITY_TIMEOUT_MS:-10000}" attempts attempt response pid
  case "$timeout_ms" in
    ''|*[!0-9]*) timeout_ms=10000 ;;
  esac
  attempts=$(( (timeout_ms + 99) / 100 ))
  [ "$attempts" -gt 0 ] || attempts=1
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    case "$host" in
      superset) response="$(megabrain_superset terminals read --workspace "$workspace_id" --terminal "$terminal_id" --json 2>/dev/null || true)" ;;
      orca) response="$(orca terminal read --terminal "$terminal_id" --json 2>/dev/null || true)" ;;
      *) response='' ;;
    esac
    pid="$(megabrain_terminal_pid_from_marker "$response" "$marker" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      printf '%s\n' "$pid"
      return 0
    fi
    [ "$attempt" -lt "$attempts" ] && sleep 0.1
  done
  return 1
}

megabrain_terminal_record_write() {
  local terminal_id="$1" host="$2" workspace_id="$3" worktree_path="$4" title="$5"
  local command_text="$6" created_at="$7" pid_json="$8" port_json="$9" root_pid_json="${10:-$8}"
  local path tmp
  path="$(megabrain_terminal_record_path "$terminal_id")" || return 1
  mkdir -p "$MEGABRAIN_TERMINAL_DIR" || return 1
  tmp="$(mktemp "$MEGABRAIN_TERMINAL_DIR/.terminal.XXXXXX")" || return 1
  if ! jq -n \
    --arg terminalId "$terminal_id" --arg host "$host" --arg workspaceId "$workspace_id" \
    --arg worktree "$worktree_path" --arg title "$title" --arg command "$command_text" \
    --arg createdAt "$created_at" --argjson pid "$pid_json" --argjson port "$port_json" \
    --argjson rootPid "$root_pid_json" \
    '{terminalId: $terminalId, host: $host, workspaceId: (if $workspaceId == "" then null else $workspaceId end), worktree: $worktree, title: (if $title == "" then null else $title end), command: $command, createdAt: $createdAt, pid: $pid, rootPid: $rootPid, port: $port, status: "active"}' \
    >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_terminal_create() {
  local worktree_selector="" command_text="" title="" port="" json=false arg worktree_path host workspace_id response
  local terminal_id pid_json port_json root_pid_json identity_token marker launch_command
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --worktree) worktree_selector="${2:-}"; shift 2 ;;
      --command) command_text="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help)
        megabrain_usage_show terminal-create
        printf 'Without --command, use the worktree .superset/config.json run script.\n'
        printf 'Superset tabs are not titled; only Orca tabs are.\n'
        return 0
        ;;
      *) megabrain_error "unknown terminal create option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  if [ -n "$port" ]; then
    case "$port" in
      ''|*[!0-9]*) megabrain_error 'terminal create port must be numeric'; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
    [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || {
      megabrain_error 'terminal create port must be between 1 and 65535'
      return "$MEGABRAIN_USAGE_ERROR"
    }
  fi
  if [ -n "$worktree_selector" ]; then
    if [ -d "$worktree_selector" ]; then
      worktree_path="$(git -C "$worktree_selector" rev-parse --show-toplevel 2>/dev/null || true)"
    else
      megabrain_error "worktree path is not a Git directory: $worktree_selector"
      return 1
    fi
  else
    worktree_path="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  [ -n "$worktree_path" ] || { megabrain_error "could not resolve a Git worktree from ${worktree_selector:-$PWD}"; return 1; }
  if [ -z "$command_text" ]; then
    command_text="$(megabrain_project_run_command "$worktree_path" || true)"
    [ -n "$command_text" ] || {
      megabrain_error "no --command given and no .superset/config.json run script found in $worktree_path"
      return "$MEGABRAIN_USAGE_ERROR"
    }
  fi
  command_text="$(megabrain_terminal_command_with_agent_permissions "$command_text")"
  identity_token="$(megabrain_terminal_identity_token)"
  marker="MEGABRAIN_TERMINAL_PID_${identity_token}"
  launch_command="$(megabrain_terminal_identity_wrap_command "$command_text" "$identity_token")"
  host="$(megabrain_context_detect)"
  case "$host" in
    orca)
      megabrain_require_command orca || { megabrain_error "orca CLI is not available"; return 1; }
      if [ -n "$title" ]; then
        response="$(orca terminal create --worktree "path:$worktree_path" --title "$title" --command "$launch_command" --json)" || return 1
      else
        response="$(orca terminal create --worktree "path:$worktree_path" --command "$launch_command" --json)" || return 1
      fi
      ;;
    superset)
      megabrain_superset_available || { megabrain_error "superset CLI is not available"; return 1; }
      workspace_id="$(megabrain_workspace_id_for_target "$worktree_path")"
      if [ -z "$workspace_id" ]; then
        megabrain_error "no Superset workspace is registered for $worktree_path; run megabrain worktree adopt $worktree_path first"
        return 1
      fi
      response="$(megabrain_superset terminals create --workspace "$workspace_id" --command "$launch_command" --json)" || return 1
      ;;
    *)
      megabrain_error "cannot create terminal from unknown orchestration host"
      return 1
      ;;
  esac
  terminal_id="$(megabrain_terminal_id_from_response "$response")"
  [ -n "$terminal_id" ] || { megabrain_error "$host terminal create returned no terminal identity"; return 1; }
  pid_json="$(megabrain_terminal_json_number "$response" '.pid // .processId // .terminal.pid // .result.terminal.pid // .result.pid // .process.pid')"
  [ "$pid_json" = 0 ] && pid_json=null
  port_json="$(megabrain_terminal_json_number "$response" '.port // .terminal.port // .result.terminal.port // .result.port')"
  [ -n "$port" ] && port_json="$port"
  root_pid_json="$(megabrain_terminal_json_number "$response" '.rootPid // .processRootPid // .terminal.rootPid // .result.terminal.rootPid // .result.rootPid')"
  [ "$root_pid_json" = 0 ] && root_pid_json=null
  if [ "$pid_json" = null ]; then
    pid_json="$(megabrain_terminal_identity_from_host "$host" "$workspace_id" "$terminal_id" "$marker" 2>/dev/null || true)"
    if [ -z "$pid_json" ]; then
      megabrain_terminal_host_close "$host" "$workspace_id" "$terminal_id" >/dev/null 2>&1 || true
      megabrain_error "$host terminal create did not publish a process identity"
      return 1
    fi
  fi
  [ "$root_pid_json" = null ] && root_pid_json="$pid_json"
  megabrain_terminal_record_write "$terminal_id" "$host" "$workspace_id" "$worktree_path" "$title" \
    "$command_text" "$(megabrain_iso_now)" "$pid_json" "$port_json" "$root_pid_json" || {
    megabrain_terminal_host_close "$host" "$workspace_id" "$terminal_id" >/dev/null 2>&1 || true
    megabrain_error "could not persist terminal identity: $terminal_id"
    return 1
  }
  if [ "$json" = true ]; then
    jq -n --arg host "$host" --arg worktree "$worktree_path" --arg title "$title" \
      --arg terminalId "$terminal_id" --argjson pid "$pid_json" --argjson rootPid "$root_pid_json" --argjson port "$port_json" \
      '{host: $host, worktree: $worktree, title: (if $title|length > 0 then $title else null end), terminalId: $terminalId, pid: $pid, rootPid: $rootPid, port: $port}'
  else
    printf '%s\n' "$response"
  fi
}

megabrain_terminal_host_records() {
  local host="$1" workspace_id="$2"
  case "$host" in
    orca)
      megabrain_require_command orca || return 1
      orca terminal list --json 2>/dev/null
      ;;
    superset)
      [ -n "$workspace_id" ] || return 1
      megabrain_superset_available || return 1
      megabrain_superset terminals list --workspace "$workspace_id" --json 2>/dev/null
      ;;
    *) return 1 ;;
  esac
}

megabrain_terminal_host_has_id() {
  local records="$1" terminal_id="$2"
  printf '%s' "$records" | jq -e --arg id "$terminal_id" '
    def records: if type == "array" then . else (.result.terminals // .terminals // .sessions // .result.sessions // []) end;
    any(records[]?; (.terminalId // .handle // .terminalHandle // .sessionId // .id // "") == $id)
  ' >/dev/null 2>&1
}

megabrain_terminal_host_entry() {
  local records="$1" terminal_id="$2"
  printf '%s' "$records" | jq -c --arg id "$terminal_id" '
    def records: if type == "array" then . else (.result.terminals // .terminals // .sessions // .result.sessions // []) end;
    first(records[]? | select((.terminalId // .handle // .terminalHandle // .sessionId // .id // "") == $id)) // empty
  ' 2>/dev/null
}

megabrain_terminal_host_process_status() {
  local records="$1" terminal_id="$2" record="$3" entry exited host_pid port listener_pid
  entry="$(megabrain_terminal_host_entry "$records" "$terminal_id")"
  [ -n "$entry" ] || { printf 'unknown\n'; return 0; }
  exited="$(printf '%s' "$entry" | jq -r 'if has("exited") then .exited else empty end' 2>/dev/null || true)"
  case "$exited" in
    true) printf 'dead\n'; return 0 ;;
    false) printf 'alive\n'; return 0 ;;
  esac
  case "$(printf '%s' "$entry" | jq -r '.status // .state // empty' 2>/dev/null || true)" in
    exited|dead|stopped|terminated) printf 'dead\n'; return 0 ;;
    active|alive|running) printf 'alive\n'; return 0 ;;
  esac
  host_pid="$(printf '%s' "$record" | jq -r '.rootPid // .pid // empty' 2>/dev/null || true)"
  case "$host_pid" in
    ''|0|*[!0-9]*) host_pid='' ;;
  esac
  if [ -n "$host_pid" ]; then
    if kill -0 "$host_pid" >/dev/null 2>&1; then
      printf 'alive\n'
    else
      printf 'dead\n'
    fi
    return 0
  fi
  port="$(printf '%s' "$record" | jq -r '.port // empty' 2>/dev/null || true)"
  case "$port" in
    ''|*[!0-9]*) port='' ;;
  esac
  if [ -n "$port" ]; then
    listener_pid="$(megabrain_terminal_listener_pid "$port")"
    if [ -n "$listener_pid" ]; then
      printf 'alive\n'
    else
      printf 'dead\n'
    fi
    return 0
  fi
  printf 'unknown\n'
}

megabrain_terminal_host_close() {
  local host="$1" workspace_id="$2" terminal_id="$3"
  case "$host" in
    superset)
      megabrain_superset terminals close --workspace "$workspace_id" --terminal "$terminal_id" --json
      ;;
    orca)
      orca terminal close --terminal "$terminal_id" --json
      ;;
    *)
      megabrain_error "unsupported host terminal context: $host"
      return 1
      ;;
  esac
}

megabrain_terminal_list() {
  local worktree_selector="" worktree_filter="" json=false arg path record records status host workspace_id
  local output='[]' entry
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --worktree) worktree_selector="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show terminal-list; return 0 ;;
      *) megabrain_error "unknown terminal list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  if [ -n "$worktree_selector" ]; then
    if [ -d "$worktree_selector" ]; then
      worktree_filter="$(git -C "$worktree_selector" rev-parse --show-toplevel 2>/dev/null || true)"
    else
      megabrain_error "worktree path is not a Git directory: $worktree_selector"
      return 1
    fi
    [ -n "$worktree_filter" ] || { megabrain_error "could not resolve Git worktree: $worktree_selector"; return 1; }
  fi
  for path in "$MEGABRAIN_TERMINAL_DIR"/*.json; do
    [ -f "$path" ] || continue
    record="$(cat "$path" 2>/dev/null || true)"
    printf '%s' "$record" | jq -e . >/dev/null 2>&1 || continue
    [ -z "$worktree_filter" ] || [ "$(printf '%s' "$record" | jq -r '.worktree // empty')" = "$worktree_filter" ] || continue
    host="$(printf '%s' "$record" | jq -r '.host // empty')"
    workspace_id="$(printf '%s' "$record" | jq -r '.workspaceId // empty')"
    status=unknown
    records="$(megabrain_terminal_host_records "$host" "$workspace_id" 2>/dev/null || true)"
    if printf '%s' "$records" | jq -e . >/dev/null 2>&1; then
      if megabrain_terminal_host_has_id "$records" "$(printf '%s' "$record" | jq -r '.terminalId')"; then
        status="$(megabrain_terminal_host_process_status "$records" "$(printf '%s' "$record" | jq -r '.terminalId')" "$record")"
      else
        status=stale
      fi
    fi
    entry="$(printf '%s' "$record" | jq --arg status "$status" '.status = $status')"
    output="$(printf '%s' "$output" | jq --argjson item "$entry" '. + [$item]')"
  done
  if [ "$json" = true ]; then
    printf '%s\n' "$output"
  else
    printf '%s\n' "$output" | jq -r '.[] | [.terminalId, .status, .host, .worktree, (.title // "-"), .command, .createdAt, (.pid // "-"), (.port // "-")] | @tsv' |
      while IFS=$'\t' read -r terminal_id status host worktree title command_text created_at pid port; do
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$terminal_id" "$status" "$host" "$worktree" "$title" "$command_text" "$created_at" "$pid" "$port"
      done
  fi
}

megabrain_terminal_listener_pid() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

megabrain_terminal_process_parent() {
  local pid="$1" parent
  parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  case "$parent" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$parent" ;;
  esac
}

megabrain_terminal_process_children() {
  pgrep -P "$1" 2>/dev/null || true
}

megabrain_terminal_process_tree_belongs_to() {
  local root_pid="$1" target_pid="$2" current="$2" parent attempt
  [ "$target_pid" = "$root_pid" ] && return 0
  for ((attempt = 1; attempt <= 64; attempt++)); do
    parent="$(megabrain_terminal_process_parent "$current" 2>/dev/null || true)"
    [ -n "$parent" ] || return 1
    [ "$parent" = "$root_pid" ] && return 0
    case "$parent" in
      0|1) return 1 ;;
    esac
    current="$parent"
  done
  return 1
}

megabrain_terminal_kill_process_tree() {
  local pid="$1" children="" child=""
  children="$(megabrain_terminal_process_children "$pid")"
  # Signal the recorded root first. This is the supervisor that can respawn a listener;
  # killing only the port holder leaves the old command alive.
  kill -TERM "$pid" 2>/dev/null || return 1
  MEGABRAIN_TERMINAL_KILLED_TREE="$(printf '%s' "$MEGABRAIN_TERMINAL_KILLED_TREE" | jq --argjson pid "$pid" '. + [$pid]')"
  while IFS= read -r child; do
    [ -n "$child" ] || continue
    megabrain_terminal_kill_process_tree "$child" || return 1
  done <<EOF
$children
EOF
}

megabrain_terminal_wait_for_port() {
  local port="$1" desired="$2" timeout="$3" started now elapsed
  started="$(date +%s)"
  while :; do
    if [ "$desired" = free ]; then
      [ -z "$(megabrain_terminal_listener_pid "$port")" ] && return 0
    else
      [ -n "$(megabrain_terminal_listener_pid "$port")" ] && return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    [ "$elapsed" -ge "$timeout" ] && return 1
    sleep 0.1
  done
}

megabrain_terminal_resolve_selector() {
  local selector="$1" kind value path record match
  case "$selector" in
    id:*) kind=id; value="${selector#id:}" ;;
    title:*) kind=title; value="${selector#title:}" ;;
    port:*) kind=port; value="${selector#port:}" ;;
    worktree:*) kind=worktree; value="${selector#worktree:}" ;;
    *) return 1 ;;
  esac
  [ -n "$value" ] || return 1
  if [ "$kind" = worktree ] && [ -d "$value" ]; then
    value="$(git -C "$value" rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  for path in "$MEGABRAIN_TERMINAL_DIR"/*.json; do
    [ -f "$path" ] || continue
    record="$(cat "$path" 2>/dev/null || true)"
    printf '%s' "$record" | jq -e . >/dev/null 2>&1 || continue
    case "$kind" in
      id) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select(.terminalId == $value) | "yes"')" ;;
      title) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select((.title // "") == $value) | "yes"')" ;;
      port) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select((.port | tostring) == $value) | "yes"')" ;;
      worktree) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select(.worktree == $value) | "yes"')" ;;
    esac
    if [ "$match" = yes ]; then
      MEGABRAIN_TERMINAL_RESOLVED_PATH="$path"
      MEGABRAIN_TERMINAL_RESOLVED_RECORD="$record"
      MEGABRAIN_TERMINAL_RESOLVED_KIND="$kind"
      MEGABRAIN_TERMINAL_RESOLVED_VALUE="$value"
      return 0
    fi
  done
  return 1
}

megabrain_terminal_close() {
  local selector="" json=false arg record old_path terminal_id host workspace_id records identity terminal_status
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show terminal-close; return 0 ;;
      -*) megabrain_error "unknown terminal close option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      '') megabrain_error 'terminal close selector cannot be empty'; return "$MEGABRAIN_USAGE_ERROR" ;;
      *) [ -z "$selector" ] || { megabrain_error "unexpected terminal close argument: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }; selector="$arg"; shift ;;
    esac
  done
  [ -n "$selector" ] || { megabrain_error 'terminal close requires a selector'; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_terminal_resolve_selector "$selector" || {
    megabrain_error 'terminal selector could not be resolved'
    return 1
  }
  record="$MEGABRAIN_TERMINAL_RESOLVED_RECORD"
  old_path="$MEGABRAIN_TERMINAL_RESOLVED_PATH"
  terminal_id="$(printf '%s' "$record" | jq -r '.terminalId // empty')"
  host="$(printf '%s' "$record" | jq -r '.host // empty')"
  workspace_id="$(printf '%s' "$record" | jq -r '.workspaceId // empty')"
  records="$(megabrain_terminal_host_records "$host" "$workspace_id" 2>/dev/null || true)"
  if ! printf '%s' "$records" | jq -e . >/dev/null 2>&1; then
    megabrain_error "could not verify host terminal $terminal_id before close"
    return 1
  fi
  if ! megabrain_terminal_host_has_id "$records" "$terminal_id"; then
    rm -f "$old_path"
    if [ "$json" = true ]; then
      jq -n --arg selector "$selector" --arg terminalId "$terminal_id" \
        '{selector: $selector, terminalId: $terminalId, status: "stale", recordRemoved: true, message: "host no longer knows this terminal"}'
    else
      printf 'selector: %s\nterminal: %s\nstatus: stale\nrecord removed: true\nhost no longer knows this terminal\n' "$selector" "$terminal_id"
    fi
    return 1
  fi
  if ! megabrain_terminal_host_close "$host" "$workspace_id" "$terminal_id" >/dev/null 2>&1; then
    megabrain_error "could not close host terminal $terminal_id; record retained"
    return 1
  fi
  identity=unavailable
  if printf '%s' "$record" | jq -e '(.rootPid // .pid) | numbers | select(. > 0)' >/dev/null 2>&1; then
    identity=recorded
  fi
  if ! rm -f "$old_path"; then
    megabrain_error "host terminal $terminal_id closed but its record could not be removed"
    return 1
  fi
  terminal_status=closed
  if [ "$json" = true ]; then
    jq -n --arg selector "$selector" --arg terminalId "$terminal_id" --arg status "$terminal_status" --arg identity "$identity" \
      '{selector: $selector, terminalId: $terminalId, status: $status, identity: $identity, recordRemoved: true}'
  else
    printf 'selector: %s\nterminal: %s\nstatus: %s\nidentity: %s\nrecord removed: true\n' "$selector" "$terminal_id" "$terminal_status" "$identity"
  fi
}

megabrain_terminal_recreate() {
  local record="$1" command_override="$2" response host workspace_id worktree_path title command_text
  local terminal_id pid_json port_json root_pid_json created_at identity_token marker launch_command
  host="$(printf '%s' "$record" | jq -r '.host // empty')"
  workspace_id="$(printf '%s' "$record" | jq -r '.workspaceId // empty')"
  worktree_path="$(printf '%s' "$record" | jq -r '.worktree // empty')"
  title="$(printf '%s' "$record" | jq -r '.title // empty')"
  command_text="$command_override"
  [ -n "$command_text" ] || command_text="$(printf '%s' "$record" | jq -r '.command // empty')"
  command_text="$(megabrain_terminal_command_with_agent_permissions "$command_text")"
  identity_token="$(megabrain_terminal_identity_token)"
  marker="MEGABRAIN_TERMINAL_PID_${identity_token}"
  launch_command="$(megabrain_terminal_identity_wrap_command "$command_text" "$identity_token")"
  case "$host" in
    orca)
      megabrain_require_command orca || { megabrain_error 'orca CLI is not available'; return 1; }
      if [ -n "$title" ]; then
        response="$(orca terminal create --worktree "path:$worktree_path" --title "$title" --command "$launch_command" --json)" || return 1
      else
        response="$(orca terminal create --worktree "path:$worktree_path" --command "$launch_command" --json)" || return 1
      fi
      ;;
    superset)
      [ -n "$workspace_id" ] || { megabrain_error "terminal record has no workspace identity: $worktree_path"; return 1; }
      megabrain_superset_available || { megabrain_error 'superset CLI is not available'; return 1; }
      response="$(megabrain_superset terminals create --workspace "$workspace_id" --command "$launch_command" --json)" || return 1
      ;;
    *) megabrain_error "cannot recreate terminal from unknown host: $host"; return 1 ;;
  esac
  terminal_id="$(megabrain_terminal_id_from_response "$response")"
  [ -n "$terminal_id" ] || { megabrain_error "$host terminal recreate returned no terminal identity"; return 1; }
  pid_json="$(megabrain_terminal_json_number "$response" '.pid // .processId // .terminal.pid // .result.terminal.pid // .result.pid // .process.pid')"
  [ "$pid_json" = 0 ] && pid_json=null
  port_json="$(megabrain_terminal_json_number "$response" '.port // .terminal.port // .result.terminal.port // .result.port')"
  [ "$port_json" = null ] && port_json="$(printf '%s' "$record" | jq -r '.port // empty')"
  [ -n "$port_json" ] || port_json=null
  root_pid_json="$(megabrain_terminal_json_number "$response" '.rootPid // .processRootPid // .terminal.rootPid // .result.terminal.rootPid // .result.rootPid')"
  [ "$root_pid_json" = 0 ] && root_pid_json=null
  if [ "$pid_json" = null ]; then
    pid_json="$(megabrain_terminal_identity_from_host "$host" "$workspace_id" "$terminal_id" "$marker" 2>/dev/null || true)"
    if [ -z "$pid_json" ]; then
      megabrain_terminal_host_close "$host" "$workspace_id" "$terminal_id" >/dev/null 2>&1 || true
      megabrain_error "$host terminal recreate did not publish a process identity"
      return 1
    fi
  fi
  [ "$root_pid_json" = null ] && root_pid_json="$pid_json"
  created_at="$(megabrain_iso_now)"
  megabrain_terminal_record_write "$terminal_id" "$host" "$workspace_id" "$worktree_path" "$title" \
    "$command_text" "$created_at" "$pid_json" "$port_json" "$root_pid_json" || return 1
  MEGABRAIN_TERMINAL_RECREATED_ID="$terminal_id"
  MEGABRAIN_TERMINAL_RECREATED_PID_JSON="$pid_json"
  MEGABRAIN_TERMINAL_RECREATED_PORT_JSON="$port_json"
  MEGABRAIN_TERMINAL_RECREATED_TITLE="$title"
  MEGABRAIN_TERMINAL_RECREATED_COMMAND="$command_text"
  return 0
}

megabrain_terminal_restart() {
  local selector="" command_override="" wait_port="" timeout=30 json=false arg
  local record old_path kind value root_pid target_pid target_port waited_port reported_port
  local killed_pid_json='null' port_json='null' listening_after_ms=0 started now
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --command) command_override="${2:-}"; shift 2 ;;
      --wait-port) wait_port="${2:-}"; shift 2 ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show terminal-restart; return 0 ;;
      -*) megabrain_error "unknown terminal restart option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      '') megabrain_error 'terminal restart selector cannot be empty'; return "$MEGABRAIN_USAGE_ERROR" ;;
      *) [ -z "$selector" ] || { megabrain_error "unexpected terminal restart argument: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }; selector="$arg"; shift ;;
    esac
  done
  [ -n "$selector" ] || { megabrain_usage_fail terminal-restart; return "$MEGABRAIN_USAGE_ERROR"; }
  case "$timeout" in ''|*[!0-9]*) megabrain_error 'terminal restart timeout must be a non-negative number of seconds'; return "$MEGABRAIN_USAGE_ERROR" ;; esac
  case "$wait_port" in ''|*[!0-9]*) [ -z "$wait_port" ] || { megabrain_error 'terminal restart wait port must be numeric'; return "$MEGABRAIN_USAGE_ERROR"; } ;; esac
  if ! megabrain_terminal_resolve_selector "$selector"; then
    if [[ "$selector" == port:* ]]; then
      target_port="${selector#port:}"
      if [ -z "$(megabrain_terminal_listener_pid "$target_port")" ]; then
        megabrain_error "port $target_port is not listening"
      else
        megabrain_error "terminal selector could not be resolved: $selector (listener was not created by megabrain)"
      fi
    else
      megabrain_error "terminal selector could not be resolved: $selector"
    fi
    return 1
  fi
  record="$MEGABRAIN_TERMINAL_RESOLVED_RECORD"
  old_path="$MEGABRAIN_TERMINAL_RESOLVED_PATH"
  kind="$MEGABRAIN_TERMINAL_RESOLVED_KIND"
  value="$MEGABRAIN_TERMINAL_RESOLVED_VALUE"
  root_pid="$(printf '%s' "$record" | jq -r '.rootPid // .pid // empty')"
  case "$root_pid" in ''|0|*[!0-9]*) megabrain_error "terminal $value has no recorded process identity; refusing to kill an unowned process"; return 1 ;; esac
  target_port="$(printf '%s' "$record" | jq -r '.port // empty')"
  if [ "$kind" = port ]; then
    target_pid="$(megabrain_terminal_listener_pid "$value")"
    [ -n "$target_pid" ] || { megabrain_error "port $value is not listening"; return 1; }
    target_port="$value"
  elif [ -n "$target_port" ]; then
    target_pid="$(megabrain_terminal_listener_pid "$target_port")"
  else
    target_pid="$root_pid"
  fi
  if [ -n "$target_pid" ] && ! megabrain_terminal_process_tree_belongs_to "$root_pid" "$target_pid"; then
    megabrain_error "terminal $value process tree is not owned by megabrain; refusing to kill it"
    return 1
  fi
  MEGABRAIN_TERMINAL_KILLED_TREE='[]'
  if ! megabrain_terminal_kill_process_tree "$root_pid"; then
    megabrain_error "could not stop terminal process tree rooted at $root_pid"
    return 1
  fi
  killed_pid_json="$root_pid"
  if [ -n "$target_port" ]; then
    if ! megabrain_terminal_wait_for_port "$target_port" free "$timeout"; then
      megabrain_error "timed out waiting for port $target_port to become free"
      return 1
    fi
  fi
  started="$(date +%s)"
  megabrain_terminal_recreate "$record" "$command_override" || return 1
  waited_port="$wait_port"
  reported_port="${wait_port:-$target_port}"
  if [ -n "$waited_port" ]; then
    if ! megabrain_terminal_wait_for_port "$waited_port" listening "$timeout"; then
      megabrain_error "timed out waiting for port $waited_port to listen again"
      return 1
    fi
    now="$(date +%s)"
    listening_after_ms=$(( (now - started) * 1000 ))
  fi
  [ "$old_path" = "$(megabrain_terminal_record_path "$MEGABRAIN_TERMINAL_RECREATED_ID" 2>/dev/null || true)" ] || rm -f "$old_path"
  port_json="$MEGABRAIN_TERMINAL_RECREATED_PORT_JSON"
  if [ "$json" = true ]; then
    jq -n --arg selector "$selector" --argjson killedPid "$killed_pid_json" \
      --argjson killedTree "$MEGABRAIN_TERMINAL_KILLED_TREE" --arg recreatedTerminalId "$MEGABRAIN_TERMINAL_RECREATED_ID" \
      --argjson port "${reported_port:-null}" --argjson listeningAfterMs "$listening_after_ms" \
      '{selector: $selector, killedPid: $killedPid, killedTree: $killedTree, recreated: true, recreatedTerminalId: $recreatedTerminalId, port: $port, listeningAfterMs: $listeningAfterMs}'
  else
    printf 'selector: %s\nkilled pid: %s\nrecreated terminal: %s\n' "$selector" "$root_pid" "$MEGABRAIN_TERMINAL_RECREATED_ID"
    [ -n "$waited_port" ] && printf 'port %s listening after %sms\n' "$waited_port" "$listening_after_ms"
  fi
}

megabrain_worktree_create_rollback() {
  local repo_path="$1" worktree_path="$2" branch="$3" project_id="$4" project_created="$5"
  local workspace_id="$6" workspace_created="$7" worktree_created="$8" reason="$9"
  local undone="" issues="" output removal_status
  if [ "$workspace_created" = true ]; then
    if [ -n "$workspace_id" ]; then
      removal_status=0
      output="$(megabrain_superset workspaces delete "$workspace_id" --local --json 2>&1)" || removal_status=$?
      if [ "$removal_status" -eq 0 ]; then
        undone="workspace $workspace_id"
      else
        issues="workspace $workspace_id was not removed: $output"
      fi
    else
      issues="workspace identity unavailable (not removed)"
    fi
  elif [ "$workspace_created" = unknown ]; then
    issues="workspace identity unavailable (ownership was not provable; not removed)"
  fi
  if [ "$project_created" = true ]; then
    if [ -n "$project_id" ]; then
      removal_status=0
      output="$(megabrain_superset projects delete "$project_id" --local --json 2>&1)" || removal_status=$?
      if [ "$removal_status" -eq 0 ]; then
        [ -n "$undone" ] && undone="$undone, "
        undone="${undone}project $project_id"
      else
        [ -n "$issues" ] && issues="$issues; "
        issues="${issues}project $project_id was not removed: $output"
      fi
    else
      [ -n "$issues" ] && issues="$issues; "
      issues="${issues}project identity unavailable (not removed)"
    fi
  elif [ "$project_created" = unknown ]; then
    [ -n "$issues" ] && issues="$issues; "
    issues="${issues}project ownership was not provable (not removed)"
  fi
  if [ "$worktree_created" = true ]; then
    removal_status=0
    output="$(git -C "$repo_path" worktree remove --force "$worktree_path" 2>&1)" || removal_status=$?
    if [ "$removal_status" -eq 0 ]; then
      [ -n "$undone" ] && undone="$undone, "
      undone="${undone}worktree $worktree_path"
    else
      [ -n "$issues" ] && issues="$issues; "
      issues="${issues}worktree $worktree_path was not removed: $output"
    fi
  fi
  if [ "$worktree_created" = true ] && [ -n "$branch" ]; then
    removal_status=0
    output="$(git -C "$repo_path" branch -D "$branch" 2>&1)" || removal_status=$?
    if [ "$removal_status" -eq 0 ]; then
      [ -n "$undone" ] && undone="$undone, "
      undone="${undone}branch $branch"
    else
      [ -n "$issues" ] && issues="$issues; "
      issues="${issues}branch $branch was not removed: $output"
    fi
  fi
  [ -n "$undone" ] || undone="nothing"
  if [ -n "$issues" ]; then
    megabrain_error "$reason; rolled back: $undone; cleanup issues: $issues"
  else
    megabrain_error "$reason; rolled back: $undone"
  fi
  return 1
}

megabrain_worktree_create() {
  local repo_selector="" branch="" base="" slug="" agent="" model="" effort="" chain_name="" prompt="" label="" worktree_selector="" parent_selector="" issue="" linear_issue="" pr_number="" orchestrate=false json=false reused=false browser=false
  local parent_requested=false no_parent=false parent_path="" parent_branch="" parent_tag=""
  local parent_metadata_set=false parent_metadata_error="" lineage_set=false grouping_set=false lineage_error="" grouping_error=""
  local links_set=false links_error=""
  local model_explicit=false effort_explicit=false chain_selected=false chain_config=""
  local arg repo_path shared_root worktree_path project_id="" workspace_id dispatch="" host runtime="" tmux_choice=auto walk_status parent_json
  local project_record workspace_record project_created=false workspace_created=false workspace_existing_id="" worktree_created=false launch_status=0
  local -a agent_args=() orca_set_args=()
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --repo) repo_selector="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --base) base="${2:-}"; shift 2 ;;
      --parent)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--parent requires a non-empty selector'; return "$MEGABRAIN_USAGE_ERROR"; }
        [ "$no_parent" = false ] || { megabrain_error '--parent cannot be combined with --no-parent'; return "$MEGABRAIN_USAGE_ERROR"; }
        parent_selector="$2"
        parent_requested=true
        shift 2
        ;;
      --no-parent)
        [ "$parent_requested" = false ] || { megabrain_error '--parent cannot be combined with --no-parent'; return "$MEGABRAIN_USAGE_ERROR"; }
        no_parent=true
        shift
        ;;
      --issue)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--issue requires a non-empty number'; return "$MEGABRAIN_USAGE_ERROR"; }
        issue="$2"
        shift 2
        ;;
      --linear-issue)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--linear-issue requires a non-empty identifier or URL'; return "$MEGABRAIN_USAGE_ERROR"; }
        linear_issue="$2"
        shift 2
        ;;
      --pr)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--pr requires a non-empty number'; return "$MEGABRAIN_USAGE_ERROR"; }
        pr_number="$2"
        shift 2
        ;;
      --name) slug="${2:-}"; shift 2 ;;
      --agent) agent="${2:-}"; shift 2 ;;
      --model) model="${2:-}"; model_explicit=true; shift 2 ;;
      --effort) effort="${2:-}"; effort_explicit=true; shift 2 ;;
      --chain)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--chain requires a non-empty value'; return "$MEGABRAIN_USAGE_ERROR"; }
        chain_name="$2"
        shift 2
        ;;
      --prompt) prompt="${2:-}"; shift 2 ;;
      --label) label="${2:-}"; shift 2 ;;
      --worktree) worktree_selector="${2:-}"; shift 2 ;;
      --tmux) tmux_choice="${2:-}"; shift 2 ;;
      --browser) browser=true; shift ;;
      --agent-arg)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error "--agent-arg requires a non-empty value"; return "$MEGABRAIN_USAGE_ERROR"; }
        agent_args+=("$2")
        shift 2
        ;;
      --orchestrate) orchestrate=true; shift ;;
      --json) json=true; shift ;;
      -h|--help)
        if [ "$orchestrate" = true ]; then
          megabrain_usage_show orchestrate-spawn
        else
          megabrain_usage_show worktree-create
        fi
        return 0
        ;;
      *) megabrain_error "unknown worktree create option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  if [ "$orchestrate" = true ]; then
    megabrain_session_id >/dev/null
    [ -n "$MEGABRAIN_SESSION_ID" ] || { megabrain_error "cannot spawn a managed dispatch from an unmanaged shell"; return 1; }
  fi
  if [ "$orchestrate" != true ] && [ -n "$chain_name" ]; then
    megabrain_error '--chain is only supported by orchestrate spawn'
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  if [ "$orchestrate" = true ] && [ -n "$agent" ] && [ -n "$chain_name" ]; then
    megabrain_error '--chain cannot be combined with --agent'
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  if [ -n "$worktree_selector" ] && [ "$orchestrate" != true ]; then
    megabrain_error "--worktree is only supported by orchestrate spawn"
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  if [ "$orchestrate" != true ] && [ "$tmux_choice" != auto ]; then
    megabrain_error "--tmux is only supported by orchestrate spawn"
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  if [ -z "$worktree_selector" ]; then
    [ -n "$repo_selector" ] || { megabrain_error "--repo is required"; return "$MEGABRAIN_USAGE_ERROR"; }
    [ -n "$branch" ] || { megabrain_error "--branch is required"; return "$MEGABRAIN_USAGE_ERROR"; }
  fi
  host="$(megabrain_context_detect)"
  if [ "$orchestrate" = true ]; then
    if [ -z "$agent" ]; then
      if ! declare -F megabrain_chain_walk >/dev/null 2>&1; then
        # shellcheck source=local/megabrain/lib/module-chain.sh
        source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/module-chain.sh" || return 1
      fi
      chain_config="$(megabrain_chain_read)" || return 1
      megabrain_chain_validate_config "$chain_config" || return 1
      if [ -n "$chain_name" ]; then
        megabrain_chain_select "$chain_config" "$chain_name" "${SUPERSET_AGENT_ID:-}" "${SUPERSET_AGENT_MODEL:-}" "${SUPERSET_AGENT_EFFORT:-}" flag || return 1
      else
        megabrain_chain_select "$chain_config" '' "${SUPERSET_AGENT_ID:-}" "${SUPERSET_AGENT_MODEL:-}" "${SUPERSET_AGENT_EFFORT:-}" selector || return 1
      fi
      if [ "${#agent_args[@]}" -gt 0 ]; then
        if megabrain_chain_walk "$worktree_selector" "$repo_selector" "$branch" "$base" "$slug" "$prompt" "$label" "$tmux_choice" "$model" "$effort" "$model_explicit" "$effort_explicit" "$browser" "${agent_args[@]}"; then
          printf '%s\n' "$MEGABRAIN_CHAIN_WALK_OUTPUT"
          return 0
        else
          walk_status="$?"
          return "$walk_status"
        fi
      elif megabrain_chain_walk "$worktree_selector" "$repo_selector" "$branch" "$base" "$slug" "$prompt" "$label" "$tmux_choice" "$model" "$effort" "$model_explicit" "$effort_explicit" "$browser"; then
        printf '%s\n' "$MEGABRAIN_CHAIN_WALK_OUTPUT"
        return 0
      else
        walk_status="$?"
        return "$walk_status"
      fi
    fi
    [ -n "$agent" ] || { megabrain_error "no agent selected; add a chain with megabrain chain add or pass --agent"; return "$MEGABRAIN_USAGE_ERROR"; }
    [ -n "$model" ] || { megabrain_error "--model is required for orchestrate spawn"; return "$MEGABRAIN_USAGE_ERROR"; }
    if [ "$chain_selected" = true ] && { [ "$model_explicit" = true ] || [ "$effort_explicit" = true ]; }; then
      if ! megabrain_model_known "$agent" "$model"; then
        megabrain_error "--model '$model' is not valid for chain-selected agent '$agent'; list models with megabrain model list"
        return "$MEGABRAIN_USAGE_ERROR"
      fi
      if ! megabrain_model_validate_reasoning "$agent" "$model" "$effort"; then
        return "$MEGABRAIN_USAGE_ERROR"
      fi
    fi
    if [ -z "$effort" ] && { ! megabrain_model_known "$agent" "$model" || megabrain_model_effort_separate "$agent" "$model"; }; then
      megabrain_error "--effort is required for orchestrate spawn"
      return "$MEGABRAIN_USAGE_ERROR"
    fi
    [ -n "$prompt" ] || { megabrain_error "--prompt is required for orchestrate spawn"; return "$MEGABRAIN_USAGE_ERROR"; }
    megabrain_resolve_spawn_runtime "$tmux_choice" || return 1
    runtime="$MEGABRAIN_SPAWN_RUNTIME"
    host="$MEGABRAIN_SPAWN_CONTEXT"
    if [ "$runtime" = tmux ]; then
      megabrain_validate_prompt_budget "$prompt" tmux prompt || return 1
    else
      megabrain_validate_prompt_budget "$prompt" argv prompt || return 1
    fi
  fi
  if [ "$host" != superset ] && [ -n "$agent" ] && ! megabrain_require_command "$agent"; then
    megabrain_error "agent is not on PATH: $agent"
    return 1
  fi
  if [ -n "$worktree_selector" ]; then
    if [ -d "$worktree_selector" ]; then
      worktree_path="$(git -C "$worktree_selector" rev-parse --show-toplevel 2>/dev/null || true)"
    else
      shared_root="$(megabrain_worktree_root --read-only 2>/dev/null || true)"
      worktree_path="$(megabrain_find_worktree_path "$worktree_selector" "$shared_root" 2>/dev/null || true)"
    fi
    [ -n "$worktree_path" ] || { megabrain_error "existing Git worktree not found: $worktree_selector"; return 1; }
    reused=true
    branch="$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    [ -n "$branch" ] || { megabrain_error "cannot spawn in detached worktree: $worktree_path"; return 1; }
    workspace_id="$(megabrain_workspace_id_for_target "$worktree_path" 2>/dev/null || true)"
    if [ "$host" = superset ] && [ -z "$workspace_id" ]; then
      megabrain_error "no Superset workspace is registered for $worktree_path; run megabrain worktree adopt $worktree_path first"
      return 1
    fi
    repo_path="$(git -C "$worktree_path" rev-parse --show-toplevel)"
    if [ "$parent_requested" = true ]; then
      megabrain_worktree_parent_resolve "$parent_selector" "$repo_path" || return 1
      parent_path="$MEGABRAIN_PARENT_PATH"
      parent_branch="$MEGABRAIN_PARENT_BRANCH"
      parent_tag="$MEGABRAIN_PARENT_TAG"
    fi
  else
    repo_path="$(megabrain_repo_from_orca "$repo_selector")" || return 1
    if [ "$parent_requested" = true ]; then
      megabrain_worktree_parent_resolve "$parent_selector" "$repo_path" || return 1
      parent_path="$MEGABRAIN_PARENT_PATH"
      parent_branch="$MEGABRAIN_PARENT_BRANCH"
      parent_tag="$MEGABRAIN_PARENT_TAG"
    fi
    shared_root="$(megabrain_worktree_root)" || return 1
    [ -n "$base" ] || base="$(megabrain_repo_default_base "$repo_path")"
    [ -n "$slug" ] || slug="$(megabrain_slug_from_branch "$branch")" || { megabrain_error "branch cannot produce a safe slug"; return 1; }
    case "$slug" in
      .|..|*/*|*"$'\n'"*) megabrain_error "invalid worktree name: $slug"; return 1 ;;
    esac
    worktree_path="$shared_root/$slug"
    [ ! -e "$worktree_path" ] || { megabrain_error "worktree path already exists: $worktree_path"; return 1; }
    mkdir -p "$shared_root" || return 1
    if [ "$json" = true ]; then
      git -C "$repo_path" worktree add "$worktree_path" -b "$branch" "$base" >/dev/null || { megabrain_error "could not create git worktree"; return 1; }
    elif ! git -C "$repo_path" worktree add "$worktree_path" -b "$branch" "$base"; then
      megabrain_error "could not create git worktree"
      return 1
    fi
    worktree_created=true
    project_record="$(megabrain_ensure_superset_project "$repo_path" --record)" || {
      project_id="$(megabrain_project_id_for_path "$repo_path" 2>/dev/null || true)"
      megabrain_worktree_create_rollback "$repo_path" "$worktree_path" "$branch" "$project_id" unknown "" false true "could not register Superset project"
      return 1
    }
    project_id="$(printf '%s' "$project_record" | jq -r '.id // empty')"
    project_created="$(printf '%s' "$project_record" | jq -r '.created // false')"
    workspace_existing_id="$(megabrain_workspace_id_for_target "$branch" 2>/dev/null || true)"
    if [ "$parent_requested" = true ]; then
      if [ -n "$pr_number" ]; then
        workspace_record="$(megabrain_workspace_create "$project_id" "$branch" "$slug" --tag "$parent_tag" --pr "$pr_number" --record)" || workspace_record=""
      else
        workspace_record="$(megabrain_workspace_create "$project_id" "$branch" "$slug" --tag "$parent_tag" --record)" || workspace_record=""
      fi
    elif [ -n "$pr_number" ]; then
      workspace_record="$(megabrain_workspace_create "$project_id" "$branch" "$slug" --pr "$pr_number" --record)" || workspace_record=""
    elif ! workspace_record="$(megabrain_workspace_create "$project_id" "$branch" "$slug" --record)"; then
      workspace_record=""
    fi
    if [ -z "$workspace_record" ]; then
      workspace_id="$(megabrain_workspace_id_for_target "$branch" 2>/dev/null || true)"
      if [ -n "$workspace_id" ] && [ -z "$workspace_existing_id" ]; then
        workspace_created=true
      elif [ -n "$workspace_id" ]; then
        workspace_created=false
      else
        workspace_created=unknown
      fi
      megabrain_worktree_create_rollback "$repo_path" "$worktree_path" "$branch" "$project_id" "$project_created" "$workspace_id" "$workspace_created" true "could not create Superset workspace"
      return 1
    fi
    workspace_id="$(printf '%s' "$workspace_record" | jq -r '.id // empty')"
    workspace_created="$(printf '%s' "$workspace_record" | jq -r '.created // false')"
    if [ "$parent_requested" = true ]; then
      grouping_set="$(printf '%s' "$workspace_record" | jq -r '.tagSet // false')"
      grouping_error="$(printf '%s' "$workspace_record" | jq -r '.tagError // empty')"
    fi
  fi
  if [ "$parent_requested" = true ]; then
    if git -C "$worktree_path" config "branch.$branch.megabrain-parent" "$parent_branch"; then
      parent_metadata_set=true
    else
      parent_metadata_error="Git stack parent metadata was not recorded for $branch"
    fi
  fi
  if [ "$parent_requested" = true ]; then
    if [ "$reused" = true ]; then
      if [ -n "$workspace_id" ]; then
        workspace_record="$(megabrain_workspace_create "" "$branch" "$(basename "$worktree_path")" --tag "$parent_tag" --record 2>/dev/null || true)"
        grouping_set="$(printf '%s' "$workspace_record" | jq -r '.tagSet // false')"
        grouping_error="$(printf '%s' "$workspace_record" | jq -r '.tagError // empty')"
      else
        MEGABRAIN_WORKSPACE_TAG_SET=false
        grouping_set=false
        grouping_error="Superset workspace is not registered for $worktree_path"
      fi
    fi
  fi
  if [ "$parent_requested" = true ] || [ -n "$issue" ] || [ -n "$linear_issue" ]; then
    if megabrain_require_command orca; then
      orca_set_args=(worktree set --worktree "path:$worktree_path")
      if [ "$parent_requested" = true ]; then
        orca_set_args+=(--parent-worktree "$parent_selector")
      fi
      if [ -n "$issue" ]; then
        orca_set_args+=(--issue "$issue")
      fi
      if [ -n "$linear_issue" ]; then
        orca_set_args+=(--linear-issue "$linear_issue")
      fi
      orca_set_args+=(--json)
      if orca "${orca_set_args[@]}" >/dev/null 2>&1; then
        [ "$parent_requested" = true ] && lineage_set=true
        [ -n "$issue" ] || [ -n "$linear_issue" ] && links_set=true
      else
        [ "$parent_requested" = true ] && lineage_error="Orca parent lineage was not set for $parent_selector"
        [ -n "$issue" ] || [ -n "$linear_issue" ] && links_error="Orca issue links were not set"
      fi
    else
      [ "$parent_requested" = true ] && lineage_error="Orca CLI is not available"
      [ -n "$issue" ] || [ -n "$linear_issue" ] && links_error="Orca CLI is not available"
    fi
  fi
  if [ "$parent_requested" = true ]; then
    if [ "$json" != true ]; then
      [ "$lineage_set" = true ] || megabrain_notice "$lineage_error"
      [ "$parent_metadata_set" = true ] || megabrain_notice "${parent_metadata_error:-Git stack parent metadata was not recorded}"
      [ "$grouping_set" = true ] || megabrain_notice "${grouping_error:-Superset parent grouping was not set}"
    fi
  fi
  if [ "$json" != true ] && { [ -n "$issue" ] || [ -n "$linear_issue" ]; }; then
    [ "$links_set" = true ] || megabrain_notice "${links_error:-Orca issue links were not set}"
  fi
  if [ "$json" != true ]; then
    printf 'worktree: %s\nbranch: %s\nworkspace: %s\nreused: %s\n' "$worktree_path" "$branch" "$workspace_id" "$reused"
  fi
  if [ -n "$agent" ]; then
    launch_args=("$worktree_path" "$workspace_id" "$agent" "$model" "$effort" "$prompt" "$label")
    [ "$browser" = true ] && launch_args+=(true)
    if [ "${#agent_args[@]}" -gt 0 ]; then
      launch_args+=("${agent_args[@]}")
    fi
    # Bash 3.2 rejects empty array expansion under set -u.
    if [ "${#agent_args[@]}" -gt 0 ]; then
      if [ "$json" = true ]; then
        megabrain_launch_agent "${launch_args[@]}" >/dev/null || launch_status=$?
      else
        megabrain_launch_agent "${launch_args[@]}" || launch_status=$?
      fi
    else
      if [ "$json" = true ]; then
        megabrain_launch_agent "${launch_args[@]}" >/dev/null || launch_status=$?
      else
        megabrain_launch_agent "${launch_args[@]}" || launch_status=$?
      fi
    fi
    if [ "${launch_status:-0}" -ne 0 ]; then
      megabrain_worktree_create_rollback "$repo_path" "$worktree_path" "$branch" "$project_id" "$project_created" "$workspace_id" "$workspace_created" "$worktree_created" "agent launch failed"
      return 1
    fi
    dispatch="$MEGABRAIN_LAST_DISPATCH"
    runtime="$MEGABRAIN_LAST_SPAWN_RUNTIME"
    if [ -n "$dispatch" ] && [ "$json" != true ]; then
      printf 'dispatch: %s\nruntime: %s\n' "$dispatch" "$runtime"
    fi
  fi
  if [ "$orchestrate" = true ] && [ "$json" != true ]; then
    megabrain_info "host: $(megabrain_context_detect)"
  fi
  if [ "$json" = true ]; then
    if [ "$parent_requested" = true ]; then
      parent_json="$(jq -n --arg selector "$parent_selector" --arg branch "$parent_branch" --arg tag "$parent_tag" \
        --argjson lineageSet "$lineage_set" --arg lineageError "$lineage_error" \
        --argjson groupingSet "$grouping_set" --arg groupingError "$grouping_error" \
        --argjson metadataSet "$parent_metadata_set" --arg metadataError "$parent_metadata_error" \
        '{requested: true, selector: $selector, branch: $branch, tag: $tag, metadata: {set: $metadataSet, error: (if $metadataError|length > 0 then $metadataError else null end)}, lineage: {set: $lineageSet, error: (if $lineageError|length > 0 then $lineageError else null end)}, grouping: {set: $groupingSet, error: (if $groupingError|length > 0 then $groupingError else null end)}}')"
    else
      parent_json='{"requested":false}'
    fi
    if [ -n "${dispatch:-}" ]; then
      jq -n --arg worktree "$worktree_path" --arg branch "$branch" --arg workspace "$workspace_id" --arg dispatch "$dispatch" --arg reused "$reused" --arg runtime "$runtime" \
        --argjson parent "$parent_json" \
        --arg issue "$issue" --arg linearIssue "$linear_issue" --argjson linksSet "$links_set" --arg linksError "$links_error" \
        '{worktree: $worktree, branch: $branch, workspace: (if $workspace|length > 0 then $workspace else null end), dispatch: $dispatch, reused: ($reused == "true"), runtime: $runtime, parent: $parent, links: {issue: (if $issue|length > 0 then $issue else null end), linearIssue: (if $linearIssue|length > 0 then $linearIssue else null end), set: $linksSet, error: (if $linksError|length > 0 then $linksError else null end)}}'
    else
      jq -n --arg worktree "$worktree_path" --arg branch "$branch" --arg workspace "$workspace_id" --arg reused "$reused" \
        --argjson parent "$parent_json" \
        --arg issue "$issue" --arg linearIssue "$linear_issue" --argjson linksSet "$links_set" --arg linksError "$links_error" \
        '{worktree: $worktree, branch: $branch, workspace: (if $workspace|length > 0 then $workspace else null end), reused: ($reused == "true"), parent: $parent, links: {issue: (if $issue|length > 0 then $issue else null end), linearIssue: (if $linearIssue|length > 0 then $linearIssue else null end), set: $linksSet, error: (if $linksError|length > 0 then $linksError else null end)}}'
    fi
  fi
  return 0
}

megabrain_find_worktree_path() {
  local target="$1" shared_root="$2" path branch line current_path current_branch
  if [ -d "$target" ] && git -C "$target" rev-parse --show-toplevel >/dev/null 2>&1; then
    git -C "$target" rev-parse --show-toplevel
    return 0
  fi
  if [ -z "$shared_root" ]; then
    git worktree list --porcelain 2>/dev/null | awk -v target="$target" '
      /^worktree / { path = $2 }
      /^branch / { branch = $2; sub("refs/heads/", "", branch); if (branch == target || path ~ "/" target "$" ) print path }
    ' | head -n 1
    return 0
  fi
  for path in "$shared_root"/*; do
    [ -d "$path" ] || continue
    git -C "$path" rev-parse --show-toplevel >/dev/null 2>&1 || continue
    current_path="$(git -C "$path" rev-parse --show-toplevel)"
    current_branch="$(git -C "$current_path" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
    if [ "$target" = "$current_branch" ] || [ "$target" = "${current_branch#refs/heads/}" ] || [ "$target" = "$(basename "$current_path")" ]; then
      printf '%s\n' "$current_path"
      return 0
    fi
  done
  return 1
}

megabrain_worktree_finish_json() {
  local deleted="$1" branch="$2" path="$3" base="$4" base_source="$5" base_warning="$6"
  local branch_deleted="$7" error="$8" refusal_code="$9" refusal_message="${10}"
  jq -cn --argjson deleted "$deleted" --arg branch "$branch" --arg path "$path" --arg base "$base" \
    --arg baseSource "$base_source" --arg baseWarning "$base_warning" --arg branchDeleted "$branch_deleted" \
    --arg error "$error" --arg refusalCode "$refusal_code" --arg refusalMessage "$refusal_message" \
    '{deleted: $deleted, branch: (if $branch|length > 0 then $branch else null end), path: (if $path|length > 0 then $path else null end), base: (if $base|length > 0 then $base else null end), baseSource: (if $baseSource|length > 0 then $baseSource else null end), baseWarning: (if $baseWarning|length > 0 then $baseWarning else null end), branchDeleted: (if $branchDeleted == "" then null else ($branchDeleted == "true") end), error: (if $error|length > 0 then $error else null end), refusal: (if $refusalCode|length > 0 then {code: $refusalCode, message: $refusalMessage} else null end)}'
}

megabrain_worktree_finish() {
  local target="" delete_branch=false force=false json=false arg="" shared_root="" path="" workspace_id="" repo_path="" branch="" base="" merged=""
  local parent_branch="" base_source="" base_warning="" branch_delete_status=0 branch_delete_output="" branch_delete_error=""
  local removal_output="" removal_status=0 removal_error="" branch_deleted="" usage_message="" refusal_message=""
  local scan_arg=""
  for scan_arg in "$@"; do
    [ "$scan_arg" = --json ] && json=true
  done
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      --delete-branch) delete_branch=true; shift ;;
      --force) force=true; shift ;;
      --base)
        if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
          usage_message='--base requires a non-empty ref'
          megabrain_error "$usage_message"
          if [ "$json" = true ]; then
            megabrain_worktree_finish_json false "" "" "" "" "" "" "" invalid-arguments "$usage_message"
          fi
          return "$MEGABRAIN_USAGE_ERROR"
        fi
        base="$2"
        base_source="explicit"
        shift 2
        ;;
      -h|--help) megabrain_usage_show worktree-finish; return 0 ;;
      *)
        if [ "${arg#-}" != "$arg" ] || [ -n "$target" ]; then
          usage_message="unknown worktree finish option: $arg"
          megabrain_error "$usage_message"
          if [ "$json" = true ]; then
            megabrain_worktree_finish_json false "" "" "" "" "" "" "" invalid-arguments "$usage_message"
          fi
          return "$MEGABRAIN_USAGE_ERROR"
        fi
        target="$arg"
        shift
        ;;
    esac
  done
  if [ -z "$target" ]; then
    usage_message="Usage: megabrain $(megabrain_usage_line worktree-finish)"
    megabrain_error "$usage_message"
    if [ "$json" = true ]; then
      megabrain_worktree_finish_json false "" "" "" "" "" "" "" invalid-arguments "$usage_message"
    fi
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  shared_root="$(megabrain_worktree_root 2>/dev/null || true)"
  path=""
  if megabrain_superset_available; then
    path="$(megabrain_workspace_path_for_target "$target")"
    workspace_id="$(megabrain_workspace_id_for_target "$target")"
  fi
  if [ -z "$path" ] && [ -n "$shared_root" ]; then
    path="$(megabrain_find_worktree_path "$target" "$shared_root" 2>/dev/null || true)"
  fi
  if [ -z "$path" ]; then
    refusal_message="worktree not found: $target"
    megabrain_error "$refusal_message"
    if [ "$json" = true ]; then
      megabrain_worktree_finish_json false "" "" "" "" "" "" "" worktree-not-found "$refusal_message"
    fi
    return 1
  fi
  repo_path="$(git -C "$path" rev-parse --git-common-dir)"
  case "$repo_path" in
    /*) ;;
    *) repo_path="$path/$repo_path" ;;
  esac
  repo_path="$(dirname "$(realpath "$repo_path")")"
  branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ "$delete_branch" = true ] && [ -n "$branch" ] && [ -z "$base" ]; then
    parent_branch="$(megabrain_worktree_parent_branch "$path" 2>/dev/null || true)"
    if [ -n "$parent_branch" ] && git -C "$repo_path" show-ref --verify --quiet "refs/heads/$parent_branch"; then
      base="$parent_branch"
      base_source="recorded-parent"
    else
      base="$(megabrain_repo_default_base "$repo_path")"
      base_source="repository-default"
      if [ -n "$parent_branch" ]; then
        base_warning="recorded parent branch no longer exists: $parent_branch; judging against repository default base $base"
      fi
    fi
  fi
  if [ "$delete_branch" = true ] && [ -n "$branch" ]; then
    [ -n "$base" ] || {
      base="$(megabrain_repo_default_base "$repo_path")"
      base_source="repository-default"
    }
    [ -z "$base_warning" ] || megabrain_notice "$base_warning"
    if [ "$force" != true ]; then
      merged="$(git -C "$repo_path" branch --merged "$base" 2>/dev/null || true)"
      if ! printf '%s\n' "$merged" | sed 's/^..//' | awk '{print $1}' | grep -Fx "$branch" >/dev/null; then
        refusal_message="refusing to delete unmerged branch: $branch against base $base (use --force to override)"
        megabrain_error "$refusal_message"
        if [ "$json" = true ]; then
          megabrain_worktree_finish_json false "$branch" "$path" "$base" "$base_source" "$base_warning" "" "" unmerged-branch "$refusal_message"
        fi
        return 1
      fi
    fi
  fi
  # WHY: under --json the remover's own stdout is captured so it cannot corrupt the
  # JSON. On failure its message is reported as megabrain's own error; on success it is
  # deliberately discarded so another tool cannot masquerade as megabrain's answer.
  megabrain_worktree_removal_reason() {
    local output="$1" reason=""
    # The orchestrators answer in JSON, so lift their own message out of it when there is
    # one and fall back to the raw text for a remover that writes plain lines.
    reason="$(printf '%s' "$output" | jq -r 'if (.error | type) == "object" then (.error.message // .error.code // empty) else (.error // .message // empty) end' 2>/dev/null || true)"
    [ -n "$reason" ] || reason="$output"
    reason="$(printf '%s' "$reason" | tr '\r\n' '  ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//')"
    [ -n "$reason" ] || reason='the remover gave no reason'
    printf '%s\n' "$reason"
  }
  if [ -n "$workspace_id" ]; then
    removal_output="$(megabrain_superset workspaces delete "$workspace_id" --local --json 2>&1)" || removal_status=$?
  elif megabrain_require_command orca; then
    removal_output="$(orca worktree rm --worktree "path:$path" $([ "$force" = true ] && printf '%s' --force) --json 2>&1)" || removal_status=$?
  else
    removal_output="$(git -C "$repo_path" worktree remove $([ "$force" = true ] && printf '%s' --force) "$path" 2>&1)" || removal_status=$?
  fi
  if [ "$removal_status" -ne 0 ]; then
    removal_error="$(megabrain_worktree_removal_reason "$removal_output")"
    megabrain_error "could not remove worktree $path: $removal_error"
    if [ "$json" = true ]; then
      megabrain_worktree_finish_json false "$branch" "$path" "$base" "$base_source" "$base_warning" "" "$removal_error" "" ""
    fi
    return 1
  fi
  [ "$json" = true ] || printf 'removed: %s\n' "$path"
  if [ "$delete_branch" = true ] && [ -n "$branch" ]; then
    [ "$json" = true ] || printf 'judged branch %s against base %s (%s)\n' "$branch" "$base" "$base_source"
    branch_delete_output="$(git -C "$repo_path" branch -D "$branch" 2>&1)" || branch_delete_status=$?
    if [ "$branch_delete_status" -ne 0 ]; then
      branch_delete_error="$(megabrain_worktree_removal_reason "$branch_delete_output")"
      if [ "$json" = true ]; then
        megabrain_worktree_finish_json true "$branch" "$path" "$base" "$base_source" "$base_warning" false "$branch_delete_error" "" ""
      else
        [ -n "$branch_delete_output" ] && printf '%s\n' "$branch_delete_output"
      fi
      megabrain_error "could not delete branch: $branch: $branch_delete_error"
      return 1
    fi
    [ "$json" = true ] || [ -z "$branch_delete_output" ] || printf '%s\n' "$branch_delete_output"
    branch_deleted=true
  fi
  if [ "$json" = true ]; then
    megabrain_worktree_finish_json true "$branch" "$path" "$base" "$base_source" "$base_warning" "$branch_deleted" "" "" ""
  fi
}

megabrain_worktree_pr() {
  local target="" base="" title="" body="" arg shared_root path repo_path branch parent_branch="" ahead="" response="" json=false
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --base) base="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --body) body="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show worktree-pr; return 0 ;;
      *)
        [ -z "$target" ] || { megabrain_error "unknown worktree pr option: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }
        target="$arg"
        shift
        ;;
    esac
  done
  [ -n "$target" ] || { megabrain_usage_fail worktree-pr; return "$MEGABRAIN_USAGE_ERROR"; }
  shared_root="$(megabrain_worktree_root --read-only 2>/dev/null || true)"
  path="$(megabrain_worktree_target_path "$target" "$shared_root" || true)"
  [ -n "$path" ] || { megabrain_error "worktree not found: $target"; return 1; }
  repo_path="$(git -C "$path" rev-parse --show-toplevel)"
  branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ -n "$branch" ] || { megabrain_error "cannot open a pull request from detached worktree: $path"; return 1; }
  [ -n "$title" ] || title="$branch"
  if [ -z "$base" ]; then
    parent_branch="$(megabrain_worktree_parent_branch "$path" 2>/dev/null || true)"
    if [ -n "$parent_branch" ]; then
      base="$parent_branch"
    else
      base="$(megabrain_repo_default_base "$repo_path")"
    fi
  fi
  if ! megabrain_require_command gh; then
    megabrain_error "gh CLI is not installed"
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    megabrain_error "gh CLI is not authenticated"
    return 1
  fi
  if ! git -C "$path" rev-parse --verify "$base^{commit}" >/dev/null 2>&1; then
    megabrain_error "pull request base does not exist: $base"
    return 1
  fi
  ahead="$(git -C "$path" rev-list --count "$base..$branch" 2>/dev/null || printf '0')"
  if [ "$ahead" -eq 0 ]; then
    megabrain_error "refusing to open a pull request: no commits ahead of base $base"
    return 1
  fi
  response="$(gh pr create --base "$base" --head "$branch" --title "$title" --body "$body" 2>&1)" || {
    megabrain_error "could not open pull request: $response"
    return 1
  }
  if [ "$json" = true ]; then
    jq -n --arg path "$path" --arg branch "$branch" --arg base "$base" --arg title "$title" --arg body "$body" --arg url "$response" \
      '{worktree: $path, branch: $branch, base: $base, title: $title, body: $body, url: $url}'
  else
    printf '%s\n' "$response"
  fi
}

megabrain_worktree_list_tree_node() {
  local wanted_parent="$1" indent="$2" line path branch parent in_superset pr_state pr_number pr_url
  while IFS='|' read -r path branch parent in_superset pr_state pr_number pr_url; do
    [ -n "$branch" ] || continue
    [ "$parent" = "$wanted_parent" ] || continue
    if [ -n "$pr_state" ]; then
      printf '%s%s %s [%s]\n' "$indent" "$branch" "$path" "$pr_state"
    else
      printf '%s%s %s\n' "$indent" "$branch" "$path"
    fi
    megabrain_worktree_list_tree_node "$branch" "${indent}  " <<EOF
${MEGABRAIN_WORKTREE_LIST_ENTRIES}
EOF
  done <<EOF
${MEGABRAIN_WORKTREE_LIST_ENTRIES}
EOF
}

megabrain_worktree_list() {
  local repo_selector="" arg shared_root repo_filter="" path branch parent in_superset workspaces_json json=false flat=false entry entries pr_json pr_state="" pr_number="" pr_url=""
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --repo) repo_selector="${2:-}"; shift 2 ;;
      --json) json=true; shift ;;
      --flat) flat=true; shift ;;
      --tree) flat=false; shift ;;
      -h|--help) megabrain_usage_show worktree-list; return 0 ;;
      *) megabrain_error "unknown worktree list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  shared_root="$(megabrain_worktree_root)" || return 1
  if [ -n "$repo_selector" ]; then
    repo_filter="$(megabrain_repo_from_orca "$repo_selector")" || return 1
    repo_filter="$(git -C "$repo_filter" rev-parse --git-common-dir | xargs realpath 2>/dev/null || true)"
  fi
  workspaces_json='[]'
  if megabrain_superset_available; then
    workspaces_json="$(megabrain_superset_workspaces_json || printf '[]')"
  fi
  entries=''
  if [ "$json" != true ] && [ "$flat" = true ]; then
    printf '%-52s %-32s %s\n' PATH BRANCH IN_SUPERSET
  fi
  MEGABRAIN_WORKTREE_LIST_ENTRIES=''
  for path in "$shared_root"/*; do
    [ -d "$path" ] || continue
    git -C "$path" rev-parse --show-toplevel >/dev/null 2>&1 || continue
    [ -z "$repo_filter" ] || [ "$(git -C "$path" rev-parse --git-common-dir | xargs realpath 2>/dev/null || true)" = "$repo_filter" ] || continue
    path="$(git -C "$path" rev-parse --show-toplevel)"
    branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
    in_superset="no"
    if printf '%s' "$workspaces_json" | jq -e --arg path "$path" 'any((if type == "array" then . else (.result.workspaces? // .workspaces? // .result? // []) end)[]?; (.worktreePath // .path // .worktree.path // "") == $path)' >/dev/null 2>&1; then
      in_superset="yes"
    fi
    parent="$(megabrain_worktree_parent_branch "$path" 2>/dev/null || true)"
    pr_state=""
    pr_number=""
    pr_url=""
    if megabrain_require_command gh; then
      pr_json="$(gh pr view "$branch" --json number,state,url 2>/dev/null || true)"
      pr_state="$(printf '%s' "$pr_json" | jq -r '.state // empty' 2>/dev/null || true)"
      pr_number="$(printf '%s' "$pr_json" | jq -r '.number // empty' 2>/dev/null || true)"
      pr_url="$(printf '%s' "$pr_json" | jq -r '.url // empty' 2>/dev/null || true)"
    fi
    MEGABRAIN_WORKTREE_LIST_ENTRIES="${MEGABRAIN_WORKTREE_LIST_ENTRIES}${path}|${branch}|${parent}|${in_superset}|${pr_state}|${pr_number}|${pr_url}"$'\n'
    if [ "$json" = true ]; then
      entry="$(jq -n --arg path "$path" --arg branch "$branch" --arg parent "$parent" \
        --arg prState "$pr_state" --arg prNumber "$pr_number" --arg prUrl "$pr_url" \
        --argjson inSuperset "$(if [ "$in_superset" = yes ]; then printf true; else printf false; fi)" \
        '{path: $path, branch: $branch, parent: (if $parent|length > 0 then $parent else null end), inSuperset: $inSuperset, pullRequest: (if $prNumber|length > 0 then {number: ($prNumber|tonumber), state: $prState, url: $prUrl} else null end)}')"
      entries="${entries}${entry}"$'\n'
    elif [ "$flat" = true ]; then
      printf '%-52s %-32s %s\n' "$path" "$branch" "$in_superset"
    fi
  done
  if [ "$json" = true ]; then
    printf '%s' "$entries" | jq -s .
  elif [ "$flat" != true ]; then
    printf '%-52s %-32s\n' BRANCH PATH
    megabrain_worktree_list_tree_node "" ""
  fi
}

megabrain_worktree_adopt() {
  local target="" arg shared_root path repo_path branch slug project_id workspace_id json=false
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show worktree-adopt; return 0 ;;
      *)
        [ -z "$target" ] || { megabrain_error "unknown worktree adopt option: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }
        target="$arg"
        shift
        ;;
    esac
  done
  [ -n "$target" ] || { megabrain_usage_fail worktree-adopt; return "$MEGABRAIN_USAGE_ERROR"; }
  shared_root="$(megabrain_worktree_root)" || return 1
  if [ -d "$target" ]; then
    path="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)"
  else
    path="$(megabrain_find_worktree_path "$target" "$shared_root" 2>/dev/null || true)"
  fi
  [ -n "$path" ] || { megabrain_error "physical worktree not found: $target"; return 1; }
  case "$path" in
    "$shared_root"/*) ;;
    *) megabrain_error "worktree is outside Superset's shared root: $path"; return 1 ;;
  esac
  repo_path="$(megabrain_repo_from_orca "$path")" || return 1
  branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ -n "$branch" ] || { megabrain_error "cannot adopt detached worktree: $path"; return 1; }
  if [ -n "$(megabrain_workspace_id_for_target "$path")" ]; then
    megabrain_error "worktree is already registered in Superset: $path"
    return 1
  fi
  slug="$(basename "$path")"
  project_id="$(megabrain_ensure_superset_project "$repo_path")" || return 1
  workspace_id="$(megabrain_workspace_create "$project_id" "$branch" "$slug")" || return 1
  if [ "$json" = true ]; then
    jq -n --arg worktree "$path" --arg branch "$branch" --arg workspace "$workspace_id" \
      '{worktree: $worktree, branch: $branch, workspace: $workspace}'
  else
    printf 'worktree: %s\nbranch: %s\nworkspace: %s\n' "$path" "$branch" "$workspace_id"
  fi
}

command_worktree() {
  local subcommand="${1:-}"
  shift || true
  case "$subcommand" in
    create) megabrain_worktree_create "$@" ;;
    pr|open-pr) megabrain_worktree_pr "$@" ;;
    finish) megabrain_worktree_finish "$@" ;;
    list) megabrain_worktree_list "$@" ;;
    adopt) megabrain_worktree_adopt "$@" ;;
    -h|--help|"")
      megabrain_usage_show worktree
      ;;
    *) megabrain_error "unknown worktree command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

command_terminal() {
  local subcommand="${1:-}"
  shift || true
  case "$subcommand" in
    create) megabrain_terminal_create "$@" ;;
    list) megabrain_terminal_list "$@" ;;
    restart) megabrain_terminal_restart "$@" ;;
    close) megabrain_terminal_close "$@" ;;
    -h|--help|"")
      megabrain_usage_show terminal-create
      printf 'Superset tabs are not titled; only Orca tabs are.\n'
      ;;
    *) megabrain_error "unknown terminal command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

module_worktree_doctor() {
  if ! megabrain_superset_available; then
    megabrain_set_status missing "superset CLI is not on PATH and $HOME/.superset/bin/superset is unavailable"
    return 1
  fi
  if ! megabrain_require_command orca; then
    megabrain_set_status missing "orca CLI is not on PATH"
    return 1
  fi
  local root
  root="$(megabrain_worktree_root --read-only 2>/dev/null || true)"
  if [ -z "$root" ]; then
    megabrain_set_status misconfigured "Superset worktreeBaseDir is unset or unreadable"
    return 1
  fi
  megabrain_set_status ok "$root"
  return 0
}

module_worktree_install() {
  module_worktree_doctor
}
