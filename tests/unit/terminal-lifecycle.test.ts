import { describe, expect, test } from "bun:test";
import { resolveTerminalSelector, type TerminalLifecycleRecord } from "../../src/core/terminal-lifecycle.js";

const records: TerminalLifecycleRecord[] = [
  { terminalId: "one", host: "superset", workspaceId: "ws", worktree: "/work/one", title: "DEV one", command: "run one", createdAt: "now", pid: 10, rootPid: 10, port: 3000 },
  { terminalId: "two", host: "orca", workspaceId: null, worktree: "/work/two", title: "DEV two", command: "run two", createdAt: "now", pid: 20, rootPid: 20, port: null },
];

describe("terminal selector resolution", () => {
  test("resolves every supported selector against managed records", () => {
    expect(resolveTerminalSelector(records, "id:one")?.terminalId).toBe("one");
    expect(resolveTerminalSelector(records, "title:DEV two")?.terminalId).toBe("two");
    expect(resolveTerminalSelector(records, "port:3000")?.terminalId).toBe("one");
    expect(resolveTerminalSelector(records, "worktree:/work/two")?.terminalId).toBe("two");
  });

  test("returns no match for malformed, missing, and foreign selectors", () => {
    expect(resolveTerminalSelector(records, "id:missing")).toBeUndefined();
    expect(resolveTerminalSelector(records, "port:9000")).toBeUndefined();
    expect(resolveTerminalSelector(records, "name:one")).toBeUndefined();
    expect(resolveTerminalSelector(records, "id:")).toBeUndefined();
  });

  test("keeps shell contract of selecting the first ambiguous record", () => {
    const ambiguous = [...records, { ...records[0], terminalId: "three" }];
    expect(resolveTerminalSelector(ambiguous, "title:DEV one")?.terminalId).toBe("one");
  });
});
