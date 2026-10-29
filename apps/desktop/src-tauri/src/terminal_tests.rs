use crate::app_terminals::{forget_terminal_conversation, iso_utc, record_app_terminal, record_terminal_conversation};
use crate::app_terminals::chat_tmux_alias;
use crate::terminal::{
    app_owned_session, close_action, encode_output, holder_in_listing, live_chat_holder, native_argv,
    resumed_session, tmux_attach_argv, tmux_create_argv, tmux_kill_session_argv, tmux_server_name,
    CloseAction, CloseReason, Engine, OutputBatcher, PendingOutput, PtyProcess,
};
use crate::terminal_tmux_config::tmux_plain_panes_argv;
use std::io::Read;
use std::process::Command;
use std::time::{Duration, Instant};

#[test]
fn output_batches_flush_at_the_size_limit_and_after_the_time_limit() {
    let start = Instant::now();
    let mut batcher = OutputBatcher::default();
    assert!(batcher.push(&vec![b'x'; 48 * 1024], start).is_none());
    assert_eq!(batcher.push(&vec![b'y'; 20 * 1024], start), Some(vec![b'x'; 48 * 1024].into_iter().chain(vec![b'y'; 16 * 1024]).collect()));
    assert_eq!(batcher.take_pending(), vec![b'y'; 4 * 1024]);

    let mut batcher = OutputBatcher::default();
    assert!(batcher.push(b"ready", start).is_none());
    assert_eq!(batcher.flush_if_due(start + Duration::from_millis(8)), Some(b"ready".to_vec()));
}

#[test]
fn terminal_output_is_base64_framed_for_the_channel() {
    assert_eq!(encode_output(b"hello\r\n"), "aGVsbG8NCg==");
}

#[test]
fn output_before_the_first_listener_keeps_only_the_last_256_kibibytes() {
    let mut pending = PendingOutput::default();
    pending.push(&vec![b'a'; 200 * 1024]);
    pending.push(&vec![b'b'; 100 * 1024]);
    let chunks = pending.drain();
    let output = chunks.concat();

    assert_eq!(output.len(), 256 * 1024);
    assert!(output[..156 * 1024].iter().all(|byte| *byte == b'a'));
    assert!(output[156 * 1024..].iter().all(|byte| *byte == b'b'));
    assert!(chunks.iter().all(|chunk| chunk.len() <= 64 * 1024));
}

#[test]
fn native_engine_uses_the_requested_command_or_login_shell() {
    assert_eq!(native_argv(Some(&["/bin/echo".into(), "hello world".into()]), "/bin/zsh"), ("/bin/echo".into(), vec!["hello world".into()]));
    assert_eq!(native_argv(None, "/bin/zsh"), ("/bin/zsh".into(), vec![]));
}

#[test]
fn tmux_engine_builds_private_server_commands_for_new_and_existing_sessions() {
    assert_eq!(tmux_server_name(), "megabrain-app");
    assert_eq!(tmux_plain_panes_argv(), ["-L", "megabrain-app", "set-window-option", "-g", "pane-border-status", "off"]);
    assert_eq!(
        tmux_create_argv("megabrain-app", "term-test", "/tmp/work", None, Some(&["/bin/zsh".into(), "-l".into()]), false),
        ["-L", "megabrain-app", "new-session", "-d", "-s", "term-test", "-c", "/tmp/work", "/bin/zsh", "-l"]
    );
    // The session starts at the view's size, so the agent's TUI paints once instead of again on attach.
    assert_eq!(
        tmux_create_argv("megabrain-app", "term-test", "/tmp/work", Some((132, 40)), Some(&["claude".into()]), false),
        ["-L", "megabrain-app", "new-session", "-d", "-s", "term-test", "-x", "132", "-y", "40", "-c", "/tmp/work", "claude"]
    );
    assert_eq!(
        tmux_create_argv("megabrain-app", "term-test", "/tmp/work", None, Some(&["claude".into()]), false, Some("chat-123")),
        ["-L", "megabrain-app", "new-session", "-d", "-s", "term-test", "-e", "MEGABRAIN_CONTEXT_INJECTED=1", "-e", "MEGABRAIN_CHAT_ID=chat-123", "-c", "/tmp/work", "claude"]
    );
    assert_eq!(
        tmux_attach_argv(Some("private-test"), "existing"),
        ["-L", "private-test", "attach-session", "-t", "existing"]
    );
    assert_eq!(tmux_attach_argv(None, "existing"), ["attach-session", "-t", "existing"]);
}

