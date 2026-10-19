use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;

const MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;
const EMPTY_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Default)]
pub(crate) struct FrameStreams {
    streams: Arc<Mutex<HashMap<String, Arc<Stream>>>>,
}

struct Stream {
    key: String,
    url: String,
    latest: LatestFrame,
    subscribers: Mutex<usize>,
    last_unused: Mutex<Option<Instant>>,
    stop: AtomicBool,
}

#[derive(Default)]
struct LatestFrame {
    frame: Mutex<Option<(u64, Vec<u8>)>>,
}

impl LatestFrame {
    fn publish(&self, bytes: Vec<u8>) -> u64 {
        let mut frame = self.frame.lock().unwrap_or_else(|e| e.into_inner());
        let seq = frame.as_ref().map_or(1, |(seq, _)| seq + 1);
        *frame = Some((seq, bytes));
        seq
    }

    fn get(&self) -> Option<Vec<u8>> {
        self.frame
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|(_, bytes)| bytes.clone())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameEvent {
    url: String,
    src: Option<String>,
    width: u32,
    height: u32,
    fps: u32,
    error: Option<String>,
    stalled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrameSubscription {
    pub key: String,
    pub src: Option<String>,
    pub width: u32,
    pub height: u32,
}

impl FrameStreams {
    pub(crate) fn subscribe(
        &self,
        app: tauri::AppHandle,
        url: String,
    ) -> Result<FrameSubscription, String> {
        if !is_allowed_stream_url(&url) {
            return Err("device frame streams must use http://127.0.0.1".into());
        }
        let mut streams = self
            .streams
            .lock()
            .map_err(|_| "frame stream lock poisoned")?;
        let stream = streams
            .entry(url.clone())
            .or_insert_with(|| {
                let stream = Arc::new(Stream {
                    key: uuid::Uuid::new_v4().simple().to_string(),
                    url: url.clone(),
                    latest: LatestFrame::default(),
                    subscribers: Mutex::new(0),
                    last_unused: Mutex::new(None),
                    stop: AtomicBool::new(false),
                });
                spawn_reader(app.clone(), stream.clone(), self.streams.clone());
                stream
            })
            .clone();
        *stream
            .subscribers
            .lock()
            .map_err(|_| "frame subscriber lock poisoned")? += 1;
        *stream
            .last_unused
            .lock()
            .map_err(|_| "frame subscriber lock poisoned")? = None;
        let (src, width, height) = stream.latest_frame();
        Ok(FrameSubscription { key: stream.key.clone(), src, width, height })
    }

    pub(crate) fn unsubscribe(&self, url: &str) {
        if let Some(stream) = self
            .streams
            .lock()
            .ok()
            .and_then(|streams| streams.get(url).cloned())
        {
            if let Ok(mut count) = stream.subscribers.lock() {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    if let Ok(mut unused) = stream.last_unused.lock() {
                        *unused = Some(Instant::now());
                    }
                }
            }
        }
    }

    pub(crate) fn frame(&self, key: &str) -> Option<Vec<u8>> {
        self.streams
            .lock()
            .ok()?
            .values()
            .find(|stream| stream.key == key)?
            .latest
            .get()
    }
}

impl Stream {
    fn unused_expired(&self) -> bool {
        self.subscribers
            .lock()
            .map(|count| *count == 0)
            .unwrap_or(true)
            && self
                .last_unused
                .lock()
                .ok()
                .and_then(|at| *at)
                .is_some_and(|at| at.elapsed() >= EMPTY_DELAY)
    }

    fn latest_frame(&self) -> (Option<String>, u32, u32) {
        let Ok(frame) = self.latest.frame.lock() else { return (None, 0, 0) };
        let Some((seq, bytes)) = frame.as_ref() else { return (None, 0, 0) };
        let (width, height) = jpeg_dimensions(bytes).unwrap_or((0, 0));
        (Some(format!("device-frame://{}/{seq}.jpg", self.key)), width, height)
    }
}

fn spawn_reader(
    app: tauri::AppHandle,
    stream: Arc<Stream>,
    streams: Arc<Mutex<HashMap<String, Arc<Stream>>>>,
) {
    thread::spawn(move || {
        let mut backoff = Duration::from_millis(250);
        while !stream.stop.load(Ordering::Relaxed) {
            if stream.unused_expired() {
                stream.stop.store(true, Ordering::Relaxed);
                break;
            }
            match read_connection(&stream.url, &stream, &app) {
                Ok(()) => backoff = Duration::from_millis(250),
                Err(error) => {
                    let _ = app.emit(
                        "device-frame",
                        FrameEvent {
                            url: stream.url.clone(),
                            src: None,
                            width: 0,
                            height: 0,
                            fps: 0,
                            error: Some(error),
                            stalled: true,
                        },
                    );
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(5));
                }
            }
        }
        if let Ok(mut map) = streams.lock() {
            if map
                .get(&stream.url)
                .is_some_and(|current| Arc::ptr_eq(current, &stream))
            {
                map.remove(&stream.url);
            }
        }
    });
}

