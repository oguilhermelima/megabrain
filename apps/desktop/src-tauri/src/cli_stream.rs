use crate::process_tree;
use serde_json::json;
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use uuid::Uuid;

#[derive(Default)]
pub struct CliStreams {
    streams: Arc<Mutex<HashMap<String, Arc<Stream>>>>,
}

struct Stream {
    child: Mutex<Child>,
    stopped: AtomicBool,
}

impl CliStreams {
    pub fn start(&self, mut command: Command, on_line: Channel<String>) -> Result<String, String> {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not run megabrain: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CLI stdout was not piped".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "CLI stderr was not piped".to_string())?;
        let (id, stream) = self.register(child)?;

        let streams = self.streams.clone();
        let worker_id = id.clone();
        std::thread::spawn(move || {
            let stderr_reader = std::thread::spawn(move || {
                let mut text = String::new();
                let _ = BufReader::new(stderr).read_to_string(&mut text);
                text
            });
            let _ = forward_stdout_lines(BufReader::new(stdout), |line| {
                let _ = on_line.send(line);
            });
            let status = stream
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok());
            let stderr = stderr_reader.join().unwrap_or_default();
            if status.as_ref().and_then(std::process::ExitStatus::code) != Some(0)
                && !stream.stopped.load(Ordering::Acquire)
            {
                let _ = on_line.send(first_error_line(&stderr));
            }
            // A stream that ended without being stopped says so, so the follower can come back.
            if !stream.stopped.load(Ordering::Acquire) {
                let _ = on_line.send(end_line());
            }
            if let Ok(mut streams) = streams.lock() {
                streams.remove(&worker_id);
            }
        });
        Ok(id)
    }

    /// Tracks a running child so stopping or dropping the streams ends it.
    pub fn adopt(&self, child: Child) -> String {
        self.register(child).map(|(id, _)| id).unwrap_or_default()
    }

    fn register(&self, child: Child) -> Result<(String, Arc<Stream>), String> {
        let id = Uuid::new_v4().to_string();
        let stream = Arc::new(Stream {
            child: Mutex::new(child),
            stopped: AtomicBool::new(false),
        });
        self.streams
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id.clone(), stream.clone());
        Ok((id, stream))
    }

    pub fn stop(&self, id: &str) {
        let stream = self
            .streams
            .lock()
            .ok()
            .and_then(|mut streams| streams.remove(id));
        if let Some(stream) = stream {
            stream.stopped.store(true, Ordering::Release);
            if let Ok(mut child) = stream.child.lock() {
                let _ = process_tree::kill(&mut child);
            }
        }
    }

    pub fn stop_all(&self) {
        let ids = self
            .streams
            .lock()
            .map(|streams| streams.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            self.stop(&id);
        }
    }
}

impl Drop for CliStreams {
    fn drop(&mut self) {
        self.stop_all();
    }
}

pub fn forward_stdout_lines<R, F>(reader: R, mut on_line: F) -> io::Result<()>
where
    R: BufRead,
    F: FnMut(String),
{
    for line in reader.lines() {
        on_line(line?);
    }
    Ok(())
}

/// Forwards each stdout line of a streaming command; a read that fails part way is an error naming
/// the cause, so a stream cut short never reads as complete.
pub fn stream_stdout<R, F>(reader: R, on_line: F) -> Result<(), String>
where
    R: BufRead,
    F: FnMut(String),
{
    forward_stdout_lines(reader, on_line).map_err(|error| format!("could not read megabrain output: {error}"))
}

pub fn end_line() -> String {
    json!({ "cursor": "", "end": true }).to_string()
}

pub fn first_error_line(stderr: &str) -> String {
    let first = stderr.lines().next().unwrap_or_default();
    json!({ "cursor": "", "error": first }).to_string()
}
