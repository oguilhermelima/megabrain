import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("queues a finished notice to a busy Codex parent immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "parent-pointer-"));
    try {
    const thread = "01a12a8a-ee5c-7d51-bd86-3e135704fe17";
    const rollout = readFileSync(new URL("../fixtures/codex-delivery/live-rollout.lsof-fn", import.meta.url), "utf8");
    const calls: Call[] = [];
    const process: ProcessAdapter & { readonly calls: readonly Call[] } = {
      calls,
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%7|$4\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "display-message") return ok({ stdout: "100\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-ax") return ok({ stdout: `100 1 zsh\n4242 100 /usr/local/bin/codex --model gpt-6-luna\n4243 4242 codex-code-mode-host\n`, stderr: "", exitCode: 0 });
        if (command === "lsof") return ok({ stdout: rollout, stderr: "", exitCode: 0 });
        if (command === "codex" && args[0] === "queue") return ok({ stdout: "queued", stderr: "", exitCode: 0 });
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    const result = await sendParentPointer(root, {
      parentAgent: "codex", parentAgentThreadId: thread,
      parentTmuxPane: "%7", parentTmuxSessionId: "$4",
    }, "mail: megabrain orchestrate watch dispatch-1", {}, process, "✅ codex finished");
    expect(result).toMatchObject({ outcome: "delivered", transport: "queue" });
    expect(calls).toContainEqual({ command: "codex", args: ["queue", "--thread", thread, "--message", "✅ codex finished"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
