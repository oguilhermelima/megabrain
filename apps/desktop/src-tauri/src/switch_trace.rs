use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Where the app writes how long each chat/terminal switch took: one JSON line per switch.
pub fn switch_trace_path(state_dir: &Path) -> PathBuf {
    state_dir.join("logs").join("desktop-switch.log")
}

/// Appends one switch record as a single JSON line; only an object is a record.
pub fn append_switch_trace(state_dir: &Path, record: &serde_json::Value) -> Result<PathBuf, String> {
    if !record.is_object() {
        return Err("a switch trace record must be a JSON object".into());
    }
    let path = switch_trace_path(state_dir);
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory).map_err(|error| format!("could not create the log directory: {error}"))?;
    }
    let mut line = serde_json::to_string(record).map_err(|error| error.to_string())?;
    line.push('\n');
    // One write per line, so concurrent switches never interleave inside a line.
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .map_err(|error| format!("could not write the switch trace: {error}"))?;
    Ok(path)
}