#[test]
fn chat_tmux_sessions_keep_the_exited_pane_and_its_output() {
    let server = format!("mb-chat-exit-{}", uuid::Uuid::new_v4());
    let _server = PrivateTmuxServer(server.clone());
    let session = "mb-app-exit-test";
    let command = ["/bin/sh", "-c", "printf 'agent-output-marker\\n'; exit 7"].map(String::from);
    let created = Command::new("tmux")
        .args(tmux_create_argv(&server, session, "/tmp", None, Some(&command), true))
        .status()
        .expect("tmux must be installed for the private-server test");
    assert!(created.success());

    let deadline = Instant::now() + Duration::from_secs(2);
    let pane = loop {
        let listed = Command::new("tmux")
            .args(["-L", &server, "list-panes", "-t", session, "-F", "#{pane_id}"])
            .output()
            .unwrap();
        assert!(listed.status.success(), "the chat pane should survive its command: {}", String::from_utf8_lossy(&listed.stderr));
        let value = String::from_utf8_lossy(&listed.stdout).trim().to_string();
        assert!(!value.is_empty(), "tmux returned no pane id");
        let status = Command::new("tmux")
            .args(["-L", &server, "list-panes", "-t", &value, "-F", "#{pane_dead}\t#{pane_dead_status}"])
            .output()
            .unwrap();
        assert!(status.status.success());
        let status = String::from_utf8_lossy(&status.stdout).trim().to_string();
        if status.starts_with("1\t") { break (value, status); }
        assert!(Instant::now() < deadline, "the pane did not exit: {status:?}");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(pane.1, "1\t7");
    let captured = Command::new("tmux")
        .args(["-L", &server, "capture-pane", "-p", "-S", "-", "-t", &pane.0])
        .output()
        .unwrap();
    assert!(captured.status.success());
    assert!(String::from_utf8_lossy(&captured.stdout).contains("agent-output-marker"));
}

#[test]
fn closing_kills_the_process_or_the_tmux_session_and_quitting_only_detaches() {
    assert_eq!(close_action(Engine::Native, CloseReason::Closed), CloseAction::KillProcessTree);
    assert_eq!(close_action(Engine::Native, CloseReason::AppQuit), CloseAction::KillProcessTree);
    assert_eq!(close_action(Engine::Tmux, CloseReason::Closed), CloseAction::KillSession);
    assert_eq!(close_action(Engine::Tmux, CloseReason::AppQuit), CloseAction::DetachClient);
}

#[test]
fn only_sessions_on_the_app_server_with_the_app_prefix_may_be_killed() {
    assert!(app_owned_session(Some("megabrain-app"), "mb-app-1234"));
    assert!(!app_owned_session(None, "mb-app-1234"));
    assert!(!app_owned_session(Some("default"), "mb-app-1234"));
    assert!(!app_owned_session(Some("megabrain-app"), "work"));
}

#[test]
fn close_kills_owned_session_names_on_the_app_server_and_never_default_server_sessions() {
    assert!(app_owned_session(Some("megabrain-app"), "mb-claude-0f3a9c12"));
    assert!(app_owned_session(Some("megabrain-app"), "mb-codex-1234"));
    assert!(!app_owned_session(None, "mb-claude-0f3a9c12"));
    assert!(!app_owned_session(Some("default"), "mb-claude-0f3a9c12"));
    assert!(!app_owned_session(Some("megabrain-app"), "mb-"));
}

#[test]
fn kill_session_matches_the_name_exactly_on_the_named_server() {
    assert_eq!(
        tmux_kill_session_argv("megabrain-app", "mb-app-1"),
        ["-L", "megabrain-app", "kill-session", "-t", "=mb-app-1"]
    );
}

#[test]
fn kill_session_argv_removes_a_session_on_a_private_server_and_spares_its_neighbour() {
    let server = format!("mb-desktop-test-{}", uuid::Uuid::new_v4());
    let _server = PrivateTmuxServer(server.clone());
    for session in ["mb-app-keep", "mb-app-keep-longer"] {
        let created = Command::new("tmux")
            .args(["-L", &server, "new-session", "-d", "-s", session, "/bin/sleep", "30"])
            .status()
            .expect("tmux must be installed for the private-server test");
        assert!(created.success());
    }
    let killed = Command::new("tmux").args(tmux_kill_session_argv(&server, "mb-app-keep")).status().unwrap();
    assert!(killed.success());
    let listing = Command::new("tmux").args(["-L", &server, "list-sessions", "-F", "#{session_name}"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&listing.stdout).trim(), "mb-app-keep-longer");
}

#[test]
fn creation_time_is_written_as_iso_utc() {
    assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_utc(1_760_000_000), "2025-10-09T08:53:20.000Z");
}

