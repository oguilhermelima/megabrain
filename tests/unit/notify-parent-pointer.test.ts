import { describe, expect, test } from "bun:test";
import { sendParentPointer } from "../../src/cli/commands/queue-write.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function fakeProcess(): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return ok<ProcessOutput>({ stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

describe("sendParentPointer", () => {
  test("targets the parent's terminal handle, not its agent session id", async () => {
    const process = fakeProcess();
    const meta = {
      parentHost: "orca",
      parentSessionId: "claude:c3d6d7f5-0000-4000-8000-000000000000",
      parentTerminalId: "term_2997abc",
    };
    const result = await sendParentPointer("/root", meta, "mail: megabrain orchestrate watch dispatch-1", {}, process);
    expect(result.outcome).toBe("delivered");
    expect(process.calls).toEqual([
      { command: "orca", args: ["terminal", "send", "--terminal", "term_2997abc", "--text", "mail: megabrain orchestrate watch dispatch-1", "--enter", "--json"] },
    ]);
  });

  test("falls back to the parent session id when no terminal handle was recorded", async () => {
    const process = fakeProcess();
    const meta = {
      parentHost: "orca",
      parentSessionId: "term_legacy123",
    };
    const result = await sendParentPointer("/root", meta, "mail: megabrain orchestrate watch dispatch-1", {}, process);
    expect(result.outcome).toBe("delivered");
    expect(process.calls).toEqual([
      { command: "orca", args: ["terminal", "send", "--terminal", "term_legacy123", "--text", "mail: megabrain orchestrate watch dispatch-1", "--enter", "--json"] },
    ]);
  });
});
