use crate::cli_stream::{first_error_line, forward_stdout_lines};
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
