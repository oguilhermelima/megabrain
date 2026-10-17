mod app_terminals;
pub mod cli;
pub mod code;
mod code_servers;
mod cli_stream;
#[cfg(test)]
mod cli_stream_tests;
mod attachment;
pub mod path_link;
mod process_tree;
mod switch_trace;
mod terminal;
mod tray;
#[cfg(test)]
mod terminal_tests;
#[cfg(test)]
mod switch_trace_tests;
#[cfg(test)]
mod code_tests;

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{ipc::Channel, Emitter, Manager, RunEvent, State, WindowEvent};

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
fn save_attachment(base64: String, extension: String) -> Result<String, String> {
    let state = std::env::var_os("MEGABRAIN_STATE_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|value| PathBuf::from(value).join(".megabrain")))
        .ok_or_else(|| "HOME is not set".to_string())?;
    attachment::save_attachment_to(&state, &base64, &extension).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn switch_trace_log(record: serde_json::Value) -> Result<(), String> {
    let state = app_terminals::state_dir().ok_or_else(|| "HOME is not set".to_string())?;
    switch_trace::append_switch_trace(&state, &record).map(|_| ())
}

#[tauri::command]
fn chat_start_trace_log(record: serde_json::Value) -> Result<(), String> {
    let state = app_terminals::state_dir().ok_or_else(|| "HOME is not set".to_string())?;
    switch_trace::append_chat_start_trace(&state, &record).map(|_| ())
}

#[tauri::command]
fn save_image(path: String, base64: String) -> Result<(), String> {
    attachment::save_image_to(Path::new(&path), &base64)
}

#[tauri::command]
async fn run_cli(app: tauri::AppHandle, cli: State<'_, Cli>, args: Vec<String>) -> Result<CliOutput, String> {
    let mut command = cli.command(&args);
    tauri::async_runtime::spawn_blocking(move || {
        let output = command.output().map_err(|error| format!("could not run megabrain: {error}"))?;
        app.state::<code_servers::CodeServers>().note(&args, output.status.success());
        Ok(CliOutput {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cli_stream(cli: State<'_, Cli>, streams: State<'_, cli_stream::CliStreams>, args: Vec<String>, on_line: Channel<String>) -> Result<String, String> {
    streams.start(cli.command(&args), on_line)
}

#[tauri::command]
fn cli_stream_stop(streams: State<'_, cli_stream::CliStreams>, stream_id: String) {
    streams.stop(&stream_id);
}

// Tauri runs a plain command on the main thread, where it queues behind every other window event.
// Opening spawns processes and closing waits on them, so both run on the blocking pool instead.
#[tauri::command]
async fn terminal_open(
    app: tauri::AppHandle,
    cli: State<'_, Cli>,
    options: terminal::TerminalOpenOptions,
) -> Result<terminal::TerminalSession, String> {
    let path = cli.path.clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<terminal::TerminalManager>().open(&path, options))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn terminal_write(
    terminals: State<'_, terminal::TerminalManager>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    terminals.write(&terminal_id, &data)
}

#[tauri::command]
fn terminal_resize(
    terminals: State<'_, terminal::TerminalManager>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(&terminal_id, cols, rows)
}

/// Closing kills the terminal for good: its process, or its tmux session. A terminal the app does not
/// hold open (one it listed after a restart) is killed through the CLI when `kill` is set.
#[tauri::command]
async fn terminal_close(
    app: tauri::AppHandle,
    cli: State<'_, Cli>,
    terminal_id: String,
    kill: Option<bool>,
) -> Result<(), String> {
    let mut command = cli.command(&["terminal".into(), "close".into(), "--app".into(), terminal_id.clone()]);
    tauri::async_runtime::spawn_blocking(move || {
        let terminals = app.state::<terminal::TerminalManager>();
        if terminals.has(&terminal_id) {
            return terminals.close(&terminal_id);
        }
        if kill != Some(true) {
            return Ok(());
        }
        let output = command.output().map_err(|error| format!("could not run megabrain: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn terminal_listen(
    terminals: State<'_, terminal::TerminalManager>,
    terminal_id: String,
    on_event: Channel<terminal::TerminalEvent>,
) -> Result<(), String> {
    terminals.listen(&terminal_id, on_event)
}

#[tauri::command]
fn terminal_unlisten(
    terminals: State<'_, terminal::TerminalManager>,
    terminal_id: String,
) -> Result<(), String> {
    terminals.unlisten(&terminal_id)
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
fn set_tray_summary(app: tauri::AppHandle, findings: usize, lines: Vec<String>) -> Result<(), String> {
    tray::update(&app, findings, &lines).map_err(|error| error.to_string())
}

fn code_allowed_roots(cli: &Cli) -> Result<Vec<PathBuf>, String> {
    code::allowed_roots(&cli.executable, &cli.root, &cli.path)
}

async fn run_code_blocking<T, F>(cli: State<'_, Cli>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Cli) -> Result<T, String> + Send + 'static,
{
    let cli = Cli {
        executable: cli.executable.clone(),
        root: cli.root.clone(),
        path: cli.path.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || operation(&cli))
        .await
        .map_err(|error| format!("code operation failed to join blocking task: {error}"))?
}

#[tauri::command]
async fn code_tree(cli: State<'_, Cli>, root: String) -> Result<Vec<code::CodeEntry>, String> {
    run_code_blocking(cli, move |cli| {
        let allowed = code_allowed_roots(cli)?;
        code::code_tree(Path::new(&root), &allowed)
    })
    .await
}

#[tauri::command]
async fn code_read(cli: State<'_, Cli>, root: String, path: String) -> Result<code::CodeFile, String> {
    run_code_blocking(cli, move |cli| {
        let allowed = code_allowed_roots(cli)?;
        code::code_read(Path::new(&root), &path, &allowed)
    })
    .await
}

#[tauri::command]
async fn code_changes(cli: State<'_, Cli>, root: String) -> Result<Vec<code::CodeChange>, String> {
    run_code_blocking(cli, move |cli| {
        let allowed = code_allowed_roots(cli)?;
        code::code_changes(Path::new(&root), &allowed)
    })
    .await
}

#[tauri::command]
async fn code_diff(cli: State<'_, Cli>, root: String, path: String) -> Result<code::CodeDiff, String> {
    run_code_blocking(cli, move |cli| {
        let allowed = code_allowed_roots(cli)?;
        code::code_diff(Path::new(&root), &path, &allowed)
    })
    .await
}

#[tauri::command]
async fn code_branch_changes(cli: State<'_, Cli>, root: String, parent: Option<String>) -> Result<code::BranchChanges, String> {
    run_code_blocking(cli, move |cli| {
        let allowed = code_allowed_roots(cli)?;
        code::code_branch_changes(Path::new(&root), parent.as_deref(), &allowed)
    })
    .await
}

#[tauri::command]
async fn code_branch_diff(cli: State<'_, Cli>, root: String, merge_base: String, path: String) -> Result<code::CodeDiff, String> {
    run_code_blocking(cli, move |cli| {
        let allowed = code_allowed_roots(cli)?;
        code::code_branch_diff(Path::new(&root), &merge_base, &path, &allowed)
    })
    .await
}

/// Quitting stops every Code server the app started, all at once, and waits for them.
fn stop_code_servers(app: &tauri::AppHandle) {
    let cli = app.state::<Cli>();
    let stops: Vec<_> = app
        .state::<code_servers::CodeServers>()
        .take()
        .into_iter()
        .filter_map(|root| cli.command(&["code".to_string(), "stop".to_string(), root]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok())
        .collect();
    for mut stop in stops {
        let _ = stop.wait();
    }
}

// Simulators megabrain booted go to sleep when idle (`native sim idle`): checked every minute, and all
// of them when the app quits. It only ever touches a simulator the CLI itself recorded booting.
fn sweep_simulators(app: &tauri::AppHandle, all: bool) {
    let mut args = vec!["native".to_string(), "sim".to_string(), "idle".to_string(), "--sweep".to_string()];
    if all {
        args.push("--all".to_string());
    }
    if let Ok(mut sweep) = app.state::<Cli>().command(&args).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        let _ = sweep.wait();
    }
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
    cli::scrub_agent_env();
    let app = tauri::Builder::default()
        .setup(|app| {
            let executable = sidecar(&std::env::current_exe()?);
            let root = app.path().resource_dir()?.join("megabrain");
            let current = std::env::var("PATH").unwrap_or_default();
            let path = cli::merge_path(cli::login_path().as_deref(), &current);
            app.manage(Cli { executable, root, path });
            app.manage(cli_stream::CliStreams::default());
            app.manage(terminal::TerminalManager::default());
            app.manage(code_servers::CodeServers::default());
            tray::create(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                sweep_simulators(&handle, false);
            });
            Ok(())
        })
        // ⌥Space opens the assistant from anywhere. Another app may own it already; the tray still works without it.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("Alt+Space")
                .unwrap_or_else(|_| tauri_plugin_global_shortcut::Builder::new())
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        show_main(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| match event {
            // Closing the main window keeps megabrain in the tray; Quit ends it.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                window.app_handle().state::<cli_stream::CliStreams>().stop_all();
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            run_cli,
            stream_cli,
            cli_stream,
            cli_stream_stop,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_listen,
            terminal_unlisten,
            path_link_state,
            link_cli,
            set_tray_summary,
            code_tree,
            code_read,
            code_changes,
            code_diff,
            code_branch_changes,
            code_branch_diff,
            save_attachment,
            switch_trace_log,
            chat_start_trace_log,
            save_image
        ])
        .build(tauri::generate_context!())
        .expect("error while building megabrain desktop");
    app.run(|handle, event| {
        if matches!(&event, RunEvent::Exit) {
            handle.state::<cli_stream::CliStreams>().stop_all();
            handle.state::<terminal::TerminalManager>().close_all();
            stop_code_servers(handle);
            sweep_simulators(handle, true);
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = &event {
            show_main(handle);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}