#[test]
fn app_terminal_records_keep_earlier_entries_in_the_shape_the_cli_reads() {
    let state = std::env::temp_dir().join(format!("mb-app-records-{}", uuid::Uuid::new_v4()));
    record_app_terminal(&state, "mb-app-one", "claude", "claude --resume x", "/work", "2026-10-15T10:00:00.000Z").unwrap();
    record_app_terminal(&state, "mb-app-two", "zsh", "", "/work", "2026-10-15T10:01:00.000Z").unwrap();
    let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(state.join("app-terminals.json")).unwrap()).unwrap();
    assert_eq!(written["mb-app-one"], serde_json::json!({"title": "claude", "command": "claude --resume x", "cwd": "/work", "createdAt": "2026-10-15T10:00:00.000Z"}));
    assert_eq!(written["mb-app-two"]["title"], "zsh");
    let _ = std::fs::remove_dir_all(&state);
}

fn registry_at(state: &std::path::Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(state.join("conversations.json")).unwrap()).unwrap()
}

fn write_registry(state: &std::path::Path, value: serde_json::Value) {
    std::fs::create_dir_all(state).unwrap();
    std::fs::write(state.join("conversations.json"), value.to_string()).unwrap();
}

#[test]
fn a_terminal_the_app_opens_is_one_conversation_in_the_registry() {
    let state = std::env::temp_dir().join(format!("mb-app-registry-{}", uuid::Uuid::new_v4()));
    write_registry(&state, serde_json::json!({"version": 1, "conversations": {}, "hiddenKeys": ["claude:hidden"], "migratedFrom": ["chats"]}));
    record_terminal_conversation(&state, "megabrain-app:mb-app-1234", "/work", "2026-10-16T10:00:00.000Z", None).unwrap();
    let written = registry_at(&state);
    assert_eq!(
        written["conversations"]["terminal:1234"],
        serde_json::json!({"owner": "app-terminal", "cwd": "/work", "aliases": {"chatId": null, "tmux": "megabrain-app:mb-app-1234", "pid": null, "dispatchId": null}, "createdAt": "2026-10-16T10:00:00.000Z", "hidden": false})
    );
    assert_eq!(written["hiddenKeys"], serde_json::json!(["claude:hidden"]));
    assert_eq!(written["migratedFrom"], serde_json::json!(["chats"]));
    assert!(!state.join("conversations.json.lock").exists());
    let _ = std::fs::remove_dir_all(&state);
}

#[test]
fn a_registry_not_written_yet_leaves_the_migration_to_the_cli() {
    let state = std::env::temp_dir().join(format!("mb-app-registry-{}", uuid::Uuid::new_v4()));
    record_terminal_conversation(&state, "megabrain-app:mb-app-1", "/work", "2026-10-16T10:00:00.000Z", None).unwrap();
    let written = registry_at(&state);
    assert_eq!(written["version"], 1);
    assert_eq!(written["conversations"]["terminal:1"]["owner"], "app-terminal");
    assert!(written.get("migratedFrom").is_none());
    let _ = std::fs::remove_dir_all(&state);
}

