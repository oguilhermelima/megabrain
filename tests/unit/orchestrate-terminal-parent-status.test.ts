import { describe, expect, test } from "bun:test";
import { parentStatus } from "../../src/cli/commands/orchestrate-terminal.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

function fakeProcess(stdout: string): ProcessAdapter {
  return {
    async run() { return ok<ProcessOutput>({ stdout, stderr: "", exitCode: 0 }); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

describe("parentStatus", () => {
  test("matches the parent's terminal handle, not its agent session id", async () => {
    const process = fakeProcess(JSON.stringify({ terminals: [{ handle: "term_2997abc" }] }));
    const meta = {
      parentHost: "orca",
      parentSessionId: "claude:c3d6d7f5-0000-4000-8000-000000000000",
      parentTerminalId: "term_2997abc",
    };
    expect(await parentStatus(meta, process)).toBe("alive");
  });

  test("falls back to the parent session id when no terminal handle was recorded", async () => {
    const process = fakeProcess(JSON.stringify({ terminals: [{ handle: "term_legacy123" }] }));
    const meta = {
      parentHost: "orca",
      parentSessionId: "term_legacy123",
    };
    expect(await parentStatus(meta, process)).toBe("alive");
  });
});
