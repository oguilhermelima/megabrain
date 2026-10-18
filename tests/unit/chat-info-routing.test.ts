import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import type { Chat, ChatEvent, ChatLine } from "../../src/chat/store.js";

const roots: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native chat info routing", () => {
  test("Codex /status publishes measured chat and rollout data without a turn/start request", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-info-routing-"));
    roots.push(root);
    const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin"), requests = join(root, "requests.jsonl");
    mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
    const codex = join(bin, "codex");
    writeFileSync(codex, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(requests)}, line + "\\n");
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "info-thread" } } }) + "\\n");
});
`);
    chmodSync(codex, 0o700);
    const rolloutDirectory = join(root, ".codex", "sessions", "2026", "10", "17");
    mkdirSync(rolloutDirectory, { recursive: true });
    const rollout = join(rolloutDirectory, "rollout-2026-10-17T12-00-00-info-thread.jsonl");
    writeFileSync(rollout, readFileSync(join(import.meta.dir, "../fixtures/codex-rollout-rate-limits.jsonl")));
    utimesSync(rollout, new Date(), new Date());

    const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
    daemons.push(daemon);
    await daemon.start(); await daemon.listen();
    const chat = await daemon.handle({ operation: "start", agent: "codex", cwd, model: "gpt-5-codex", effort: "high", approvals: true }) as Chat;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await daemon.store.get(chat.id))?.state === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const current = await daemon.store.get(chat.id);
    expect(current).not.toBeNull();
    if (!current) throw new Error("chat did not initialize");
    current.contextTokens = 63729; current.contextWindow = 258400;
    await daemon.store.put(current);

    await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "/status" }] });
    const events = (await daemon.handle({ operation: "events", id: chat.id, since: 0 }) as ChatLine[]).flatMap((line) => line.event ? [line.event] : []);
    const output = events.find((event) => event.kind === "command-output") as (ChatEvent & { data?: Record<string, unknown> }) | undefined;
    expect(output).toMatchObject({ command: "/status", agent: "codex", source: "megabrain", data: { model: "gpt-5-codex", effort: "high", approvals: "on", cwd, context: { used: 63729, window: 258400, percent: 24.7 } } });
    expect(output?.data?.limits).toContainEqual(expect.objectContaining({ label: "5h", usedPercent: 73, window: "5h" }));
    const recorded = readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string });
    expect(recorded.some((request) => request.method === "turn/start")).toBe(false);
  });
});
