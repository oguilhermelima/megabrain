use serde_json::Value;
use std::path::{Path, PathBuf};

// Whether the idle sweep has anything to do: `native sim idle` only ever shuts down simulators the CLI
// recorded booting, in <state>/native/booted.json, so with none recorded the sweep is skipped without
// starting the CLI or simctl.

/// The megabrain state directory, as the CLI resolves it.
pub fn state_dir() -> Option<PathBuf> {
    std::env::var_os("MEGABRAIN_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".megabrain")))
}

/// True while the CLI has recorded at least one booted simulator. A missing or unreadable record is
/// none, as the CLI itself reads it.
pub fn has_recorded_simulators(state: &Path) -> bool {
    std::fs::read_to_string(state.join("native").join("booted.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|record| record.get("booted").and_then(Value::as_object).map(|booted| !booted.is_empty()))
        .unwrap_or(false)
}