fn read_connection(url: &str, stream: &Stream, app: &tauri::AppHandle) -> Result<(), String> {
    let (_, authority_and_path) = url.split_once("://").ok_or("invalid stream URL")?;
    let (authority, path) = authority_and_path
        .split_once('/')
        .map_or((authority_and_path, "/"), |(host, path)| {
            (host, &url[url.len() - path.len() - 1..])
        });
    let (host, port) = authority.rsplit_once(':').ok_or("stream URL has no port")?;
    let port: u16 = port.parse().map_err(|_| "invalid stream port")?;
    let address: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .find(|addr| addr.ip().is_loopback())
        .ok_or("stream did not resolve to loopback")?;
    let mut socket =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    write!(socket, "GET {path} HTTP/1.1\r\nHost: {authority}\r\nAccept: multipart/x-mixed-replace, image/jpeg\r\nConnection: keep-alive\r\n\r\n").map_err(|e| e.to_string())?;
    let mut parser = MjpegParser::default();
    let mut input = [0; 64 * 1024];
    let mut headers = Vec::new();
    loop {
        if stream.unused_expired() {
            return Ok(());
        }
        let count = socket.read(&mut input).map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("frame stream closed".into());
        }
        let bytes = &input[..count];
        if !headers.windows(4).any(|part| part == b"\r\n\r\n") {
            headers.extend_from_slice(bytes);
            if headers.len() > 64 * 1024 {
                return Err("frame stream headers too large".into());
            }
            if let Some(end) = headers.windows(4).position(|part| part == b"\r\n\r\n") {
                if !headers.starts_with(b"HTTP/1.1 200") && !headers.starts_with(b"HTTP/1.0 200") {
                    return Err("frame stream returned a non-200 response".into());
                }
                for frame in parser.push(&headers[end + 4..]) {
                    publish_frame(stream, app, frame);
                }
            }
        } else {
            for frame in parser.push(bytes) {
                publish_frame(stream, app, frame);
            }
        }
    }
}

fn publish_frame(stream: &Stream, app: &tauri::AppHandle, frame: Vec<u8>) {
    let (width, height) = jpeg_dimensions(&frame).unwrap_or((0, 0));
    let seq = stream.latest.publish(frame);
    let src = format!("device-frame://{}/{seq}.jpg", stream.key);
    let _ = app.emit(
        "device-frame",
        FrameEvent {
            url: stream.url.clone(),
            src: Some(src),
            width,
            height,
            fps: 0,
            error: None,
            stalled: false,
        },
    );
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xff {
            at += 1;
            continue;
        }
        let marker = bytes[at + 1];
        at += 2;
        if matches!(marker, 0xd8 | 0xd9 | 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let length = u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]) as usize;
        if length < 2 || at + length > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            return Some((
                u16::from_be_bytes([*bytes.get(at + 5)?, *bytes.get(at + 6)?]) as u32,
                u16::from_be_bytes([*bytes.get(at + 3)?, *bytes.get(at + 4)?]) as u32,
            ));
        }
        at += length;
    }
    None
}

fn is_allowed_stream_url(value: &str) -> bool {
    if value.bytes().any(|byte| {
        byte.is_ascii_control() || byte.is_ascii_whitespace() || byte == b'#' || byte == b'\\'
    }) {
        return false;
    }
    let Some(rest) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    authority.parse::<u16>().is_ok_and(|port| port > 0)
}

struct MjpegParser {
    buffer: Vec<u8>,
    max_frame_size: usize,
}

impl Default for MjpegParser {
    fn default() -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size: MAX_FRAME_SIZE,
        }
    }
}

impl MjpegParser {
    #[cfg(test)]
    fn with_max_frame_size(max: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size: max,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            let Some(start) = self.buffer.windows(2).position(|pair| pair == [0xff, 0xd8]) else {
                if self.buffer.last() == Some(&0xff) {
                    self.buffer = vec![0xff];
                } else {
                    self.buffer.clear();
                }
                break;
            };
            if start > 0 {
                self.buffer.drain(..start);
            }
            let Some(end) = self.buffer.windows(2).position(|pair| pair == [0xff, 0xd9]) else {
                if self.buffer.len() > self.max_frame_size {
                    if let Some(next) = self.buffer[2..]
                        .windows(2)
                        .position(|pair| pair == [0xff, 0xd8])
                    {
                        self.buffer.drain(..2 + next);
                        continue;
                    }
                    let keep = self.buffer.last() == Some(&0xff);
                    self.buffer.clear();
                    if keep {
                        self.buffer.push(0xff);
                    }
                }
                break;
            };
            let end = end + 2;
            if end > self.max_frame_size {
                if let Some(next) = self.buffer[2..end]
                    .windows(2)
                    .position(|pair| pair == [0xff, 0xd8])
                {
                    self.buffer.drain(..2 + next);
                    continue;
                }
                self.buffer.drain(..end);
                continue;
            }
            let frame: Vec<u8> = self.buffer.drain(..end).collect();
            if frame.len() <= self.max_frame_size {
                frames.push(frame);
            }
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_stream_url, LatestFrame, MjpegParser};

