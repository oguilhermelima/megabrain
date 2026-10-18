use std::path::Path;
use std::process::{Command, Stdio};

pub const TMUX_SERVER: &str = "megabrain-app";

pub fn tmux_plain_panes_argv() -> [&'static str; 6] {
    [
        "-L",
        TMUX_SERVER,
        "set-window-option",
        "-g",
        "pane-border-status",
        "off",
    ]
}

pub fn configure_tmux_plain_panes(tmux: &Path, cli_path: &str) -> Result<(), String> {
    let output = Command::new(tmux)
        .args(tmux_plain_panes_argv())
        .env("PATH", cli_path)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not configure tmux panes: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "could not disable tmux pane top bars: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
