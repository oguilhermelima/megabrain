use crate::app_terminals::{iso_utc, record_app_terminal};
use crate::terminal::{
    app_owned_session, close_action, encode_output, native_argv, tmux_attach_argv,
    tmux_create_argv, tmux_kill_session_argv, tmux_server_name, CloseAction, CloseReason, Engine,
    OutputBatcher, PendingOutput, PtyProcess,
};
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
    assert_eq!(
        tmux_create_argv("megabrain-app", "term-test", "/tmp/work", Some(&["/bin/zsh".into(), "-l".into()])),
        ["-L", "megabrain-app", "new-session", "-d", "-s", "term-test", "-c", "/tmp/work", "/bin/zsh", "-l"]
    );
    assert_eq!(
        tmux_attach_argv(Some("private-test"), "existing"),
        ["-L", "private-test", "attach-session", "-t", "existing"]
    );
    assert_eq!(tmux_attach_argv(None, "existing"), ["attach-session", "-t", "existing"]);
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
    assert!(!app_owned_session(Some("megabrain-app"), "mb-claude-1234"));
    assert!(!app_owned_session(Some("megabrain-app"), "work"));
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
