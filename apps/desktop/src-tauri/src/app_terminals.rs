//! What the app opened on its tmux server. tmux knows a session's name, not what it was opened for,
//! so the title and command are recorded at creation in `app-terminals.json` in the state directory,
//! keyed by session name. `megabrain terminal list --app` reads the same file. The conversation each
//! terminal holds goes to the CLI's conversation registry beside it.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

// The conversation registry the CLI owns (src/core/conversations.ts): one entry per conversation the app
// made. A terminal the app opens is its own `terminal:<id>` entry, or joins its chat's entry when it is
// that chat's terminal mode. The CLI reads the file under a lock directory; this side takes the same lock.
const REGISTRY: &str = "conversations.json";
const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_STALE: Duration = Duration::from_secs(10);

struct RegistryLock(PathBuf);

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn lock_registry(state_dir: &Path) -> Result<RegistryLock, String> {
    std::fs::create_dir_all(state_dir).map_err(|error| format!("could not create state directory: {error}"))?;
    let lock = state_dir.join(format!("{REGISTRY}.lock"));
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match std::fs::create_dir(&lock) {
            Ok(()) => return Ok(RegistryLock(lock)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // A writer that died leaves its lock behind; one older than the stale age is taken over.
                let stale = std::fs::metadata(&lock)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > LOCK_STALE);
                if stale {
                    let _ = std::fs::remove_dir_all(&lock);
                    continue;
                }
                if Instant::now() > deadline {
                    return Err("conversations.json is locked by another writer".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("could not lock conversations.json: {error}")),
        }
    }
}

/// Reads, changes and writes the registry under its lock. A missing file starts empty and without
/// `migratedFrom`, so the CLI's first read still runs its one-time migration and merges this entry in.
/// A file of another version is left alone.
fn update_registry(state_dir: &Path, change: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let _lock = lock_registry(state_dir)?;
    let file = state_dir.join(REGISTRY);
    let mut registry = match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) if map.get("version") == Some(&json!(1)) && map.get("conversations").is_some_and(Value::is_object) => map,
            _ => return Ok(()),
        },
        Err(_) => {
            let mut map = Map::new();
            map.insert("version".into(), json!(1));
            map.insert("conversations".into(), json!({}));
            map.insert("hiddenKeys".into(), json!([]));
            map
        }
    };
    if let Some(Value::Object(conversations)) = registry.get_mut("conversations") {
        change(conversations);
    }
    let temporary = state_dir.join(format!("{REGISTRY}.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&Value::Object(registry)).map_err(|error| error.to_string())?;
    write_private(&temporary, &format!("{text}\n")).map_err(|error| format!("could not write conversations.json: {error}"))?;
    std::fs::rename(&temporary, &file).map_err(|error| format!("could not write conversations.json: {error}"))
}

fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(file)?, text.as_bytes())
}

fn conversation(owner: &str, cwd: &str, chat_id: Option<&str>, tmux: &str, created_at: &str) -> Value {
    json!({ "owner": owner, "cwd": cwd, "aliases": { "chatId": chat_id, "tmux": tmux, "pid": null, "dispatchId": null }, "createdAt": created_at, "hidden": false })
}

/// The session on the app's tmux server the chat's terminal mode last ran in, from the chat's registry entry.
pub fn chat_tmux_alias(state_dir: &Path, chat_id: &str) -> Option<String> {
    let text = std::fs::read_to_string(state_dir.join(REGISTRY)).ok()?;
    let registry = serde_json::from_str::<Value>(&text).ok()?;
    let entry = registry["conversations"].as_object()?.values().find(|entry| entry["aliases"]["chatId"] == json!(chat_id))?;
    let tmux = entry["aliases"]["tmux"].as_str()?;
    let (server, session) = tmux.split_once(':')?;
    (server == "megabrain-app" && !session.is_empty()).then(|| session.to_string())
}

/// Records a tmux terminal the app created (`server:session`). A chat's terminal mode adds the alias
/// to the chat's own entry, so the chat and its TUI stay one conversation.
pub fn record_terminal_conversation(state_dir: &Path, tmux: &str, cwd: &str, created_at: &str, chat_id: Option<&str>) -> Result<(), String> {
    let session = tmux.split_once(':').map_or(tmux, |(_, session)| session);
    let terminal_id = session.strip_prefix("mb-app-").unwrap_or(session).to_string();
    update_registry(state_dir, |conversations| match chat_id {
        Some(chat_id) => {
            let existing = conversations
                .iter()
                .find(|(_, entry)| entry["aliases"]["chatId"] == json!(chat_id))
                .map(|(key, _)| key.clone());
            match existing {
                Some(key) => {
                    if let Some(aliases) = conversations.get_mut(&key).and_then(|entry| entry.get_mut("aliases")).and_then(Value::as_object_mut) {
                        aliases.insert("tmux".into(), json!(tmux));
                    }
                }
                None => {
                    conversations.insert(format!("chat:{chat_id}"), conversation("app-chat", cwd, Some(chat_id), tmux, created_at));
                }
            }
        }
        None => {
            conversations.insert(format!("terminal:{terminal_id}"), conversation("app-terminal", cwd, None, tmux, created_at));
        }
    })
}

/// The terminal was closed: its own conversation goes, and a chat that used it as its terminal mode
/// only loses the alias.
pub fn forget_terminal_conversation(state_dir: &Path, tmux: &str) -> Result<(), String> {
    update_registry(state_dir, |conversations| {
        conversations.retain(|_, entry| !(entry["owner"] == json!("app-terminal") && entry["aliases"]["tmux"] == json!(tmux)));
        for entry in conversations.values_mut() {
            if entry["aliases"]["tmux"] == json!(tmux) {
                if let Some(aliases) = entry.get_mut("aliases").and_then(Value::as_object_mut) {
                    aliases.insert("tmux".into(), Value::Null);
                }
            }
        }
    })
}
