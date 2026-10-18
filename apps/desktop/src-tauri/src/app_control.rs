use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[derive(Clone, Default)]
pub struct AppControl {
    #[cfg(unix)]
    writer: Arc<Mutex<Option<UnixStream>>>,
    stopped: Arc<AtomicBool>,
}

impl AppControl {
    pub fn start(&self, app: AppHandle) {
        #[cfg(unix)]
        let writer = self.writer.clone();
        let stopped = self.stopped.clone();
        thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                #[cfg(unix)]
                if let Some(path) = socket_path() {
                    if let Ok(stream) = UnixStream::connect(path) {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                        let mut reader_stream = match stream.try_clone() { Ok(value) => value, Err(_) => { thread::sleep(Duration::from_secs(1)); continue; } };
                        if let Ok(mut out) = stream.try_clone() {
                            if writeln!(out, "{{\"operation\":\"app-connect\"}}").is_ok() {
                                if let Ok(mut state) = writer.lock() { *state = Some(out); }
                                let mut reader = BufReader::new(&mut reader_stream);
                                let mut line = String::new();
                                while !stopped.load(Ordering::Relaxed) {
                                    line.clear();
                                    match reader.read_line(&mut line) {
                                        Ok(0) => break,
                                        Ok(_) => {
                                            let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
                                            if frame.get("event").and_then(Value::as_str) == Some("app-control") {
                                                let _ = app.emit("app-control", frame);
                                            }
                                        }
                                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::TimedOut => continue,
                                        Err(_) => break,
                                    }
                                }
                            }
                        }
                        if let Ok(mut state) = writer.lock() { *state = None; }
                    }
                }
                thread::sleep(Duration::from_secs(1));
            }
        });
    }

    pub fn reply(&self, id: &str, value: Result<Value, String>) -> Result<(), String> {
        #[cfg(unix)]
        {
        let mut guard = self.writer.lock().map_err(|_| "app control connection is unavailable".to_string())?;
        let stream = guard.as_mut().ok_or_else(|| "chatd app control connection is not ready".to_string())?;
        let message = match value {
            Ok(value) => json!({ "operation": "app-reply", "id": id, "value": value }),
            Err(error) => json!({ "operation": "app-reply", "id": id, "error": error }),
        };
        writeln!(stream, "{message}").map_err(|error| format!("could not reply to chatd: {error}"))
        }
        #[cfg(not(unix))]
        { let _ = (id, value); Err("app control requires a Unix socket".to_string()) }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        #[cfg(unix)]
        {
        if let Ok(mut writer) = self.writer.lock() {
            if let Some(stream) = writer.take() { let _ = stream.shutdown(Shutdown::Both); }
        }
        }
    }
}

#[cfg(unix)]
fn socket_path() -> Option<PathBuf> {
    std::env::var_os("MEGABRAIN_STATE_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".megabrain")))
        .map(|state| state.join("chatd").join("s"))
}

#[cfg(not(unix))]
fn socket_path() -> Option<PathBuf> { None }
