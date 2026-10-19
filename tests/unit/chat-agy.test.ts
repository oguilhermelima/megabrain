import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgyLog, sessionLogPath, sessionTurnOpen } from "../../src/chat/session-log.js";
import { ChatStore, type Chat, type ChatCapabilities } from "../../src/chat/store.js";
import { ChatDaemon } from "../../src/chat/daemon.js";

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const transcript = readFileSync(join(import.meta.dir, "../fixtures/chat-agy-transcript.jsonl"), "utf8");
const sessionId = "eaaac49a-ca19-480a-8f26-f6cf6337e7a2";

const agyCapabilities: ChatCapabilities = {
  approvals: false,
  interrupt: false,
  liveModelSwitch: false,
  steer: false,
  structuredTools: true,
};

function agyChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agent: "agy",
    capabilities: agyCapabilities,
    model: "gemini-3.8-flash-low",
    cwd: "/tmp/agy-probe",
    title: null,
    state: "idle",
    mode: "terminal",
    owner: "terminal",
    agentSessionId: sessionId,
    createdAt: "2026-10-17T22:00:00.000Z",
    lastActivityAt: null,
    error: null,
    ...overrides,
  };
}

describe("agy terminal-follow transcript", () => {
  test("starts in the requested native chat mode while the terminal retains ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-agy-start-"));
    directories.push(root);
    const daemon = new ChatDaemon(join(root, "state"), { HOME: root });
    await daemon.start();
    daemons.push(daemon);
    const chat = await daemon.startChat({ operation: "start", agent: "agy", cwd: join(root, "project"), mode: "chat" });
    expect(chat).toMatchObject({ agent: "agy", mode: "chat", owner: "terminal", state: "idle" });
  });

  test("shares the native chat agent union and capability record shape", () => {
    const grokAndAgy: Chat["agent"][] = ["grok", "agy"];
    expect(grokAndAgy).toEqual(["grok", "agy"]);
    expect(agyCapabilities).toEqual({ approvals: false, interrupt: false, liveModelSwitch: false, steer: false, structuredTools: true });
  });

  test("maps captured user, assistant, tool call and denied tool result records", () => {
    const turns = parseAgyLog(transcript);
    expect(turns.map(({ kind }) => kind)).toEqual(["user", "assistant", "user", "assistant", "tool-call", "tool-result"]);
    expect(turns[0]?.text).toBe("Reply with exactly: first");
    expect(turns[1]?.text).toBe("first");
    expect(turns[3]?.text).toBe("second");
    expect(turns[4]).toMatchObject({ kind: "tool-call", tool: { name: "run_command", status: undefined } });
    expect(turns[5]).toMatchObject({ kind: "tool-result", tool: { name: "run_command", status: "error" } });
    expect(turns[5]?.text).toContain("permission check failed");
  });

  test("does not report a completed turn as open, and recognizes an unanswered user input", () => {
    expect(sessionTurnOpen("agy", transcript)).toBe(false);
    const openTurn = JSON.stringify({ type: "USER_INPUT", status: "DONE", step_index: 9, created_at: "2026-10-17T22:10:00Z", content: "<USER_REQUEST>still working?</USER_REQUEST>" });
    expect(sessionTurnOpen("agy", `${openTurn}\n`)).toBe(true);
  });

  test("reads agy's transcript from its conversation directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "megabrain-agy-log-"));
    directories.push(home);
    await expect(sessionLogPath(agyChat(), home)).resolves.toBe(join(home, ".gemini/antigravity-cli/brain", sessionId, ".system_generated/logs/transcript_full.jsonl"));
  });

  test("persists agy and its truthful terminal-follow capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-agy-store-"));
    directories.push(root);
    const store = new ChatStore(root);
    const chat = agyChat();
    await store.put(chat);
    await expect(store.get(chat.id)).resolves.toEqual(chat);
  });
});
