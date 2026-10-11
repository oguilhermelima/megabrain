import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readContextMeter } from "../../src/core/context-meter.js";

let home = "";
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "megabrain-context-meter-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function put(path: string, lines: readonly unknown[]): Promise<void> {
  await mkdir(dirname(join(home, path)), { recursive: true });
  await writeFile(join(home, path), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const thread = "01a12bab-6e7b-7941-ad7a-ac75611f5144";
const rollout = `.codex/sessions/2026/10/11/rollout-2026-10-11T12-53-37-${thread}.jsonl`;
const tokenCount = (info: unknown) => ({ type: "event_msg", payload: { type: "token_count", info } });
const codexInfo = (total: number, window: number | undefined) => ({
  total_token_usage: { total_tokens: 2075068 },
  last_token_usage: { input_tokens: total - 159, output_tokens: 159, total_tokens: total },
  ...(window === undefined ? {} : { model_context_window: window }),
});

describe("Codex rollout", () => {
  test("reads the latest token_count against the model context window", async () => {
    await put(rollout, [tokenCount(null), tokenCount(codexInfo(30000, 258400)), tokenCount(codexInfo(63729, 258400)), tokenCount(null)]);
    expect(await readContextMeter({ agent: "codex", agentThreadId: thread }, home)).toEqual({
      status: "known",
      percentUsed: 24.7,
      sourceFrame: "codex rollout token_count: 63729/258400 tokens",
    });
  });

  test("is unknown when no token_count carries info, the window is missing or zero, or the file is absent", async () => {
    await put(rollout, [tokenCount(null)]);
    expect(await readContextMeter({ agent: "codex", agentThreadId: thread }, home)).toEqual({ status: "unknown" });
    await put(rollout, [tokenCount(codexInfo(1000, undefined))]);
    expect(await readContextMeter({ agent: "codex", agentThreadId: thread }, home)).toEqual({ status: "unknown" });
    await put(rollout, [tokenCount(codexInfo(1000, 0))]);
    expect(await readContextMeter({ agent: "codex", agentThreadId: thread }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "codex", agentThreadId: "00000000-0000-0000-0000-000000000000" }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "codex" }, home)).toEqual({ status: "unknown" });
  });

  test("skips a torn or malformed line and still reads the tail of a large rollout", async () => {
    const padding = Array.from({ length: 40 }, () => ({ type: "response_item", payload: { text: "x".repeat(20000) } }));
    await put(rollout, [tokenCount(codexInfo(1000, 258400)), ...padding, tokenCount(codexInfo(129200, 258400))]);
    await writeFile(join(home, rollout), "{not json\n", { flag: "a" });
    expect(await readContextMeter({ agent: "codex", agentThreadId: thread }, home)).toMatchObject({ status: "known", percentUsed: 50 });
  });
});

const session = "2c491989-4483-4f1b-8539-780e56416701";
const transcript = `.claude/projects/-tmp-work-tree/${session}.jsonl`;
const assistant = (model: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { model, usage }, ...extra });
const usage = { input_tokens: 2, cache_creation_input_tokens: 1271, cache_read_input_tokens: 95984, output_tokens: 389 };

describe("Claude transcript", () => {
  test("sums input, cache read and cache creation of the latest assistant entry over a 200k window", async () => {
    await put(transcript, [assistant("claude-sonnet-5-5", { ...usage, cache_read_input_tokens: 1000 }), { type: "user" }, assistant("claude-sonnet-5-5", usage)]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toEqual({
      status: "known",
      percentUsed: 48.6,
      sourceFrame: "claude transcript usage: 97257/200000 tokens",
    });
  });

  test("uses a 1M window only for a 1M model variant", async () => {
    await put(transcript, [assistant("claude-opus-5-5[1m]", usage)]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toMatchObject({ status: "known", percentUsed: 9.7 });
  });

  test("ignores sidechain and synthetic entries", async () => {
    await put(transcript, [
      assistant("claude-sonnet-5-5", usage),
      assistant("claude-sonnet-5-5", { input_tokens: 150000 }, { isSidechain: true }),
      assistant("<synthetic>", { input_tokens: 0 }),
    ]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toMatchObject({ status: "known", percentUsed: 48.6 });
  });

  test("is unknown without a usage entry, a session id or a matching file", async () => {
    await put(transcript, [{ type: "user" }, { type: "assistant", message: { model: "claude-sonnet-5-5" } }]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "claude" }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "claude", agentSessionId: "other-session" }, home)).toEqual({ status: "unknown" });
  });
});

test("agy and unknown agents have no structured source and stay unknown", async () => {
  await put(transcript, [assistant("claude-sonnet-5-5", usage)]);
  expect(await readContextMeter({ agent: "agy", agentSessionId: session, agentThreadId: thread }, home)).toEqual({ status: "unknown" });
  expect(await readContextMeter({ agent: "other", agentSessionId: session }, home)).toEqual({ status: "unknown" });
});