#[test]
fn a_chat_terminal_joins_the_chat_conversation_instead_of_a_record_of_its_own() {
    let state = std::env::temp_dir().join(format!("mb-app-registry-{}", uuid::Uuid::new_v4()));
    write_registry(&state, serde_json::json!({"version": 1, "hiddenKeys": [], "migratedFrom": [], "conversations": {
        "claude:s1": {"owner": "app-chat", "cwd": "/work", "aliases": {"chatId": "chat-1", "tmux": null, "pid": null, "dispatchId": null}, "createdAt": "2026-10-16T09:00:00.000Z", "hidden": false}
    }}));
    record_terminal_conversation(&state, "megabrain-app:mb-app-tui", "/work", "2026-10-16T10:00:00.000Z", Some("chat-1")).unwrap();
    record_terminal_conversation(&state, "megabrain-app:mb-app-new", "/work", "2026-10-16T10:00:00.000Z", Some("chat-2")).unwrap();
    let conversations = registry_at(&state)["conversations"].clone();
    assert_eq!(conversations["claude:s1"]["aliases"]["tmux"], "megabrain-app:mb-app-tui");
    assert_eq!(conversations["chat:chat-2"]["owner"], "app-chat");
    assert_eq!(conversations["chat:chat-2"]["aliases"]["chatId"], "chat-2");
    assert_eq!(conversations["chat:chat-2"]["aliases"]["tmux"], "megabrain-app:mb-app-new");
    assert_eq!(conversations.as_object().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(&state);
}

#[test]
fn closing_drops_the_terminal_conversation_and_a_chat_keeps_its_own() {
    let state = std::env::temp_dir().join(format!("mb-app-registry-{}", uuid::Uuid::new_v4()));
    let alias = |tmux: &str, owner: &str, chat: serde_json::Value| serde_json::json!({"owner": owner, "cwd": "/work", "aliases": {"chatId": chat, "tmux": tmux, "pid": null, "dispatchId": null}, "createdAt": "2026-10-16T09:00:00.000Z", "hidden": false});
    write_registry(&state, serde_json::json!({"version": 1, "hiddenKeys": [], "migratedFrom": [], "conversations": {
        "terminal:a": alias("megabrain-app:mb-app-a", "app-terminal", serde_json::Value::Null),
        "claude:promoted": alias("megabrain-app:mb-app-b", "app-terminal", serde_json::Value::Null),
        "claude:chat": alias("megabrain-app:mb-app-c", "app-chat", serde_json::json!("chat-1")),
        "codex:other": alias("megabrain-app:mb-app-other", "app-terminal", serde_json::Value::Null)
    }}));
    forget_terminal_conversation(&state, "megabrain-app:mb-app-a").unwrap();
    forget_terminal_conversation(&state, "megabrain-app:mb-app-b").unwrap();
    forget_terminal_conversation(&state, "megabrain-app:mb-app-c").unwrap();
    let conversations = registry_at(&state)["conversations"].clone();
    let mut keys: Vec<_> = conversations.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["claude:chat", "codex:other"]);
    assert_eq!(conversations["claude:chat"]["aliases"]["tmux"], serde_json::Value::Null);
    let _ = std::fs::remove_dir_all(&state);
}

#[test]
fn a_real_pty_returns_echo_output() {
    let mut pty = PtyProcess::spawn(&["/bin/echo", "pty-output"], 80, 24).unwrap();
    let mut output = String::new();
    pty.reader().read_to_string(&mut output).unwrap();
    assert!(output.contains("pty-output"), "PTY returned {output:?}");
    assert_eq!(pty.wait().unwrap().code(), Some(0));
}

#[test]
fn tmux_argv_runs_against_a_private_server_created_and_killed_by_the_test() {
    let server = format!("mb-desktop-test-{}", uuid::Uuid::new_v4());
    let session = "contract-test";
    let mut start = Command::new("tmux");
    start.args(["-L", &server, "new-session", "-d", "-s", session, "-c", "/tmp", "/bin/sleep", "30"]);
    let created = start.status().expect("tmux must be installed for the private-server test");
    assert!(created.success());
    let _server = PrivateTmuxServer(server.clone());

    let attached = Command::new("tmux").args(tmux_attach_argv(Some(&server), session)).get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert_eq!(attached, ["-L", server.as_str(), "attach-session", "-t", session]);
}

#[test]
fn a_tui_command_names_the_session_it_resumes() {
    let claude = ["claude", "--resume", "3968e673", "--dangerously-skip-permissions"].map(String::from);
    let codex = ["codex", "resume", "019a-thread", "--dangerously-bypass-approvals-and-sandbox"].map(String::from);
    assert_eq!(resumed_session(&claude), Some("3968e673"));
    assert_eq!(resumed_session(&codex), Some("019a-thread"));
    assert_eq!(resumed_session(&["claude".to_string()]), None);
    assert_eq!(resumed_session(&["claude".to_string(), "--resume".to_string()]), None);
}