    const JPEG: &[u8] = &[0xff, 0xd8, 1, 2, 0xff, 0xd9];

    #[test]
    fn parses_frames_when_boundaries_are_split_across_chunks() {
        let mut parser = MjpegParser::default();
        assert!(parser
            .push(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8")
            .is_empty());
        assert_eq!(parser.push(b"\x01\x02\xff\xd9\r\n--frame\r\n"), vec![JPEG]);
    }

    #[test]
    fn ignores_garbage_before_and_between_frames() {
        let mut parser = MjpegParser::default();
        assert_eq!(
            parser.push(b"garbage\xff\xd8x\xff\xd9junk\xff\xd8y\xff\xd9"),
            vec![b"\xff\xd8x\xff\xd9".to_vec(), b"\xff\xd8y\xff\xd9".to_vec()]
        );
    }

    #[test]
    fn drops_huge_frames_and_resumes_at_the_next_jpeg() {
        let mut parser = MjpegParser::with_max_frame_size(8);
        let mut chunk = vec![0xff, 0xd8];
        chunk.extend([1; 32]);
        chunk.extend(JPEG);
        assert_eq!(parser.push(&chunk), vec![JPEG]);
    }

    #[test]
    fn only_loopback_http_stream_urls_are_allowed() {
        for url in ["http://127.0.0.1:8100/"] {
            assert!(is_allowed_stream_url(url), "{url}");
        }
        for url in [
            "https://127.0.0.1:8100/",
            "http://127.0.0.2:8100/",
            "http://192.168.1.2:8100/",
            "http://example.com/",
        ] {
            assert!(!is_allowed_stream_url(url), "{url}");
        }
        assert!(!is_allowed_stream_url(
            "http://127.0.0.1:8100/\r\nHost: example.com"
        ));
    }

    #[test]
    fn latest_frame_replaces_unconsumed_frames() {
        let latest = LatestFrame::default();
        latest.publish(vec![1]);
        latest.publish(vec![2]);
        assert_eq!(latest.get(), Some(vec![2]));
    }

    #[test]
    fn reports_delivery_rate_and_latency_from_a_local_30_fps_mjpeg_server() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::thread;
        use std::time::{Duration, Instant};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let start = Instant::now();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n").unwrap();
            for _ in 0..30 {
                let sent_ns = start.elapsed().as_nanos();
                let mut jpeg = vec![0xff, 0xd8];
                jpeg.extend_from_slice(&sent_ns.to_be_bytes());
                jpeg.extend_from_slice(&[0xff, 0xd9]);
                socket
                    .write_all(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
                    .unwrap();
                socket.write_all(&jpeg).unwrap();
                socket.write_all(b"\r\n").unwrap();
                thread::sleep(Duration::from_millis(33));
            }
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 4096];
        let mut headers = Vec::new();
        loop {
            let count = client.read(&mut bytes).unwrap();
            headers.extend_from_slice(&bytes[..count]);
            if headers.windows(4).any(|part| part == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = headers
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap()
            + 4;
        let mut parser = MjpegParser::default();
        let mut delivered = Vec::new();
        let mut latencies = Vec::new();
        let record =
            |frames: Vec<Vec<u8>>, delivered: &mut Vec<Vec<u8>>, latencies: &mut Vec<f64>| {
                for frame in frames {
                    let sent = u128::from_be_bytes(frame[2..18].try_into().unwrap());
                    latencies
                        .push(start.elapsed().as_nanos().saturating_sub(sent) as f64 / 1_000_000.0);
                    delivered.push(frame);
                }
            };
        let begun = Instant::now();
        record(
            parser.push(&headers[header_end..]),
            &mut delivered,
            &mut latencies,
        );
        while delivered.len() < 30 {
            let count = client.read(&mut bytes).unwrap();
            record(parser.push(&bytes[..count]), &mut delivered, &mut latencies);
        }
        server.join().unwrap();
        let elapsed = begun.elapsed().as_secs_f64();
        let fps = delivered.len() as f64 / elapsed;
        let average_latency = latencies.iter().sum::<f64>() / latencies.len() as f64;
        println!("local fake MJPEG: {fps:.1} frames/s, average per-frame latency {average_latency:.2} ms, max {:.2} ms", latencies.iter().copied().fold(0.0_f64, f64::max));
        assert_eq!(delivered.len(), 30);
        assert!(fps >= 20.0, "delivered only {fps:.1} frames/s");
    }
}
