import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import type { Chat, ChatEvent, ChatLine } from "../../src/chat/store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// What claude -p --output-format stream-json printed for /cost (captured 2026-10-17): a local command's
// output is an assistant message from the <synthetic> model, then a result with no turns. A model reply
// carries a msg_ id and a real model; "No response requested." is synthetic too but answers no command.
const cost = "Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 0s\nTotal code changes:    0 lines added, 0 lines removed\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write";
const synthetic = (id: string, text: string) => ({ type: "assistant", message: { id, model: "<synthetic>", role: "assistant", type: "message", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, session_id: "command-session" });
const modelReply = (text: string) => ({ type: "assistant", message: { id: "msg_01review", model: "claude-opus-5-5", role: "assistant", type: "message", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null, session_id: "command-session" });
const result = { type: "result", subtype: "success", is_error: false, num_turns: 0, session_id: "command-session", modelUsage: {} };
const answers: Record<string, unknown[]> = {
  "/cost": [synthetic("2b5bc910-a7b3-4f15-9602-b4138e2e6516", cost), result],
  "/review src/app.ts": [modelReply("The change looks right."), result],
  "hello": [synthetic("21c3863d-c2ff-4fa1-9460-dd018b412a52", "No response requested."), result],
};

async function until(check: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out: ${label}`);
}

describe("chat command output", () => {
  test("marks a local command's output with the command it answers, and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-command-output-"));
    directories.push(root);
    const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
    mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!${process.execPath}
const answers = ${JSON.stringify(answers)};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "command-session" }) + "\\n");
rl.on("line", (line) => {
  const content = JSON.parse(line).message.content;
  const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("");
  for (const row of answers[text.trim()] ?? []) process.stdout.write(JSON.stringify(row) + "\\n");
});
`);
    chmodSync(join(bin, "claude"), 0o700);
    const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
    await daemon.start();
    await daemon.listen();
    try {
      const chat = await daemon.handle({ operation: "start", agent: "claude", cwd }) as Chat;
      const said = async () => ((await daemon.handle({ operation: "events", id: chat.id, since: 0 })) as ChatLine[])
        .flatMap((line) => line.event !== undefined && line.event.kind === "assistant" ? [line.event] : []);
      for (const [index, text] of ["/cost", "/review src/app.ts", "hello"].entries()) {
        await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text }] });
        await until(async () => (await said()).length === index + 1, `answer to ${text}`);
      }
      const replies = (await said()).map((event: ChatEvent) => ({ text: event.text, command: (event as ChatEvent & { command?: string }).command }));
      expect(replies).toEqual([
        { text: cost, command: "/cost" },
        { text: "The change looks right.", command: undefined },
        { text: "No response requested.", command: undefined },
      ]);
    } finally { await daemon.close(); }
  });
});
