import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { chatProtocolAdapters } from "../../src/chat/protocol.js";
import type { Chat } from "../../src/chat/store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function chat(agent: Chat["agent"], extra: Partial<Chat> = {}): Chat {
  return { id: "11111111-1111-4111-8111-111111111111", agent, model: "m1", cwd: "/tmp", title: null, state: "idle", mode: "chat", agentSessionId: "sess", createdAt: "2026-01-01T00:00:00Z", lastActivityAt: null, ...extra };
}

describe("chat protocol argv bypasses permission prompts by default", () => {
  test("claude stream-json carries the bypass flag and skips the permission tool", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-bypass-"));
    directories.push(stateDir);
    mkdirSync(join(stateDir, "chats", chat("claude").id), { recursive: true });
    const { args } = await chatProtocolAdapters.claude.prepare(chat("claude"), stateDir);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-prompt-tool");
  });

  test("claude stream-json omits the bypass flag when approvals are asked", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-bypass-"));
    directories.push(stateDir);
    mkdirSync(join(stateDir, "chats", chat("claude").id), { recursive: true });
    const { args } = await chatProtocolAdapters.claude.prepare(chat("claude", { approvals: true }), stateDir);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--permission-prompt-tool");
  });

  test("terminal-command carries the bypass flag for both agents", () => {
    expect(chatProtocolAdapters.claude.terminalCommand(chat("claude"))).toEqual(["claude", "--resume", "sess", "--dangerously-skip-permissions", "--model", "m1"]);
    expect(chatProtocolAdapters.codex.terminalCommand(chat("codex"))).toEqual(["codex", "resume", "sess", "--dangerously-bypass-approvals-and-sandbox", "--model", "m1"]);
  });

  test("terminal-command omits the bypass flag when approvals are asked", () => {
    expect(chatProtocolAdapters.claude.terminalCommand(chat("claude", { approvals: true }))).toEqual(["claude", "--resume", "sess", "--model", "m1"]);
    expect(chatProtocolAdapters.codex.terminalCommand(chat("codex", { approvals: true }))).toEqual(["codex", "resume", "sess", "--model", "m1"]);
  });
});

const processAdapter: ProcessAdapter = {
  async run(command) { return failed(`${command} unavailable`); },
  async startDetached(command) { return failed(`${command} unexpectedly detached`); },
  invocationCount() { return 0; },
};

async function codexThreadStart(extraArgs: string[]): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "megabrain-bypass-codex-"));
  directories.push(root);
  const state = join(root, "state"); const cwd = join(root, "project"); const bin = join(root, "bin"); const capture = join(root, "capture.jsonl");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
  const path = join(bin, "codex");
  writeFileSync(path, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") {
    require("node:fs").appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request.params) + "\\n");
    process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "t1" } } }) + "\\n");
  }
});
`);
  chmodSync(path, 0o700);
  const environment = { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: capture };
  const daemon = new ChatDaemon(state, environment);
  await daemon.start(); await daemon.listen();
  try {
    const started = await route(["chat", "start", "--agent", "codex", "--cwd", cwd, ...extraArgs, "--json"], { environment: { ...environment, MEGABRAIN_STATE_DIR: state }, processAdapter });
    expect(started.kind).toBe("ok");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { const line = readFileSync(capture, "utf8").trim(); if (line) return JSON.parse(line) as Record<string, unknown>; } catch { /* not written yet */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("codex thread/start was never captured");
  } finally { await daemon.close(); }
}

describe("codex app-server thread policy", () => {
  test("defaults to never asking and full access", async () => {
    expect(await codexThreadStart([])).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
  test("asks on request inside the workspace with --approvals", async () => {
    expect(await codexThreadStart(["--approvals"])).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  });
});
