import { afterEach, describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeArtifact } from "../../src/cli/commands/artifact.js";
import { executeChat } from "../../src/cli/commands/chat.js";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { claudeLogPath } from "../../src/chat/session-log.js";
import { ChatStore, type ChatLine } from "../../src/chat/store.js";
import { createArtifact, listArtifacts, updateArtifact } from "../../src/knowledge/artifacts.js";
import { usageText } from "../../src/core/usage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const remoteFixture = readFileSync(join(import.meta.dir, "../fixtures/chat-artifacts/claude-artifact.jsonl"), "utf8");
const designFixture = readFileSync(join(import.meta.dir, "../fixtures/chat-artifacts/claude-design.jsonl"), "utf8");

function world(agentSessionId = "11111111-1111-4111-8111-111111111111") {
  const root = mkdtempSync(join(tmpdir(), "megabrain-chat-artifacts-"));
  roots.push(root);
  const state = join(root, "state"), cwd = join(root, "project");
  mkdirSync(state, { recursive: true }); mkdirSync(cwd);
  const chat = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", agent: "claude" as const, model: null, cwd, title: "Chat", state: "idle" as const, mode: "chat" as const, agentSessionId, createdAt: "2026-10-17T00:00:00.000Z", lastActivityAt: null };
  return { root, state, cwd, chat, environment: { HOME: root, MEGABRAIN_STATE_DIR: state } };
}

