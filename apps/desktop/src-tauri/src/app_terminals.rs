//! What the app opened on its tmux server. tmux knows a session's name, not what it was opened for,
//! so the title and command are recorded at creation in `app-terminals.json` in the state directory,
//! keyed by session name. `megabrain terminal list --app` reads the same file.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "app-terminals.json";

pub fn state_dir() -> Option<PathBuf> {
    std::env::var_os("MEGABRAIN_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".megabrain")))
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SS.000Z`.
pub fn iso_utc(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

pub fn now_iso() -> String {
    iso_utc(SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0))
}

fn read_records(file: &Path) -> Map<String, Value> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn write_records(state_dir: &Path, records: Map<String, Value>) -> Result<(), String> {
    std::fs::create_dir_all(state_dir).map_err(|error| format!("could not create state directory: {error}"))?;
    let file = state_dir.join(FILE);
    let temporary = state_dir.join(format!("{FILE}.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&Value::Object(records)).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, format!("{text}\n")).map_err(|error| format!("could not write app terminal record: {error}"))?;
    std::fs::rename(&temporary, &file).map_err(|error| format!("could not write app terminal record: {error}"))
}

pub fn record_app_terminal(
    state_dir: &Path,
    session: &str,
    title: &str,
    command: &str,
    cwd: &str,
    created_at: &str,
) -> Result<(), String> {
    let mut records = read_records(&state_dir.join(FILE));
    records.insert(session.to_string(), json!({ "title": title, "command": command, "cwd": cwd, "createdAt": created_at }));
    write_records(state_dir, records)
}

pub fn forget_app_terminal(state_dir: &Path, session: &str) -> Result<(), String> {
    let mut records = read_records(&state_dir.join(FILE));
    if records.remove(session).is_none() {
        return Ok(());
    }
    write_records(state_dir, records)
}
