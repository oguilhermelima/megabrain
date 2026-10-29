use crate::terminal_tmux_config::TMUX_SERVER;
use std::path::Path;
use std::process::{Command, Stdio};

const OWNED_SESSION_PREFIX: &str = "mb-";

/// Only the sessions megabrain created on the app's server may be killed: the app's own `mb-app-<id>`
/// terminals and the `mb-<agent>-<id>` sessions `session own` resumes there. A session on the person's
/// default server that the app merely attached to is detached, never killed.
pub fn app_owned_session(server: Option<&str>, session: &str) -> bool {
    server == Some(TMUX_SERVER)
        && session.len() > OWNED_SESSION_PREFIX.len()
        && session.starts_with(OWNED_SESSION_PREFIX)
}

/// `=` makes tmux match the session name exactly instead of by prefix.
pub fn tmux_kill_session_argv(server: &str, session: &str) -> Vec<String> {
    vec![
        "-L".into(),
        server.into(),
        "kill-session".into(),
        "-t".into(),
        format!("={session}"),
    ]
}

pub fn tmux_server_name() -> &'static str {
    TMUX_SERVER
}

pub fn tmux_create_argv(
    server: &str,
    session: &str,
    cwd: &str,
    size: Option<(u16, u16)>,
    command: Option<&[String]>,
    retain_exit: bool,
    context_chat_id: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-L".into(),
        server.into(),
        "new-session".into(),
        "-d".into(),
        "-s".into(),
        session.into(),
    ];
    // Created at the view's size, the agent's TUI paints once instead of again when the attach resizes it.
    if let Some((cols, rows)) = size {
        args.extend(["-x".into(), cols.to_string(), "-y".into(), rows.to_string()]);
    }
    if let Some(chat_id) = context_chat_id {
        args.extend([
            "-e".into(),
            "MEGABRAIN_CONTEXT_INJECTED=1".into(),
            "-e".into(),
            format!("MEGABRAIN_CHAT_ID={chat_id}"),
        ]);
    }
    args.extend(["-c".into(), cwd.into()]);
    if let Some(command) = command {
        if retain_exit {
            let command = command
                .iter()
                .map(|part| shell_quote(part))
                .collect::<Vec<_>>()
                .join(" ");
            args.push(format!(
                "tmux set-option -w -t \"$TMUX_PANE\" remain-on-exit on && exec {command}"
            ));
        } else {
            args.extend(command.iter().cloned());
        }
    }
    args
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The agent session a TUI command resumes: `claude --resume <id>` or `codex resume <id>`.
pub fn resumed_session(command: &[String]) -> Option<&str> {
    command
        .windows(2)
        .find(|pair| pair[0] == "--resume" || pair[0] == "resume")
        .map(|pair| pair[1].as_str())
        .filter(|id| !id.is_empty() && !id.starts_with('-'))
}

/// From `list-panes -a -F "#{session_name}\t#{session_created}\t#{pane_start_command}"`: the session that holds a
/// chat's agent session. The chat's own terminal (its alias) first, else the newest one whose command resumes it.
pub fn holder_in_listing(
    listing: &str,
    session_id: Option<&str>,
    alias: Option<&str>,
) -> Option<String> {
    let panes: Vec<(&str, u64, &str)> = listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let name = fields.next()?;
            let created = fields.next()?.parse().unwrap_or(0);
            Some((name, created, fields.next().unwrap_or("")))
        })
        .collect();
    if let Some(alias) = alias.filter(|alias| panes.iter().any(|(name, _, _)| name == alias)) {
        return Some(alias.to_string());
    }
    let session_id = session_id?;
    let resumes = |command: &str| {
        let words: Vec<String> = command
            .split_whitespace()
            .map(|word| word.trim_matches(|c| c == '"' || c == '\'').to_string())
            .collect();
        resumed_session(&words) == Some(session_id)
    };
    panes
        .iter()
        .filter(|(_, _, command)| resumes(command))
        .max_by_key(|(_, created, _)| *created)
        .map(|(name, _, _)| name.to_string())
}

/// The live tmux session on `server` that holds the chat's agent session, if any; no server, no holder.
pub fn live_chat_holder(
    tmux: &Path,
    server: &str,
    session_id: Option<&str>,
    alias: Option<&str>,
) -> Option<String> {
    let output = Command::new(tmux)
        .args([
            "-L",
            server,
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{session_created}\t#{pane_start_command}",
        ])
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    holder_in_listing(&String::from_utf8_lossy(&output.stdout), session_id, alias)
}

pub fn tmux_attach_argv(server: Option<&str>, session: &str) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(server) = server {
        args.extend(["-L".into(), server.into()]);
    }
    args.extend(["attach-session".into(), "-t".into(), session.into()]);
    args
}