async function transcript(w: ReturnType<typeof world>, contents: string): Promise<void> {
  await new ChatStore(w.state).put(w.chat);
  const target = claudeLogPath(w.root, w.cwd, w.chat.agentSessionId ?? "");
  mkdirSync(join(target, ".."), { recursive: true });
  const rewritten = contents
    .replaceAll("11111111-1111-4111-8111-111111111111", w.chat.agentSessionId ?? "")
    .replaceAll("22222222-2222-4222-8222-222222222222", w.chat.agentSessionId ?? "")
    .replaceAll("/Users/operator", w.root);
  writeFileSync(target, rewritten);
  return;
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

describe("chat artifact CLI", () => {
  test("lists megabrain and Claude artifacts newest first with stable ids", async () => {
    const w = world();
    await transcript(w, remoteFixture);
    await createArtifact(w.state, { title: "Local note", kind: "doc", content: "# Local\n", format: "markdown", project: w.cwd, topics: [], chatId: w.chat.id, now: "2026-10-17T12:02:30.000Z" });
    const first = await executeChat(["artifacts", w.chat.id, "--json"], w.environment, undefined as never);
    const second = await executeChat(["artifacts", w.chat.id, "--json"], w.environment, undefined as never);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok" || second.kind !== "ok") return;
    const result = JSON.parse(first.value) as { artifacts: { id: string; source: string; title: string; format: string; url?: string; path?: string; updatedAt: string; revision: number | null; editable: boolean }[] };
    expect(result.artifacts.map((artifact) => artifact.source)).toEqual(["megabrain", "claude-artifact", "claude-artifact"]);
    expect(result.artifacts.find((artifact) => artifact.title === "Published report")).toMatchObject({ source: "claude-artifact", title: "Published report", format: "url", url: "https://claude.ai/artifact/redacted-published", revision: null, editable: false });
    expect(result.artifacts[0]?.id).toMatch(/^art-/);
    expect(result.artifacts[1]?.id).toMatch(/^claude-artifact:/);
    expect(JSON.parse(second.value)).toEqual(result);
  });

  test("classifies a Claude Design publication only when its matching result names a Design type", async () => {
    const w = world("22222222-2222-4222-8222-222222222222");
    await transcript(w, designFixture);
    const listed = await executeChat(["artifacts", w.chat.id, "--json"], w.environment, undefined as never);
    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") return;
    expect(JSON.parse(listed.value)).toMatchObject({ artifacts: [{ source: "claude-design", title: "Design handoff", format: "url", url: "https://claude.ai/artifact/redacted-design" }] });
  });

  test("lists and reads a Claude publication backed by a local file", async () => {
    const w = world();
    const localPath = join(w.root, ".claude/jobs/redacted/scratchpad/project/canvas.json");
    mkdirSync(join(localPath, ".."), { recursive: true });
    writeFileSync(localPath, '{"project":"local"}\n');
    await transcript(w, remoteFixture);
    const listed = await executeChat(["artifacts", w.chat.id, "--json"], w.environment, undefined as never);
    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") return;
    const artifacts = (JSON.parse(listed.value) as { artifacts: { id: string; source: string; path?: string; format: string }[] }).artifacts;
    const local = artifacts.find((artifact) => artifact.path === localPath);
    expect(local).toMatchObject({ source: "claude-artifact", format: "text" });
    if (!local) return;
    const shown = await executeChat(["artifact", w.chat.id, local.id, "--json"], w.environment, undefined as never);
    expect(shown.kind).toBe("ok");
    if (shown.kind !== "ok") return;
    expect(JSON.parse(shown.value)).toMatchObject({ artifact: { path: localPath }, content: '{"project":"local"}\n' });
  });

  test("reads local content, strips Google Fonts, and returns an explanatory null at the byte cap", async () => {
    const w = world();
    await new ChatStore(w.state).put(w.chat);
    const artifact = await createArtifact(w.state, { title: "HTML", kind: "diagram", content: '<html><head><link href="https://fonts.googleapis.com/css?family=Geist" rel="stylesheet"></head><body>ok</body></html>', format: "html", project: w.cwd, topics: [], chatId: w.chat.id });
    expect(artifact.kind).toBe("ok");
    if (artifact.kind !== "ok") return;
    const shown = await executeChat(["artifact", w.chat.id, artifact.value.id, "--json"], w.environment, undefined as never);
    expect(shown.kind).toBe("ok");
    if (shown.kind !== "ok") return;
    const body = JSON.parse(shown.value) as { artifact: { format: string }; content: string | null; updatedAt: string; reason?: string };
    expect(body.artifact.format).toBe("html");
    expect(body.content).not.toContain("fonts.googleapis.com");
    expect(body.content).toContain("<body>ok</body>");
    const large = await createArtifact(w.state, { title: "Large", kind: "doc", content: "x".repeat(1024 * 1024), format: "markdown", project: w.cwd, topics: [], chatId: w.chat.id });
    expect(large.kind).toBe("ok");
    if (large.kind !== "ok") return;
    writeFileSync(large.value.path, "x".repeat(1024 * 1024 + 1));
    const capped = await executeChat(["artifact", w.chat.id, large.value.id, "--json"], w.environment, undefined as never);
    expect(capped.kind).toBe("ok");
    if (capped.kind !== "ok") return;
    expect(JSON.parse(capped.value)).toMatchObject({ content: null, reason: expect.any(String) });
  });

  test("automatically links artifact create to its chat while explicit --chat takes precedence", async () => {
    const w = world();
    const auto = await executeArtifact(["create", "--title", "Automatic", "--kind", "doc", "--stdin", "--json"], { ...w.environment, MEGABRAIN_CHAT_ID: w.chat.id }, { cwd: w.cwd, stdin: async () => "# automatic" });
    expect(auto.kind).toBe("ok");
    if (auto.kind !== "ok") return;
    const autoArtifact = JSON.parse(auto.value) as { chatId: string | null };
    expect(autoArtifact.chatId).toBe(w.chat.id);
    const explicit = await executeArtifact(["create", "--title", "Explicit", "--kind", "doc", "--stdin", "--chat", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "--json"], { ...w.environment, MEGABRAIN_CHAT_ID: w.chat.id }, { cwd: w.cwd, stdin: async () => "# explicit" });
    expect(explicit.kind).toBe("ok");
    if (explicit.kind !== "ok") return;
    expect((JSON.parse(explicit.value) as { chatId: string | null }).chatId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  test("publishes live-only artifacts events when the list changes and stays quiet otherwise", async () => {
    const w = world();
    await new ChatStore(w.state).put(w.chat);
    const daemon = new ChatDaemon(w.state, { ...w.environment, MEGABRAIN_KNOWLEDGE_SCANNER: "off" });
    await daemon.start(); await daemon.listen();
    const lines: ChatLine[] = [];
    const socket = createConnection(join(w.state, "chatd", "s"));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ operation: "events", id: w.chat.id, since: 0, follow: true }) + "\n"));
    socket.on("data", (chunk: string) => { buffer += chunk; let end: number; while ((end = buffer.indexOf("\n")) !== -1) { lines.push(JSON.parse(buffer.slice(0, end)) as ChatLine); buffer = buffer.slice(end + 1); } });
    try {
      await waitFor(() => lines.some((line) => line.event?.kind === "state"), "initial follow event");
      await createArtifact(w.state, { title: "Added", kind: "doc", content: "new", format: "markdown", project: w.cwd, topics: [], chatId: w.chat.id });
      await waitFor(() => lines.some((line) => line.event?.kind === "artifacts"), "artifact list change");
      const update = lines.find((line) => line.event?.kind === "artifacts");
      expect(update?.cursor).toBe("");
      expect((await daemon.store.events(w.chat.id)).some((line) => line.event?.kind === "artifacts")).toBe(false);
      const count = lines.filter((line) => line.event?.kind === "artifacts").length;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(lines.filter((line) => line.event?.kind === "artifacts")).toHaveLength(count);
      const artifact = (await listArtifacts(w.state, { project: w.cwd }))[0];
      expect(artifact).toBeDefined();
      if (!artifact) return;
      await updateArtifact(w.state, artifact.id, { content: "changed", format: "markdown" });
      await waitFor(() => lines.filter((line) => line.event?.kind === "artifacts").length > count, "artifact content change");
    } finally { socket.destroy(); await daemon.close(); }
  });

  test("documents both new chat artifact verbs in chat help", () => {
    const usage = usageText("chat");
    expect(usage).toContain("artifacts <chat-id> --json");
    expect(usage).toContain("artifact <chat-id> <artifact-id> --json");
  });
});
