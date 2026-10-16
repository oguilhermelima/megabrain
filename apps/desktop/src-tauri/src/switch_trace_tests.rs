use crate::switch_trace::{append_switch_trace, switch_trace_path};
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
