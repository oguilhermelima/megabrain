import { describe, expect, test } from "bun:test";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { setTmuxChatPane } from "../../src/core/chat-pane.js";
import { ok } from "../../src/core/result.js";

describe("tmux chat pane identity", () => {
  test("sets title, agent, name, and mapped state options", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const process: ProcessAdapter = { run: async (command, args) => { calls.push({ command, args }); return ok({ stdout: "", stderr: "", exitCode: 0 }); } };
    await setTmuxChatPane("%7", "claude", "fix-chat-names", "waiting_for_reply", process);
    expect(calls.map(({ args }) => args)).toEqual([
      ["select-pane", "-t", "%7", "-T", "claude · fix-chat-names"],
      ["set-option", "-p", "-t", "%7", "@megabrain_agent", "claude"],
      ["set-option", "-p", "-t", "%7", "@megabrain_name", "fix-chat-names"],
      ["set-option", "-p", "-t", "%7", "@megabrain_state", "question"],
    ]);
  });

  test.each([
    ["spawning", "working"], ["running", "working"], ["waiting_for_reply", "question"], ["done", "finished"], ["stalled", "stuck"], ["closed", "idle"],
  ])("maps dispatch state %s to pane state %s", async (state, paneState) => {
    const calls: string[][] = [];
    const process: ProcessAdapter = { run: async (_command, args) => { calls.push([...args]); return ok({ stdout: "", stderr: "", exitCode: 0 }); } };
    await setTmuxChatPane("%2", "codex", "topic", state, process);
    expect(calls.at(-1)).toEqual(["set-option", "-p", "-t", "%2", "@megabrain_state", paneState]);
  });
});
