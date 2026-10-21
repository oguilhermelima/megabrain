import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatLine } from "../../src/chat/store.js";
import { chatProtocolAdapters } from "../../src/chat/protocol.js";
import { MAX_SEED_CONTEXT_BYTES, seedContext } from "../../src/chat/daemon/chat-turns.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("chat seed context", () => {
  test("keeps a long Claude seed out of argv in a private file", async () => {
    const state = mkdtempSync(join(tmpdir(), "megabrain-chat-seed-"));
    directories.push(state);
    const chat: Chat = {
      id: "seed-chat", agent: "claude", model: null, cwd: state, title: null, state: "idle", mode: "chat",
      agentSessionId: null, createdAt: new Date().toISOString(), lastActivityAt: null, seedContext: "latest conversation turn ".repeat(60_000),
    };

    const invocation = await chatProtocolAdapters.claude.prepare(chat, state);
    const flag = invocation.args.indexOf("--append-system-prompt-file");
    expect(flag).toBeGreaterThanOrEqual(0);
    const path = invocation.args[flag + 1];
    expect(path).toBe(join(state, "chats", chat.id, "seed-context.txt"));
    expect(invocation.args.join(" ").length).toBeLessThan(10_000);
    expect(readFileSync(path!, "utf8")).toContain("latest conversation turn");
    expect(statSync(path!).mode & 0o777).toBe(0o600);
  });

  test("bounds the seed while retaining the newest complete turn", () => {
    const lines: ChatLine[] = [
      { cursor: "1", event: { kind: "user", id: "old", at: "", text: "old turn ".repeat(30_000) } },
      { cursor: "2", event: { kind: "assistant", id: "old-answer", at: "", text: "old answer" } },
      { cursor: "3", event: { kind: "user", id: "new", at: "", text: "newest turn" } },
      { cursor: "4", event: { kind: "assistant", id: "new-answer", at: "", text: "newest answer" } },
    ];

    const seed = seedContext(lines);
    expect(Buffer.byteLength(seed)).toBeLessThanOrEqual(MAX_SEED_CONTEXT_BYTES);
    expect(seed).toContain("newest turn");
    expect(seed).toContain("newest answer");
    expect(seed).toContain("Earlier turns were omitted");
    expect(seed).not.toContain("old turn");
  });
});
