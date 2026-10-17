use crate::app_terminals;
use base64::engine::general_purpose::STANDARD;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use uuid::Uuid;

const MAX_OUTPUT_BATCH: usize = 64 * 1024;
const OUTPUT_BATCH_WINDOW: Duration = Duration::from_millis(8);
const MAX_PRE_LISTEN_OUTPUT: usize = 256 * 1024;
const TMUX_SERVER: &str = "megabrain-app";
const APP_SESSION_PREFIX: &str = "mb-app-";
const OWNED_SESSION_PREFIX: &str = "mb-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Native,
    Tmux,
}

impl Engine {
    fn from_name(value: &str) -> Result<Self, String> {
        match value {
            "native" => Ok(Self::Native),
            "tmux" => Ok(Self::Tmux),
            _ => Err(format!("unknown terminal engine: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    KillProcessTree,
    DetachClient,
    KillSession,
}

/// Why a terminal is going away: the person closed it, or the app is quitting and the tmux sessions
/// should outlive it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Closed,
    AppQuit,
}

pub fn close_action(engine: Engine, reason: CloseReason) -> CloseAction {
    match (engine, reason) {
        (Engine::Native, _) => CloseAction::KillProcessTree,
        (Engine::Tmux, CloseReason::Closed) => CloseAction::KillSession,
        (Engine::Tmux, CloseReason::AppQuit) => CloseAction::DetachClient,
    }
}

/// Only the sessions megabrain created on the app's server may be killed: the app's own `mb-app-<id>`
/// terminals and the `mb-<agent>-<id>` sessions `session own` resumes there. A session on the person's
/// default server that the app merely attached to is detached, never killed.
pub fn app_owned_session(server: Option<&str>, session: &str) -> bool {
    server == Some(TMUX_SERVER) && session.len() > OWNED_SESSION_PREFIX.len() && session.starts_with(OWNED_SESSION_PREFIX)
}

/// `=` makes tmux match the session name exactly instead of by prefix.
pub fn tmux_kill_session_argv(server: &str, session: &str) -> Vec<String> {
    vec!["-L".into(), server.into(), "kill-session".into(), "-t".into(), format!("={session}")]
}

pub fn tmux_server_name() -> &'static str {
    TMUX_SERVER
}

pub fn encode_output(bytes: &[u8]) -> String {
    base64::Engine::encode(&STANDARD, bytes)
}

pub fn native_argv(command: Option<&[String]>, login_shell: &str) -> (String, Vec<String>) {
    match command {
        Some(command) if !command.is_empty() => (command[0].clone(), command[1..].to_vec()),
        _ => (login_shell.to_string(), Vec::new()),
    }
}

pub fn tmux_create_argv(
    server: &str,
    session: &str,
    cwd: &str,
    size: Option<(u16, u16)>,
    command: Option<&[String]>,
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
    args.extend(["-c".into(), cwd.into()]);
    if let Some(command) = command {
        args.extend(command.iter().cloned());
    }
    args
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
pub fn holder_in_listing(listing: &str, session_id: Option<&str>, alias: Option<&str>) -> Option<String> {
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
        let words: Vec<String> = command.split_whitespace().map(|word| word.trim_matches(|c| c == '"' || c == '\'').to_string()).collect();
        resumed_session(&words) == Some(session_id)
    };
    panes
        .iter()
        .filter(|(_, _, command)| resumes(command))
        .max_by_key(|(_, created, _)| *created)
        .map(|(name, _, _)| name.to_string())
}

/// The live tmux session on `server` that holds the chat's agent session, if any; no server, no holder.
pub fn live_chat_holder(tmux: &Path, server: &str, session_id: Option<&str>, alias: Option<&str>) -> Option<String> {
    let output = Command::new(tmux)
        .args(["-L", server, "list-panes", "-a", "-F", "#{session_name}\t#{session_created}\t#{pane_start_command}"])
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

#[derive(Default)]
pub struct OutputBatcher {
    pending: Vec<u8>,
    started: Option<Instant>,
}

impl OutputBatcher {
    pub fn push(&mut self, mut bytes: &[u8], now: Instant) -> Option<Vec<u8>> {
        let mut ready = None;
        while !bytes.is_empty() {
            self.started.get_or_insert(now);
            let available = MAX_OUTPUT_BATCH - self.pending.len();
            let take = available.min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() == MAX_OUTPUT_BATCH {
                ready = Some(self.take_pending());
            }
        }
        ready
    }

    pub fn flush_if_due(&mut self, now: Instant) -> Option<Vec<u8>> {
        self.started
            .filter(|started| now.saturating_duration_since(*started) >= OUTPUT_BATCH_WINDOW)
            .and_then(|_| self.flush_pending())
    }

    pub fn flush_pending(&mut self) -> Option<Vec<u8>> {
        (!self.pending.is_empty()).then(|| self.take_pending())
    }

    pub fn take_pending(&mut self) -> Vec<u8> {
        self.started = None;
        std::mem::take(&mut self.pending)
    }

    fn time_until_flush(&self) -> Duration {
        self.started
            .map(|started| OUTPUT_BATCH_WINDOW.saturating_sub(started.elapsed()))
            .unwrap_or(OUTPUT_BATCH_WINDOW)
    }
}

#[derive(Default)]
pub struct PendingOutput {
    chunks: VecDeque<Vec<u8>>,
    byte_len: usize,
}

impl PendingOutput {
    pub fn push(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let take = MAX_OUTPUT_BATCH.min(bytes.len());
            self.chunks.push_back(bytes[..take].to_vec());
            self.byte_len += take;
            bytes = &bytes[take..];
            while self.byte_len > MAX_PRE_LISTEN_OUTPUT {
                let excess = self.byte_len - MAX_PRE_LISTEN_OUTPUT;
                let Some(front) = self.chunks.front_mut() else {
                    break;
                };
                if front.len() <= excess {
                    self.byte_len -= front.len();
                    self.chunks.pop_front();
                } else {
                    front.drain(..excess);
                    self.byte_len -= excess;
                }
            }
        }
    }

    pub fn drain(&mut self) -> Vec<Vec<u8>> {
        self.byte_len = 0;
        self.chunks.drain(..).collect()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub engine: String,
    pub cwd: String,
    pub title: String,
    pub tmux_session: Option<String>,
    /// Native engine only: the process the PTY started, so an agent session it runs can be matched to it.
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit: Option<Option<i32>>,
}

impl TerminalEvent {
    fn data(bytes: &[u8]) -> Self {
        Self {
            data: Some(encode_output(bytes)),
            exit: None,
        }
    }

    fn exit(code: Option<i32>) -> Self {
        Self {
            data: None,
            exit: Some(code),
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenOptions {
    engine: String,
    cwd: String,
    command: Option<Vec<String>>,
    tmux_session: Option<String>,
    /// The chat whose terminal mode this is: its TUI joins the chat's conversation instead of being one of its own.
    chat_id: Option<String>,
    cols: u16,
    rows: u16,
}

/// The tmux session behind a tmux-engine terminal, and the tmux that can kill it.
struct TmuxTarget {
    binary: PathBuf,
    server: Option<String>,
    session: String,
}

struct TerminalProcess {
    engine: Engine,
    tmux: Option<TmuxTarget>,
    state: Mutex<ProcessState>,
}

struct ProcessState {
    master: Box<dyn MasterPty + Send>,
    reader: Option<Box<dyn Read + Send>>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send>,
    channel: Option<Channel<TerminalEvent>>,
    pending: PendingOutput,
    has_listened: bool,
    exited: bool,
    exit_code: Option<Option<i32>>,
    exit_sent: bool,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<TerminalProcess>>>,
}

impl TerminalManager {
    pub fn open(
        &self,
        cli_path: &str,
        options: TerminalOpenOptions,
    ) -> Result<TerminalSession, String> {
        if options.cols == 0 || options.rows == 0 {
            return Err("terminal size must be greater than zero".into());
        }
        let cwd = PathBuf::from(&options.cwd)
            .canonicalize()
            .map_err(|error| format!("could not open terminal directory: {error}"))?;
        if !cwd.is_dir() {
            return Err("terminal cwd must be a directory".into());
        }
        let mut engine = Engine::from_name(&options.engine)?;
        let mut options = options;
        // A chat's terminal outlives the app: reopening it attaches to the TUI still running its session instead of
        // resuming that session in a second process.
        let mut reattached = false;
        if let (Some(chat_id), None) = (options.chat_id.as_deref(), options.tmux_session.as_deref()) {
            let alias = app_terminals::state_dir().and_then(|state| app_terminals::chat_tmux_alias(&state, chat_id));
            let session_id = options.command.as_deref().and_then(resumed_session);
            let holder = find_on_path("tmux", cli_path).and_then(|tmux| live_chat_holder(&tmux, TMUX_SERVER, session_id, alias.as_deref()));
            if let Some(holder) = holder {
                options.tmux_session = Some(format!("{TMUX_SERVER}:{holder}"));
                options.engine = "tmux".into();
                engine = Engine::Tmux;
                reattached = true;
            }
        }
        let id = Uuid::new_v4().to_string();
        let login_shell = std::env::var("SHELL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    "cmd.exe".into()
                } else {
                    "/bin/sh".into()
                }
            });
        let mut tmux_target = None;
        let mut created_session = None;
        let (program, args, tmux_session, title) = match engine {
            Engine::Native => {
                let (program, args) = native_argv(options.command.as_deref(), &login_shell);
                let title = Path::new(&program)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&program)
                    .to_string();
                (program, args, None, title)
            }
            Engine::Tmux => {
                let (server, session) = match options.tmux_session.as_deref() {
                    Some(value) => split_tmux_target(value)?,
                    None => {
                        let session = format!("{APP_SESSION_PREFIX}{id}");
                        create_tmux_session(cli_path, &session, &cwd, (options.cols, options.rows), options.command.as_deref())?;
                        created_session = Some(session.clone());
                        (Some(TMUX_SERVER.to_string()), session)
                    }
                };
                let tmux = find_on_path("tmux", cli_path)
                    .ok_or_else(|| "tmux was not found on the login PATH".to_string())?;
                let args = tmux_attach_argv(server.as_deref(), &session);
                tmux_target = Some(TmuxTarget {
                    binary: tmux.clone(),
                    server: server.clone(),
                    session: session.clone(),
                });
                let title = options
                    .command
                    .as_deref()
                    .and_then(|command| command.first())
                    .map(|value| {
                        Path::new(value)
                            .file_name()
                            .and_then(|part| part.to_str())
                            .unwrap_or(value)
                            .to_string()
                    })
                    .unwrap_or_else(|| "tmux".into());
                (
                    tmux.to_string_lossy().into_owned(),
                    args,
                    Some(options.tmux_session.unwrap_or(session)),
                    title,
                )
            }
        };

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: options.rows,
                cols: options.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("could not create terminal PTY: {error}"))?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(cwd.as_os_str());
        command.env("PATH", cli_path);
        command.env("TERM", "xterm-256color");
        if engine == Engine::Tmux {
            command.env_remove("TMUX");
            command.env_remove("TMUX_PANE");
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("could not start terminal process: {error}"))?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("could not read terminal PTY: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("could not write terminal PTY: {error}"))?;
        if let (true, Some(target), Some(state)) = (reattached, tmux_target.as_ref(), app_terminals::state_dir()) {
            let _ = app_terminals::record_terminal_conversation(
                &state,
                &format!("{TMUX_SERVER}:{}", target.session),
                &cwd.to_string_lossy(),
                &app_terminals::now_iso(),
                options.chat_id.as_deref(),
            );
        }
        if let Some(session) = &created_session {
            // The record only labels the session for the next start; a failed write loses a label,
            // not the terminal.
            if let Some(state) = app_terminals::state_dir() {
                let command = options.command.as_deref().map(|parts| parts.join(" ")).unwrap_or_default();
                let created_at = app_terminals::now_iso();
                let _ = app_terminals::record_app_terminal(
                    &state,
                    session,
                    &title,
                    &command,
                    &cwd.to_string_lossy(),
                    &created_at,
                );
                let _ = app_terminals::record_terminal_conversation(
                    &state,
                    &format!("{TMUX_SERVER}:{session}"),
                    &cwd.to_string_lossy(),
                    &created_at,
                    options.chat_id.as_deref(),
                );
            }
        }
        let pid = if engine == Engine::Native { child.process_id() } else { None };
        let info = TerminalSession {
            id: id.clone(),
            engine: options.engine,
            cwd: cwd.to_string_lossy().into_owned(),
            title,
            tmux_session,
            pid,
        };
        let process = Arc::new(TerminalProcess {
            engine,
            tmux: tmux_target,
            state: Mutex::new(ProcessState {
                master: pair.master,
                reader: Some(reader),
                writer,
                child,
                channel: None,
                pending: PendingOutput::default(),
                has_listened: false,
                exited: false,
                exit_code: None,
                exit_sent: false,
            }),
        });
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, process.clone());
        if let Err(error) = start_output_pump(process.clone()) {
            let _ = self.close(&info.id);
            return Err(error);
        }
        Ok(info)
    }

    pub fn listen(&self, id: &str, channel: Channel<TerminalEvent>) -> Result<(), String> {
        let process = self.get(id)?;
        let mut state = process.state.lock().map_err(|error| error.to_string())?;
        state.channel = Some(channel);
        if !state.has_listened {
            state.has_listened = true;
            let pending = state.pending.drain();
            if let Some(channel) = &state.channel {
                for bytes in pending {
                    channel
                        .send(TerminalEvent::data(&bytes))
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        send_exit_if_ready(&mut state);
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let process = self.get(id)?;
        let mut state = process.state.lock().map_err(|error| error.to_string())?;
        state
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("could not write terminal input: {error}"))?;
        state
            .writer
            .flush()
            .map_err(|error| format!("could not flush terminal input: {error}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("terminal size must be greater than zero".into());
        }
        let process = self.get(id)?;
        let state = process.state.lock().map_err(|error| error.to_string())?;
        state
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("could not resize terminal: {error}"))
    }

    pub fn unlisten(&self, id: &str) -> Result<(), String> {
        let process = self.get(id)?;
        process
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .channel = None;
        Ok(())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let process = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(id);
        if let Some(process) = process {
            close_process(&process, CloseReason::Closed)?;
        }
        Ok(())
    }

    pub fn has(&self, id: &str) -> bool {
        self.sessions.lock().map(|sessions| sessions.contains_key(id)).unwrap_or(false)
    }

    pub fn close_all(&self) {
        let processes = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, process)| process)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for process in processes {
            let _ = close_process(&process, CloseReason::AppQuit);
        }
    }

    fn get(&self, id: &str) -> Result<Arc<TerminalProcess>, String> {
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal not found: {id}"))
    }
}

fn close_process(process: &TerminalProcess, reason: CloseReason) -> Result<(), String> {
    let mut state = process.state.lock().map_err(|error| error.to_string())?;
    if state.exited {
        return Ok(());
    }
    state.channel = None;
    let pid = state.child.process_id();
    match close_action(process.engine, reason) {
        CloseAction::KillProcessTree => {
            if let Some(pid) = pid {
                kill_pty_process_tree(pid);
            }
            let _ = state.child.kill();
            let _ = state.child.wait();
        }
        CloseAction::DetachClient => {
            // The tmux server owns the session; killing only this PTY child detaches its client.
            let _ = state.child.kill();
            let _ = state.child.wait();
        }
        CloseAction::KillSession => {
            if let Some(target) = &process.tmux {
                kill_tmux_session(target);
            }
            let _ = state.child.kill();
            let _ = state.child.wait();
        }
    }
    state.exited = true;
    state.exit_code = Some(None);
    Ok(())
}

fn kill_tmux_session(target: &TmuxTarget) {
    // Attached to a session megabrain did not create, closing the terminal only detaches.
    if !app_owned_session(target.server.as_deref(), &target.session) {
        return;
    }
    let _ = Command::new(&target.binary)
        .args(tmux_kill_session_argv(TMUX_SERVER, &target.session))
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .output();
    if let Some(state) = app_terminals::state_dir() {
        let _ = app_terminals::forget_app_terminal(&state, &target.session);
        let _ = app_terminals::forget_terminal_conversation(&state, &format!("{TMUX_SERVER}:{}", target.session));
    }
}

fn start_output_pump(process: Arc<TerminalProcess>) -> Result<(), String> {
    let reader = process
        .state
        .lock()
        .map_err(|error| error.to_string())?
        .reader
        .take()
        .ok_or_else(|| "terminal output reader is unavailable".to_string())?;
    thread::Builder::new()
        .name("terminal-output".into())
        .spawn(move || {
            let _ = pump_output(reader, |bytes| {
                if let Ok(mut state) = process.state.lock() {
                    if let Some(channel) = &state.channel {
                        let _ = channel.send(TerminalEvent::data(&bytes));
                    } else if !state.has_listened {
                        state.pending.push(&bytes);
                    }
                }
            });
            if let Ok(mut state) = process.state.lock() {
                let status = state.child.wait().ok();
                let code = status.map(|status| status.exit_code() as i32);
                state.exited = true;
                state.exit_code = Some(code);
                send_exit_if_ready(&mut state);
            }
        })
        .map_err(|error| format!("could not start terminal reader: {error}"))?;
    Ok(())
}

fn send_exit_if_ready(state: &mut ProcessState) {
    if state.exit_sent {
        return;
    }
    if let (Some(channel), Some(code)) = (&state.channel, state.exit_code) {
        let _ = channel.send(TerminalEvent::exit(code));
        state.exit_sent = true;
    }
}

fn kill_pty_process_tree(pid: u32) {
    #[cfg(unix)]
    {
        // PTY children are launched in their own session by portable-pty. Signal the whole process
        // group so a shell cannot leave grandchildren running when the terminal is closed.
        // SAFETY: pid is returned by the PTY child handle.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
        }
        thread::sleep(Duration::from_millis(100));
        // SAFETY: same process group as above.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

fn split_tmux_target(value: &str) -> Result<(Option<String>, String), String> {
    let (server, session) = match value.split_once(':') {
        Some((server, session)) if !server.is_empty() && !session.is_empty() => {
            (Some(server.to_string()), session.to_string())
        }
        Some(_) => return Err("tmux session must be session or server:session".into()),
        None if !value.is_empty() => (None, value.to_string()),
        None => return Err("tmux session must not be empty".into()),
    };
    Ok((server, session))
}

fn create_tmux_session(
    cli_path: &str,
    session: &str,
    cwd: &Path,
    size: (u16, u16),
    command: Option<&[String]>,
) -> Result<(), String> {
    let cwd = cwd.to_string_lossy();
    let args = tmux_create_argv(tmux_server_name(), session, &cwd, Some(size), command);
    let tmux = find_on_path("tmux", cli_path)
        .ok_or_else(|| "tmux was not found on the login PATH".to_string())?;
    let output = Command::new(tmux)
        .args(args)
        .env("PATH", cli_path)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not run tmux: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    std::env::split_paths(std::ffi::OsStr::new(path))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn pump_output<R, F>(reader: R, mut send: F) -> io::Result<()>
where
    R: Read + Send + 'static,
    F: FnMut(Vec<u8>),
{
    let (sender, receiver) = mpsc::sync_channel::<io::Result<Vec<u8>>>(8);
    thread::Builder::new()
        .name("terminal-pty-reader".into())
        .spawn(move || {
            let mut reader = reader;
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if sender.send(Ok(buffer[..count].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        })
        .map_err(|error| io::Error::other(format!("could not start PTY reader: {error}")))?;
    let mut batcher = OutputBatcher::default();
    loop {
        match receiver.recv_timeout(batcher.time_until_flush()) {
            Ok(Ok(bytes)) => {
                if let Some(batch) = batcher.push(&bytes, Instant::now()) {
                    send(batch);
                }
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(batch) = batcher.flush_if_due(Instant::now()) {
                    send(batch);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(batch) = batcher.flush_pending() {
                    send(batch);
                }
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
pub struct PtyProcess {
    reader: Option<Box<dyn Read + Send>>,
    child: Box<dyn Child + Send>,
    finished: bool,
}

#[cfg(test)]
impl PtyProcess {
    pub fn spawn(argv: &[&str], cols: u16, rows: u16) -> io::Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(other_io)?;
        let mut command = CommandBuilder::new(
            argv.first()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "command is empty"))?,
        );
        command.args(&argv[1..]);
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command).map_err(other_io)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(other_io)?;
        let _writer = pair.master.take_writer().map_err(other_io)?;
        Ok(Self {
            reader: Some(reader),
            child,
            finished: false,
        })
    }

    pub fn reader(&mut self) -> PtyReader {
        PtyReader(self.reader.take().expect("PTY reader is present"))
    }

    pub fn wait(&mut self) -> io::Result<PtyExitStatus> {
        let status = self.child.wait()?;
        self.finished = true;
        Ok(PtyExitStatus(status))
    }

    pub fn kill(&mut self) -> io::Result<()> {
        if let Some(pid) = self.child.process_id() {
            kill_pty_process_tree(pid);
        }
        let _ = self.child.kill();
        self.child.wait().map(|_| ())?;
        self.finished = true;
        Ok(())
    }
}

#[cfg(test)]
pub struct PtyReader(Box<dyn Read + Send>);

#[cfg(test)]
impl Read for PtyReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}

#[cfg(test)]
pub struct PtyExitStatus(portable_pty::ExitStatus);

#[cfg(test)]
impl PtyExitStatus {
    pub fn code(&self) -> Option<i32> {
        Some(self.0.exit_code() as i32)
    }
}

#[cfg(test)]
fn other_io(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
impl Drop for PtyProcess {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.kill();
        }
    }
}
