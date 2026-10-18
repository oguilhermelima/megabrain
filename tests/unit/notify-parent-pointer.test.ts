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
  test("defers parent terminal typing until its idle state has been read", async () => {
    const process = fakeProcess();
    const meta = {
      parentHost: "orca",
      parentSessionId: "claude:c3d6d7f5-0000-4000-8000-000000000000",
      parentTerminalId: "term_2997abc",
    };
    const result = await sendParentPointer("/root", meta, "mail: megabrain orchestrate watch dispatch-1", {}, process);
    expect(result).toMatchObject({ outcome: "deferred", transport: "deferred" });
    expect(process.calls).toEqual([]);
  });

  test("defers legacy parent terminals without typing blindly", async () => {
    const process = fakeProcess();
    const meta = {
      parentHost: "orca",
      parentSessionId: "term_legacy123",
    };
    const result = await sendParentPointer("/root", meta, "mail: megabrain orchestrate watch dispatch-1", {}, process);
    expect(result).toMatchObject({ outcome: "deferred", transport: "deferred" });
    expect(process.calls).toEqual([]);
  });
});
