use crate::cli_stream::{end_line, first_error_line, forward_stdout_lines, stream_stdout};
use std::io::Cursor;

#[test]
fn cli_stream_forwards_each_stdout_line_without_reformatting() {
    let mut lines = Vec::new();
    forward_stdout_lines(Cursor::new(b"{\"cursor\":\"1\"}\n{\"cursor\":\"2\"}\n"), |line| lines.push(line)).unwrap();
    assert_eq!(lines, ["{\"cursor\":\"1\"}", "{\"cursor\":\"2\"}"]);
}

#[test]
fn cli_stream_reports_the_full_bounded_stderr_as_a_contract_error() {
    assert_eq!(
        first_error_line("first failure\nsecond detail\n"),
        r#"{"cursor":"","error":"first failure\nsecond detail\n"}"#
    );
    assert_eq!(
        first_error_line("a quote: \" and a newline\n"),
        r#"{"cursor":"","error":"a quote: \" and a newline\n"}"#
    );
}

#[test]
fn cli_stream_bounds_large_stderr_to_the_last_64_kibibytes() {
    let stderr = format!("{}tail", "x".repeat(70 * 1024));
    let result = first_error_line(&stderr);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    let error = parsed["error"].as_str().unwrap();
    assert!(error.len() <= 64 * 1024);
    assert!(error.ends_with("tail"));
}

#[test]
fn cli_stream_ends_with_a_marker_the_follower_can_tell_from_events() {
    assert_eq!(end_line(), r#"{"cursor":"","end":true}"#);
}

#[cfg(unix)]
#[test]
fn cli_streams_kill_their_children_when_dropped() {
    use crate::cli_stream::CliStreams;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let child = Command::new("sleep")
        .arg("60")
        .process_group(0)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id() as libc::pid_t;
    let streams = CliStreams::default();
    streams.adopt(child);
    // SAFETY: signal 0 only probes whether the process exists.
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "child runs while the streams live");
    drop(streams);
    // SAFETY: as above.
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "child is gone once the streams drop");
}

/// Reads two lines, then fails as a broken pipe would.
struct FailingReader {
    sent: bool,
}

impl std::io::Read for FailingReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.sent {
            return Err(std::io::Error::other("pipe broke"));
        }
        self.sent = true;
        let bytes = b"{\"step\":1}\n{\"step\":2}\n";
        buffer[..bytes.len()].copy_from_slice(bytes);
        Ok(bytes.len())
    }
}

#[test]
fn install_stream_reports_a_stdout_read_error_after_the_lines_it_read() {
    let mut lines = Vec::new();
    let result = stream_stdout(std::io::BufReader::new(FailingReader { sent: false }), |line| lines.push(line));
    assert_eq!(lines, vec!["{\"step\":1}".to_string(), "{\"step\":2}".to_string()]);
    let error = result.expect_err("a read error must not look like a complete stream");
    assert!(error.contains("pipe broke"), "{error}");
}

#[test]
fn install_stream_reads_a_whole_stream() {
    let mut lines = Vec::new();
    stream_stdout(Cursor::new(b"a\nb\n"), |line| lines.push(line)).unwrap();
    assert_eq!(lines, vec!["a".to_string(), "b".to_string()]);
}
