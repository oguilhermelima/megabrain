use megabrain_desktop_lib::cli::{cli_command, merge_path, path_from_shell_output, PATH_END, PATH_START};
use std::ffi::OsStr;
use std::path::Path;

#[test]
fn the_cli_runs_with_the_bundled_assets_and_the_given_path() {
    let command = cli_command(Path::new("/app/megabrain-cli"), Path::new("/app/Resources/megabrain"), "/opt/homebrew/bin:/usr/bin", &["status", "--json"]);
    let envs: Vec<_> = command.get_envs().collect();
    assert!(envs.contains(&(OsStr::new("MEGABRAIN_ROOT"), Some(OsStr::new("/app/Resources/megabrain")))));
    assert!(envs.contains(&(OsStr::new("PATH"), Some(OsStr::new("/opt/homebrew/bin:/usr/bin")))));
    assert_eq!(command.get_program(), "/app/megabrain-cli");
    assert_eq!(command.get_args().collect::<Vec<_>>(), ["status", "--json"]);
}

// Started from a terminal where an agent runs, the app would otherwise inherit that agent's session
// and act as it. The app is the operator, never an agent session or a child.
#[test]
fn the_cli_never_inherits_an_agent_or_child_identity() {
    let command = cli_command(Path::new("/x"), Path::new("/r"), "/usr/bin", &[]);
    let removed: Vec<_> = command.get_envs().filter(|(_, value)| value.is_none()).map(|(key, _)| key.to_string_lossy().into_owned()).collect();
    // Every variable megabrain reads to tell who is calling (src/core/context.ts and friends).
    for key in [
        "MEGABRAIN_DISPATCH_ID",
        "MEGABRAIN_SESSION_ID",
        "MEGABRAIN_SESSION_HOST",
        "AI_AGENT",
        "CLAUDE_CODE_SESSION_ID",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
        "GROK_AGENT",
        "GROK_LEADER_SOCKET",
        "GROK_SESSION_ID",
        "ANTIGRAVITY_AGENT",
        "ANTIGRAVITY_CONVERSATION_ID",
        "ANTIGRAVITY_CSRF_TOKEN",
        "ANTIGRAVITY_LS_ADDRESS",
        "ANTIGRAVITY_LS_VERSION",
        "ORCA_AGENT_SESSION_SPAWN_TOKEN",
        "ORCA_STRUCTURED_SESSION",
        "ORCA_TERMINAL_HANDLE",
        "SUPERSET_AGENT_EFFORT",
        "SUPERSET_AGENT_ID",
        "SUPERSET_AGENT_MODEL",
        "SUPERSET_TERMINAL_ID",
        "SUPERSET_WORKSPACE_ID",
        "TMUX",
        "TMUX_PANE",
    ] {
        assert!(removed.contains(&key.to_string()), "{key} must be removed");
    }
}

#[test]
fn the_login_path_is_read_between_markers_ignoring_shell_noise() {
    let output = format!("Last login: today\nwelcome banner\n{PATH_START}/opt/homebrew/bin:/usr/bin{PATH_END}\nbye\n");
    assert_eq!(path_from_shell_output(&output).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
    assert_eq!(path_from_shell_output("no markers here"), None);
    assert_eq!(path_from_shell_output(&format!("{PATH_START}{PATH_END}")), None);
}

#[test]
fn the_login_path_comes_first_and_the_rest_is_kept_once() {
    assert_eq!(merge_path(Some("/opt/homebrew/bin:/usr/bin"), "/usr/bin:/bin"), "/opt/homebrew/bin:/usr/bin:/bin");
    assert_eq!(merge_path(None, "/usr/bin:/bin"), "/usr/bin:/bin");
}
