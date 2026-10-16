import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import type { Chat } from "../../src/chat/store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// The recorded stream with Claude's system/init row carrying its slash_commands, as stream-json prints it.
const recorded = readFileSync(join(process.cwd(), "tests/fixtures/chat-claude-stream.jsonl"), "utf8").trim().split("\n");
const init = JSON.stringify({ type: "system", subtype: "init", session_id: "stream-session", slash_commands: ["compact", "add-dir", "review", 42] });
const stream = [init, ...recorded.slice(1)];

async function until(check: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out: ${label}`);
}

describe("chat init commands", () => {
  test("keeps the slash commands Claude reports at init on the chat record", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-init-commands-"));
    directories.push(root);
    const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
    mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!${process.execPath}
const rows = ${JSON.stringify(stream)};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async () => { for (const row of rows) { process.stdout.write(row + "\\n"); await new Promise((r) => setTimeout(r, 5)); } });
`);
    chmodSync(join(bin, "claude"), 0o700);
    const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
    await daemon.start();
    await daemon.listen();
    try {
      const chat = await daemon.handle({ operation: "start", agent: "claude", cwd }) as Chat;
      expect(chat.slashCommands).toBeUndefined();
      await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
      const current = async () => ((await daemon.handle({ operation: "list" })) as Chat[]).find((entry) => entry.id === chat.id);
      await until(async () => (await current())?.slashCommands !== undefined, "init commands saved");
      expect((await current())?.slashCommands).toEqual(["compact", "add-dir", "review"]);
    } finally { await daemon.close(); }
  });
});
