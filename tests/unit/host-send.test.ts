import { describe, expect, test } from "bun:test";
import { runHostSend } from "../../src/hosts/index.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput>): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return behavior(command, args);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const ownershipUnknownBody = (requestId: string) => JSON.stringify({
  ok: false,
  error: {
    code: "agent_session_ownership_unknown",
    message: `agent_session_ownership_unknown Terminal prompt request ID: ${requestId}. Re-issue the exact command with --retry-request ${requestId} --wait-submit <seconds>; do not retry it without that ID.`,
  },
});

describe("runHostSend", () => {
  test("reissues an Orca send refused for ownership with the reported request ID", async () => {
    const requestId = "b19b1e0b-0000-4000-8000-000000000000";
    const process = fakeProcess((command, args) => {
      if (args.includes("--retry-request")) return ok({ stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 });
      return failed(ownershipUnknownBody(requestId), 1, ownershipUnknownBody(requestId));
    });
    const result = await runHostSend("orca", process, { command: "orca", args: ["terminal", "send", "--terminal", "term-1", "--text", "hello", "--enter", "--json"] });
    expect(result.kind).toBe("ok");
    expect(process.calls).toEqual([
      { command: "orca", args: ["terminal", "send", "--terminal", "term-1", "--text", "hello", "--enter", "--json"] },
      { command: "orca", args: ["terminal", "send", "--terminal", "term-1", "--text", "hello", "--enter", "--json", "--retry-request", requestId, "--wait-submit", "10"] },
    ]);
  });

  test("never reissues without a request ID in the error body", async () => {
    const process = fakeProcess(() => failed("some other orca failure", 1, JSON.stringify({ ok: false, error: { code: "something_else" } })));
    const result = await runHostSend("orca", process, { command: "orca", args: ["terminal", "send", "--terminal", "term-1", "--text", "hello", "--enter", "--json"] });
    expect(result.kind).toBe("failed");
    expect(process.calls.length).toBe(1);
  });

  test("stops reissuing once the bound is reached", async () => {
    const requestId = "b19b1e0b-0000-4000-8000-000000000000";
    const process = fakeProcess(() => failed(ownershipUnknownBody(requestId), 1, ownershipUnknownBody(requestId)));
    const result = await runHostSend("orca", process, { command: "orca", args: ["terminal", "send", "--terminal", "term-1", "--text", "hello", "--enter", "--json"] });
    expect(result.kind).toBe("failed");
    expect(process.calls.length).toBe(2);
  });

  test("never reissues a tmux or Superset send", async () => {
    const requestId = "b19b1e0b-0000-4000-8000-000000000000";
    const process = fakeProcess(() => failed(ownershipUnknownBody(requestId), 1, ownershipUnknownBody(requestId)));
    const result = await runHostSend("superset", process, { command: "superset", args: ["terminals", "send", "--workspace", "ws", "--terminal", "term-1", "--text", "hello", "--json"] });
    expect(result.kind).toBe("failed");
    expect(process.calls.length).toBe(1);
  });
});
