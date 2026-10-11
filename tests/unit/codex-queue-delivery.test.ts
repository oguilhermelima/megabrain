import { describe, expect, test } from "bun:test";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { deliverCodexQueue } from "../../src/core/codex-delivery.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function processFor(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput>): ProcessAdapter & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) { calls.push({ command, args: [...args] }); return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

describe("Codex queue delivery", () => {
  test("queues the full message only when the recorded thread process is alive", async () => {
    const process = processFor((command, args) => command === "ps" && args.includes("4242")
      ? ok({ stdout: "codex CODEX_THREAD_ID=thread-1", stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));

    const result = await deliverCodexQueue("thread-1", 4242, "the complete message body", process);

    expect(result).toEqual({ kind: "queued" });
    expect(process.calls).toContainEqual({ command: "codex", args: ["queue", "--thread", "thread-1", "--message", "the complete message body"] });
  });

  test("returns fallback for a dead or mismatched thread without queueing", async () => {
    const process = processFor(() => failed("process not found", 1));

    const result = await deliverCodexQueue("thread-1", 4242, "full body", process);

    expect(result).toEqual({ kind: "fallback", reason: "Codex process is not alive" });
    expect(process.calls).toEqual([{ command: "ps", args: ["eww", "-p", "4242", "-o", "command="] }]);
  });
});