#[test]
fn the_chat_keeps_its_own_terminal_else_the_newest_one_resuming_its_session() {
    // Measured on 2026-10-16: three app sessions resumed one chat's session after three relaunches.
    let listing = "mb-app-4b67\t1792203534\tclaude --resume 3968e673 --dangerously-skip-permissions --model \"claude-opus-5-5[1m]\"\n\
mb-app-9d71\t1792204137\tclaude --resume 3968e673 --dangerously-skip-permissions\n\
mb-app-other\t1792204999\tclaude --resume 11111111\n\
mb-app-shell\t1792205000\t/bin/zsh\n";
    assert_eq!(holder_in_listing(listing, Some("3968e673"), Some("mb-app-4b67")), Some("mb-app-4b67".into()));
    assert_eq!(holder_in_listing(listing, Some("3968e673"), Some("mb-app-gone")), Some("mb-app-9d71".into()));
    assert_eq!(holder_in_listing(listing, Some("3968e673"), None), Some("mb-app-9d71".into()));
    // A TUI opened without a session is found only through the chat's own alias.
    assert_eq!(holder_in_listing(listing, None, Some("mb-app-shell")), Some("mb-app-shell".into()));
    assert_eq!(holder_in_listing(listing, None, None), None);
    assert_eq!(holder_in_listing(listing, Some("22222222"), None), None);
}

#[test]
fn restore_reattaches_to_the_live_tmux_session_instead_of_resuming_again() {
    let server = format!("mb-desktop-test-{}", uuid::Uuid::new_v4());
    let _server = PrivateTmuxServer(server.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let created = Command::new("tmux")
        .args(["-L", &server, "new-session", "-d", "-s", "mb-app-live", "/bin/sh", "-c", "sleep 30", "--resume", &id])
        .status()
        .expect("tmux must be installed for the private-server test");
    assert!(created.success());
    let tmux = std::path::PathBuf::from(String::from_utf8_lossy(&Command::new("sh").args(["-c", "command -v tmux"]).output().unwrap().stdout).trim().to_string());

    assert_eq!(live_chat_holder(&tmux, &server, Some(&id), None), Some("mb-app-live".into()));
    assert_eq!(live_chat_holder(&tmux, &server, Some("not-running"), None), None);
    // With the server gone nothing holds the session, and a resume is the only way back.
    let _ = Command::new("tmux").args(["-L", &server, "kill-server"]).status();
    assert_eq!(live_chat_holder(&tmux, &server, Some(&id), None), None);
}

#[test]
fn the_chat_alias_is_read_back_from_the_conversation_registry() {
    let state = std::env::temp_dir().join(format!("mb-app-alias-{}", uuid::Uuid::new_v4()));
    record_terminal_conversation(&state, "megabrain-app:mb-app-first", "/work", "2026-10-15T10:00:00.000Z", Some("chat-1")).unwrap();
    assert_eq!(chat_tmux_alias(&state, "chat-1"), Some("mb-app-first".into()));
    assert_eq!(chat_tmux_alias(&state, "chat-2"), None);
    let _ = std::fs::remove_dir_all(&state);
}

struct PrivateTmuxServer(String);

impl Drop for PrivateTmuxServer {
    fn drop(&mut self) {
        let _ = Command::new("tmux").args(["-L", &self.0, "kill-server"]).status();
    }
}

#[test]
fn native_pty_channel_throughput_is_measured_for_two_seconds() {
    let mut pty = PtyProcess::spawn(&["/usr/bin/yes"], 120, 40).unwrap();
    let mut received = 0_u64;
    let start = Instant::now();
    let deadline = start + Duration::from_secs(2);
    let mut reader = pty.reader();
    let mut buffer = [0_u8; 64 * 1024];
    let mut batcher = OutputBatcher::default();
    while Instant::now() < deadline {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if let Some(batch) = batcher.push(&buffer[..count], Instant::now()) {
                    let channel_payload = encode_output(&batch);
                    assert!(!channel_payload.is_empty());
                    received += batch.len() as u64;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => panic!("PTY channel read failed: {error}"),
        }
    }
    drop(reader);
    if let Some(batch) = batcher.flush_pending() {
        let channel_payload = encode_output(&batch);
        assert!(!channel_payload.is_empty());
        received += batch.len() as u64;
    }
    pty.kill().unwrap();
    let elapsed = start.elapsed().as_secs_f64();
    println!("native terminal channel throughput: {:.0} bytes/s", received as f64 / elapsed);
    assert!(received > 0, "native PTY delivered no channel bytes");
}
