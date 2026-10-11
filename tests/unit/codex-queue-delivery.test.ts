import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { findCodexProcess, deliverCodexQueue } from "../../src/core/codex-delivery.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;
const thread = "01a12a8a-ee5c-7d51-bd86-3e135704fe17";
const rollout = readFileSync(new URL("../fixtures/codex-delivery/live-rollout.lsof-fn", import.meta.url), "utf8");

function processFor(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput>): ProcessAdapter & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) { calls.push({ command, args: [...args] }); return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

function processTree(codex = true): string {
  return codex ? "100 1 zsh\n4242 100 /usr/local/bin/codex --model gpt-6-luna\n4243 4242 codex-code-mode-host\n" : "100 1 zsh\n4243 100 sleep 30\n";
}

function tmuxScope() {
  return { runtime: "tmux", tmuxPane: "%7", tmuxSessionId: "$4" };
}

function processForTmux({ tree = processTree(), lsof = rollout, queueOk = true }: { tree?: string; lsof?: string | Result<ProcessOutput>; queueOk?: boolean } = {}) {
  return processFor((command, args) => {
    if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%7|$4\n", stderr: "", exitCode: 0 });
    if (command === "tmux" && args[0] === "display-message") return ok({ stdout: "100\n", stderr: "", exitCode: 0 });
    if (command === "ps" && args[0] === "-ax") return ok({ stdout: tree, stderr: "", exitCode: 0 });
    if (command === "lsof") return typeof lsof === "string" ? ok({ stdout: lsof, stderr: "", exitCode: 0 }) : lsof;
    if (command === "codex") return queueOk ? ok({ stdout: "queued", stderr: "", exitCode: 0 }) : failed("queue failed", 1);
    return failed(`unexpected command: ${command} ${args.join(" ")}`, 1);
  });
}

describe("Codex queue delivery", () => {
  test("queues only when a Codex descendant of the verified pane holds the matching rollout", async () => {
    const process = processForTmux();
    const found = await findCodexProcess(thread, tmuxScope(), process);
    expect(found).toEqual({ pid: 4242 });
    const result = await deliverCodexQueue(thread, found.pid!, "the complete message body", process);
    expect(result).toEqual({ kind: "queued" });
    expect(process.calls).toContainEqual({ command: "codex", args: ["queue", "--thread", thread, "--message", "the complete message body"] });
  });

  test("falls back when the recorded pid holds a rollout for another thread", async () => {
    const otherThread = rollout.replace(thread, "another-thread");
    const process = processFor(() => ok({ stdout: otherThread, stderr: "", exitCode: 0 }));
    const result = await deliverCodexQueue(thread, 4242, "full body", process);
    expect(result).toMatchObject({ kind: "fallback" });
    expect(result.kind === "fallback" && result.reason).toContain("rollout");
    expect(process.calls.some((call) => call.command === "codex")).toBe(false);
  });

  test("falls back when there is no Codex process under the verified pane", async () => {
    const process = processForTmux({ tree: processTree(false) });
    const found = await findCodexProcess(thread, tmuxScope(), process);
    expect(found).toMatchObject({ reason: expect.stringContaining("no Codex process") });
    expect(process.calls.some((call) => call.command === "codex")).toBe(false);
  });

  test("falls back with a reason when lsof cannot prove the rollout", async () => {
    const process = processForTmux({ lsof: failed("lsof: executable not found") });
    const found = await findCodexProcess(thread, tmuxScope(), process);
    expect(found).toMatchObject({ reason: expect.stringContaining("lsof") });
    expect(process.calls.some((call) => call.command === "codex")).toBe(false);
  });
});
