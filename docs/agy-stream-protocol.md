# agy stream protocol findings

## Probe setup

The installed CLI was agy 1.4.2 (the prior research recorded 1.4.1). Probes ran in a fresh `/tmp/agy-probe` workspace with the real HOME, model `gemini-3.8-flash-low`, and no permission-bypass flag. The protocol used newline-delimited input frames shaped as `{"event":"user","message":{"content":"..."}}`. Each captured stdout fixture is under `tests/fixtures/chat-agy-*.jsonl`; local paths were redacted.

## Observed behavior

- Two input frames on one stdin produced two sequential turns and one `result` event per prompt. Text deltas, lifecycle steps, usage, conversation ID, model, cwd, tool roster, and permission mode are observable (`chat-agy-multiturn.jsonl`).
- `--conversation <id>` resumed the probe conversation and retained the two prior prompts (`chat-agy-resume.jsonl`). Initial model selection works; the installed model list exposes model and effort as combined IDs (for example `gemini-3.8-flash-low`). Passing `--effort low` with `gemini-2.5-flash` failed because that model does not support the flag.
- A read-only tool request emitted a `tool` step with tool name and input, but the tool was denied: headless request-review mode cannot prompt for the required `command` permission. The CLI explicitly reported that tools requiring a prompt are auto-denied in headless mode. No approval request/reply event was emitted (`chat-agy-read.jsonl`).
- A write request in the same request-review mode emitted `tool` ACTIVE then ERROR with the denied `write_file` permission; the target file was not created. The stderr message says headless mode auto-denied the permission, and the stream contains no approval request/reply or control event (`chat-agy-approval.jsonl`).
- The conversation transcript records `PLANNER_RESPONSE.tool_calls` and a `GENERIC` error result for the denied read and write attempts. This supports rendering observed tool calls and failed results in terminal-follow mode, but no successful tool completion was captured (`chat-agy-transcript.jsonl`).
- Sending SIGINT after an agent response became active emitted a partial `agent_response` step followed by a `result` with status `ERROR` and error `interrupted` (`chat-agy-cancel.jsonl`). This is process-level cancellation, not a protocol control event.
- No successful structured tool result was observed because permission-gated tools cannot proceed headlessly. Approval reply, live model/effort switching, and successful tool-result framing therefore remain unproven. Terminal-follow can expose the captured structured call and error result; it must not claim approval control or successful tool execution based on the init tool roster alone.

## Decision

Use agy's terminal-follow mode for native chats. The stream-json process can carry text turns and resume, but the available headless permission mode cannot expose or answer approval prompts, and interruption requires signaling the process. In terminal-follow mode set approvals, interrupt, live model switch, and steer to false; set structured tools true for the captured call and error-result records. Continue to use the existing transcript/history sources for display and the existing language-server delivery path for sending queued input to an owned TUI session.

The cancellation fixture retains the three complete frames; SIGINT truncated the in-progress `init` frame before its JSON object finished, so that partial line is omitted.
