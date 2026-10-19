import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { startSupervisorWorker } from "../../src/cli/commands/supervise.js";
import { chatProtocolAdapters } from "../../src/chat/protocol.js";
import type { Chat } from "../../src/chat/store.js";
import { runtimeScript, selfInvocation } from "../../src/core/self-invocation.js";
import { createDispatch } from "../../src/adapters/state-db.js";
import { openDatabase } from "../../src/db/db.js";
import { ok } from "../../src/core/result.js";

describe("selfInvocation", () => {
  test("a compiled binary runs itself, ignoring the virtual script path", () => {
    expect(selfInvocation("/Applications/Megabrain", ["/Applications/Megabrain", "/$bunfs/root/megabrain-cli"], ["chat", "mcp-permission", "c1"]))
      .toEqual({ command: "/Applications/Megabrain", args: ["chat", "mcp-permission", "c1"] });
  });

  test("a script run goes through the runtime with the real script path", () => {
    expect(selfInvocation("/usr/local/bin/node", ["node", "/repo/dist/cli.js"], ["__chatd"]))
      .toEqual({ command: "/usr/local/bin/node", args: ["/repo/dist/cli.js", "__chatd"] });
  });

  test("a compiled binary without a script argument still runs itself", () => {
    expect(selfInvocation("/Applications/Megabrain", ["/Applications/Megabrain"])).toEqual({ command: "/Applications/Megabrain", args: [] });
  });
});

const chat: Chat = { id: "11111111-1111-4111-8111-111111111111", agent: "claude", model: "m1", cwd: "/tmp", title: null, state: "idle", mode: "chat", agentSessionId: null, createdAt: "2026-01-01T00:00:00Z", lastActivityAt: null };

describe("claude chat permission server", () => {
  test("approvals on: mcp.json runs the permission server through the helper", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-selfinv-"));
    try {
      mkdirSync(join(stateDir, "chats", chat.id), { recursive: true });
      const { args } = await chatProtocolAdapters.claude.prepare({ ...chat, approvals: true }, stateDir);
      expect(args).toContain("--mcp-config");
      expect(args).toContain("--permission-prompt-tool");
      const config = JSON.parse(readFileSync(join(stateDir, "chats", chat.id, "mcp.json"), "utf8"));
      const expected = selfInvocation(process.execPath, process.argv, ["chat", "mcp-permission", chat.id]);
      expect(config.mcpServers.megabrain.command).toBe(expected.command);
      expect(config.mcpServers.megabrain.args).toEqual(expected.args);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  test("approvals off: no mcp config, no permission tool, no mcp.json", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-selfinv-"));
    try {
      mkdirSync(join(stateDir, "chats", chat.id), { recursive: true });
      const { args } = await chatProtocolAdapters.claude.prepare(chat, stateDir);
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--mcp-config");
      expect(args).not.toContain("--permission-prompt-tool");
      expect(() => readFileSync(join(stateDir, "chats", chat.id, "mcp.json"))).toThrow();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe("detached workers run through the helper", () => {
  test("the supervisor worker command is the helper's", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-selfinv-"));
    try {
      const environment = { MEGABRAIN_STATE_DIR: root, HOME: root };
      const opened = openDatabase(environment);
      if (opened.kind !== "ok") throw new Error(opened.error);
      createDispatch(opened.value, { dispatchId: "d1", state: "running", runtime: "tmux", agent: "codex", chatName: "d1" });
      opened.value.close();
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const adapter = { async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); }, async startDetached(command: string, args: readonly string[]) { calls.push({ command, args }); return ok({ pid: 1 }); }, invocationCount() { return 0; } };
      expect(await startSupervisorWorker(root, environment, adapter as never)).toBe("started");
      const expected = selfInvocation(process.execPath, process.argv, ["__supervise-worker"]);
      expect(calls[0]?.command).toBe(expected.command);
      expect(calls[0]?.args.slice(0, expected.args.length)).toEqual(expected.args);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("delivery resumes through the owner without starting a detached worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-selfinv-"));
    try {
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const adapter = { async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); }, async startDetached(command: string, args: readonly string[]) { calls.push({ command, args }); return ok({ pid: 1 }); }, invocationCount() { return 0; } };
      const meta = { targetKind: "parent-pointer", parentHost: "tmux", parentTmuxSession: "private", parentTmuxPane: "%1" };
      expect(await startDeliveryWorker(root, "d1", "ob1", meta, adapter as never)).not.toBe("failed");
      expect(calls).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("runtimeScript", () => {
  test("runs inline JavaScript through this executable acting as the bun runtime", () => {
    expect(runtimeScript("/Applications/Megabrain", "console.log(1)", "payload")).toEqual({
      command: "/Applications/Megabrain",
      args: ["-e", "console.log(1)", "payload"],
      env: { BUN_BE_BUN: "1" },
    });
  });
});
