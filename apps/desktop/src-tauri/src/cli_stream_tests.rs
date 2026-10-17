use crate::cli_stream::{end_line, first_error_line, forward_stdout_lines};
use std::io::Cursor;

#[test]
fn cli_stream_forwards_each_stdout_line_without_reformatting() {
    let mut lines = Vec::new();
    forward_stdout_lines(Cursor::new(b"{\"cursor\":\"1\"}\n{\"cursor\":\"2\"}\n"), |line| lines.push(line)).unwrap();
    assert_eq!(lines, ["{\"cursor\":\"1\"}", "{\"cursor\":\"2\"}"]);
}

#[test]
fn cli_stream_reports_only_the_first_stderr_line_as_a_contract_error() {
    assert_eq!(
        first_error_line("first failure\nsecond detail\n"),
        r#"{"cursor":"","error":"first failure"}"#
    );
    assert_eq!(
        first_error_line("a quote: \" and a newline\n"),
        r#"{"cursor":"","error":"a quote: \" and a newline"}"#
    );
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
