import { describe, expect, test } from "bun:test";
import { formatTerminalList, processStatus, type TerminalRecord } from "../../src/core/terminal-list.js";

const record: TerminalRecord = {
  terminalId: "terminal-1", host: "superset", workspaceId: "workspace-1", worktree: "/shared/one",
  title: "DEV web", command: "bun dev", createdAt: "now", pid: 123, rootPid: 123, port: null, status: "active",
};

describe("terminal list", () => {
  test("requires matching process identity before trusting host status", () => {
    expect(processStatus(record, { pid: 456, status: "active" }, true)).toBe("unknown");
    expect(processStatus(record, { pid: 123, status: "active" }, true)).toBe("alive");
    expect(processStatus(record, { pid: 123, status: "exited" }, true)).toBe("dead");
  });

  test("reports stale when a valid host response lacks the terminal", () => {
    expect(processStatus(record, undefined, true)).toBe("stale");
    expect(processStatus(record, undefined, false)).toBe("unknown");
  });

  test("formats json and tabular output", () => {
    const entry = { ...record, status: "unknown" as const };
    expect(formatTerminalList([entry], true)).toBe(`${JSON.stringify([entry], null, 2)}\n`);
    expect(formatTerminalList([entry], false)).toBe("terminal-1\tunknown\tsuperset\t/shared/one\tDEV web\tbun dev\tnow\t123\t-\n");
  });
});
