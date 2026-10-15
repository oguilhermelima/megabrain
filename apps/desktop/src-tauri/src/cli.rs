//! Running the bundled CLI. The app holds no megabrain logic: every read is `megabrain … --json` and
//! every action is a megabrain verb, run with the app's own assets and the person's login PATH.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const PATH_START: &str = "__MEGABRAIN_PATH_START__";
pub const PATH_END: &str = "__MEGABRAIN_PATH_END__";

/// Every variable megabrain reads to tell who is calling. The app is the operator: started from a
/// terminal where an agent runs, it must not act as that agent's session or as one of its children.
const IDENTITY_ENV: &[&str] = &[
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
];

pub fn cli_command(executable: &Path, root: &Path, path: &str, args: &[&str]) -> Command {
    let mut command = Command::new(executable);
    command.args(args).env("MEGABRAIN_ROOT", root).env("PATH", path).stdin(Stdio::null());
    for key in IDENTITY_ENV {
        command.env_remove(key);
    }
    command
}

pub fn path_from_shell_output(output: &str) -> Option<String> {
    let start = output.find(PATH_START)? + PATH_START.len();
    let end = start + output[start..].find(PATH_END)?;
    let path = output[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// The login PATH first, then whatever the app was started with, each directory once.
pub fn merge_path(login: Option<&str>, current: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for dir in login.unwrap_or("").split(':').chain(current.split(':')) {
        if !dir.is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    seen.join(":")
}

/// A GUI app gets a bare PATH (on macOS /usr/bin:/bin:/usr/sbin:/sbin), so tmux, git and the agents
/// would all look missing. Ask the person's login shell for theirs; give up after a few seconds.
pub fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|shell| !shell.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let script = format!("printf '%s%s%s' '{PATH_START}' \"$PATH\" '{PATH_END}'");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    path_from_shell_output(&String::from_utf8_lossy(&output.stdout))
}
