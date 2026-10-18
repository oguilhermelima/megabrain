use crate::switch_trace::{append_chat_start_trace, append_error_log, append_switch_trace, chat_start_trace_path, error_log_path, switch_trace_path};
use serde_json::json;
use std::fs;

#[test]
fn the_trace_lives_under_the_state_logs() {
    let state = std::path::Path::new("/state");
    assert_eq!(switch_trace_path(state), std::path::PathBuf::from("/state/logs/desktop-switch.log"));
}

#[test]
fn each_switch_appends_one_json_line() {
    let root = std::env::temp_dir().join(format!("megabrain-switch-trace-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let first = json!({ "kind": "chat-switch", "to": "terminal", "steps": { "click": 0, "firstPaint": 1416 } });
    let second = json!({ "kind": "chat-switch", "to": "chat", "steps": { "click": 0, "firstState": 40 } });
    append_switch_trace(&root, &first).expect("first line");
    append_switch_trace(&root, &second).expect("second line");
    let text = fs::read_to_string(switch_trace_path(&root)).expect("log");
    let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).expect("json line")).collect();
    assert_eq!(lines, vec![first, second]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_record_that_is_not_an_object_is_refused() {
    let root = std::env::temp_dir().join(format!("megabrain-switch-trace-refuse-{}", std::process::id()));
    assert!(append_switch_trace(&root, &json!("text")).is_err());
    assert!(!switch_trace_path(&root).exists());
}

#[test]
fn the_chat_start_trace_has_its_own_log_beside_the_switch_one() {
    let state = std::path::Path::new("/state");
    assert_eq!(chat_start_trace_path(state), std::path::PathBuf::from("/state/logs/desktop-chat-start.log"));
}

#[test]
fn each_chat_start_appends_one_json_line_and_leaves_the_switch_log_alone() {
    let root = std::env::temp_dir().join(format!("megabrain-start-trace-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let record = json!({ "kind": "chat-start", "agent": "claude", "steps": { "click": 0, "startReturned": 410 } });
    append_chat_start_trace(&root, &record).expect("line");
    let text = fs::read_to_string(chat_start_trace_path(&root)).expect("log");
    let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).expect("json line")).collect();
    assert_eq!(lines, vec![record]);
    assert!(!switch_trace_path(&root).exists());
    assert!(append_chat_start_trace(&root, &json!(["not", "an", "object"])).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn each_caught_error_appends_one_json_line_to_its_own_log() {
    let root = std::env::temp_dir().join(format!("megabrain-error-log-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    assert_eq!(error_log_path(std::path::Path::new("/state")), std::path::PathBuf::from("/state/logs/desktop-errors.log"));
    let record = json!({ "where": "pane", "item": "launcher:1", "message": "boom" });
    append_error_log(&root, &record).expect("line");
    let text = fs::read_to_string(error_log_path(&root)).expect("log");
    let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).expect("json line")).collect();
    assert_eq!(lines, vec![record]);
    assert!(!switch_trace_path(&root).exists());
    assert!(append_error_log(&root, &json!("text")).is_err());
    let _ = fs::remove_dir_all(root);
}
