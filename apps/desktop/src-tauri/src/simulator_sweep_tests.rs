use crate::simulator_sweep::has_recorded_simulators;
use std::fs;
use std::path::PathBuf;

fn state_dir(name: &str, booted_json: Option<&str>) -> PathBuf {
    let root = std::env::temp_dir().join(format!("megabrain-sweep-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("native")).expect("state dir created");
    if let Some(text) = booted_json {
        fs::write(root.join("native").join("booted.json"), text).expect("booted.json written");
    }
    root
}

#[test]
fn sweeps_while_megabrain_has_recorded_a_booted_simulator() {
    let root = state_dir("booted", Some(r#"{"version":1,"booted":{"401F3DA8":"2026-10-19T10:00:00.000Z"},"asleep":[],"seenAt":null}"#));
    assert!(has_recorded_simulators(&root));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn skips_the_sweep_with_no_recorded_simulator() {
    let none = state_dir("none", None);
    assert!(!has_recorded_simulators(&none));
    let empty = state_dir("empty", Some(r#"{"version":1,"booted":{},"asleep":["110E1BF2"],"seenAt":null}"#));
    assert!(!has_recorded_simulators(&empty));
    // The CLI reads a file it cannot parse as nothing booted, so there is nothing to sweep either.
    let broken = state_dir("broken", Some("{not json"));
    assert!(!has_recorded_simulators(&broken));
    for root in [none, empty, broken] {
        let _ = fs::remove_dir_all(&root);
    }
}
