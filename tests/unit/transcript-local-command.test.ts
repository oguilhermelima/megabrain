import { describe, expect, test } from "bun:test";
import { parseSessionLog } from "../../src/core/session-transcript.js";

// The shapes Claude Code writes a local command in its session log, taken from real logs (2026-10-11 and
// 2026-10-17, paths redacted): the command as a user line or a system local_command line, its output as a
// system local_command line of its own, and the older form with both inside one user line.
const commandText = (name: string) => `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args></command-args>`;
const userCommand = (name: string) => ({ type: "user", timestamp: "2026-10-17T18:27:08.033Z", message: { role: "user", content: commandText(name) } });
const systemCommand = (name: string) => ({ type: "system", subtype: "local_command", content: commandText(name), level: "info", timestamp: "2026-10-11T14:56:25.280Z", cwd: "/Users/operator/project" });
const output = (text: string) => ({ type: "system", subtype: "local_command", content: `<local-command-stdout>${text}</local-command-stdout>`, level: "info", timestamp: "2026-10-17T18:27:13.007Z" });
const usage = "Current session: 23% used · resets Oct 17 at 4pm (America/Sao_Paulo)";

function parse(...lines: unknown[]) {
  return parseSessionLog("claude", "fixture", lines.map((line) => `${JSON.stringify(line)}\n`).join(""))?.events
    .map(({ kind, text, ...rest }) => ({ kind, text, command: (rest as { command?: string }).command }));
}

describe("claude local command transcript", () => {
  test("shows a command's output, written on a line of its own, as that command's result", () => {
    expect(parse(userCommand("/usage"), output(usage))).toEqual([
      { kind: "system", text: "/usage ", command: undefined },
      { kind: "assistant", text: usage, command: "/usage" },
    ]);
  });

  test("reads the command from a system local_command line too", () => {
    expect(parse(systemCommand("/context"), output("## Context Usage"))).toEqual([
      { kind: "system", text: "/context ", command: undefined },
      { kind: "assistant", text: "## Context Usage", command: "/context" },
    ]);
  });

  test("reads the older form with the output inside the command's line", () => {
    const line = { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: `${commandText("/cost")}\n<local-command-stdout>Total cost:            $0.0000</local-command-stdout>` } };
    expect(parse(line)).toEqual([
      { kind: "system", text: "/cost ", command: undefined },
      { kind: "assistant", text: "Total cost:            $0.0000", command: "/cost" },
    ]);
  });

  test("an output with no command before it still shows, without a name", () => {
    expect(parse(output(usage))).toEqual([{ kind: "assistant", text: usage, command: "" }]);
  });

  test("an empty output adds nothing", () => {
    expect(parse(userCommand("/clear"), output(""))).toEqual([{ kind: "system", text: "/clear ", command: undefined }]);
  });
});
