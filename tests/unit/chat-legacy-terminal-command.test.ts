import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("wraps a terminal command returned as a string array by an older chatd", async () => {
  const root = mkdtempSync(join(tmpdir(), "megabrain-legacy-chatd-"));
  directories.push(root);
  const state = join(root, "state");
  mkdirSync(join(state, "chatd"), { recursive: true, mode: 0o700 });
  const chatId = "legacy-chat-id";
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { operation: string };
      const value = request.operation === "hello" ? { protocol: { version: 3, min: 1, max: 3 } } : ["claude", "--resume", "session"];
      socket.end(`${JSON.stringify({ ok: true, value })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(state, "chatd", "s"), resolve));
  const processAdapter: ProcessAdapter = {
    async run(command) { return failed(`${command} unavailable`); },
    async startDetached(command) { return failed(`${command} unexpectedly detached`); },
    invocationCount() { return 0; },
  };
  try {
    const result = await route(["chat", "terminal-command", chatId, "--json"], {
      environment: { HOME: root, MEGABRAIN_STATE_DIR: state },
      processAdapter,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(JSON.parse(result.value)).toEqual({
      argv: ["claude", "--resume", "session"],
      env: { MEGABRAIN_CONTEXT_INJECTED: "1", MEGABRAIN_CHAT_ID: chatId },
    });
  } finally {
    server.close();
  }
});
