pub mod cli;
pub mod path_link;
mod pill;
mod tray;

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{Emitter, Manager, RunEvent, State, WindowEvent};

/// Where the bundled CLI and its assets are, and the PATH it runs with.
struct Cli {
    executable: PathBuf,
    root: PathBuf,
    path: String,
}

impl Cli {
    fn command(&self, args: &[String]) -> std::process::Command {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        cli::cli_command(&self.executable, &self.root, &self.path, &args)
    }
}

#[derive(Serialize)]
struct CliOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
struct CliLine {
    id: String,
    line: String,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".to_string())
}

#[tauri::command]
async fn run_cli(cli: State<'_, Cli>, args: Vec<String>) -> Result<CliOutput, String> {
    let mut command = cli.command(&args);
    tauri::async_runtime::spawn_blocking(move || {
        let output = command.output().map_err(|error| format!("could not run megabrain: {error}"))?;
        Ok(CliOutput {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Runs the CLI and forwards each stdout line as a `cli-line` event tagged with `id`, for commands
/// that report as they go (`install --json`). Resolves with the exit code and stderr once it ends.
#[tauri::command]
async fn stream_cli(app: tauri::AppHandle, cli: State<'_, Cli>, id: String, args: Vec<String>) -> Result<CliOutput, String> {
    let mut command = cli.command(&args);
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not run megabrain: {error}"))?;
        let stderr = child.stderr.take().map(|stderr| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = std::io::Read::read_to_string(&mut BufReader::new(stderr), &mut text);
                text
            })
        });
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit("cli-line", CliLine { id: id.clone(), line });
            }
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        Ok(CliOutput {
            code: status.code(),
            stdout: String::new(),
            stderr: stderr.and_then(|reader| reader.join().ok()).unwrap_or_default(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn path_link_state(cli: State<'_, Cli>) -> Result<path_link::LinkState, String> {
    Ok(path_link::inspect(&home()?, &cli.path, &cli.executable))
}

#[tauri::command]
fn link_cli(cli: State<'_, Cli>, replace: bool) -> Result<path_link::LinkState, String> {
    path_link::link(&home()?, &cli.path, &cli.executable, replace)
}

#[tauri::command]
fn set_pill_expanded(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    pill::set_expanded(&app, expanded).map_err(|error| error.to_string())
}

#[tauri::command]
fn pill_geometry() -> pill::Geometry {
    pill::geometry()
}

#[tauri::command]
fn open_main(app: tauri::AppHandle) {
    let _ = pill::set_expanded(&app, false);
    show_main(&app);
}

#[tauri::command]
fn set_tray_summary(app: tauri::AppHandle, findings: usize, lines: Vec<String>) -> Result<(), String> {
    tray::update(&app, findings, &lines).map_err(|error| error.to_string())
}

fn sidecar(current_exe: &Path) -> PathBuf {
    current_exe.parent().unwrap_or(Path::new(".")).join("megabrain-cli")
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let executable = sidecar(&std::env::current_exe()?);
            let root = app.path().resource_dir()?.join("megabrain");
            let current = std::env::var("PATH").unwrap_or_default();
            let path = cli::merge_path(cli::login_path().as_deref(), &current);
            app.manage(Cli { executable, root, path });
            tray::create(app.handle())?;
            pill::setup(app.handle())?;
            Ok(())
        })
        // ⌥Space opens and closes the assistant from anywhere. Another app may own it already; the
        // pill and the tray still work without it.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("Alt+Space")
                .unwrap_or_else(|_| tauri_plugin_global_shortcut::Builder::new())
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = pill::toggle(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| match event {
            // Closing the main window keeps megabrain in the pill and the tray; Quit ends it.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Like Spotlight, the assistant folds back into the pill when you click elsewhere.
            WindowEvent::Focused(false) if window.label() == pill::LABEL && pill::is_expanded() => {
                let _ = pill::set_expanded(window.app_handle(), false);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            run_cli,
            stream_cli,
            path_link_state,
            link_cli,
            set_tray_summary,
            set_pill_expanded,
            pill_geometry,
            open_main
        ])
        .build(tauri::generate_context!())
        .expect("error while building megabrain desktop");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main(handle);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}
