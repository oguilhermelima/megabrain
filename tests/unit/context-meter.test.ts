import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findClaudeTranscriptForWorktree, readContextMeter, resolveGrokSessionId } from "../../src/core/context-meter.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { ok, failed } from "../../src/core/result.js";

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
      usedTokens: 63729,
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
  test("finds a worktree session that starts with Claude metadata", async () => {
    const cwd = "/Users/operator/Workspaces/Worktrees/feat_orchestrate.transcript";
    const createdAt = "2026-10-15T05:33:54.000Z";
    const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const sessionPath = join(home, ".claude", "projects", project, `${session}.jsonl`);
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, await readFile(new URL("../fixtures/claude-session-metadata.jsonl", import.meta.url), "utf8"));

    expect(await findClaudeTranscriptForWorktree(home, cwd, createdAt)).toBe(sessionPath);
  });

  test("sums input, cache read and cache creation of the latest assistant entry over the registry window", async () => {
    await put(transcript, [assistant("claude-sonnet-5-5", { ...usage, cache_read_input_tokens: 1000 }), { type: "user" }, assistant("claude-sonnet-5-5", usage)]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session, contextWindow: 200000 }, home)).toEqual({
      status: "known",
      usedTokens: 97257,
      percentUsed: 48.6,
      sourceFrame: "claude transcript usage: 97257/200000 tokens",
    });
  });

  test("a plain model id above 200000 tokens proves a 1M window", async () => {
    await put(transcript, [assistant("claude-opus-5-5", { input_tokens: 5, cache_read_input_tokens: 372000, cache_creation_input_tokens: 800 })]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toEqual({
      status: "known",
      usedTokens: 372805,
      percentUsed: 37.3,
      sourceFrame: "claude transcript usage: 372805/1000000 tokens",
    });
  });

  test("an earlier entry above 200000 tokens proves 1M for a later smaller one", async () => {
    await put(transcript, [assistant("claude-opus-5-5", { input_tokens: 250000 }), assistant("claude-opus-5-5", { input_tokens: 50000 })]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toMatchObject({ status: "known", usedTokens: 50000, percentUsed: 5 });
  });

  test("a plain model id at 50000 tokens with no registry window has tokens but no percentage", async () => {
    await put(transcript, [assistant("claude-opus-5-5", { input_tokens: 50000 })]);
    const meter = await readContextMeter({ agent: "claude", agentSessionId: session }, home);
    expect(meter).toEqual({ status: "known", usedTokens: 50000, sourceFrame: "claude transcript usage: 50000 tokens, window unknown" });
    expect("percentUsed" in meter).toBe(false);
  });

  test("the registry window wins over the 1M proof", async () => {
    await put(transcript, [assistant("claude-opus-5-5", { input_tokens: 372805 })]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session, contextWindow: 400000 }, home)).toMatchObject({ status: "known", usedTokens: 372805, percentUsed: 93.2 });
  });

  test("uses a 1M window for a 1M model variant marker", async () => {
    await put(transcript, [assistant("claude-opus-5-5[1m]", usage)]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toMatchObject({ status: "known", usedTokens: 97257, percentUsed: 9.7 });
  });

  test("ignores sidechain and synthetic entries", async () => {
    await put(transcript, [
      assistant("claude-sonnet-5-5", usage),
      assistant("claude-sonnet-5-5", { input_tokens: 150000 }, { isSidechain: true }),
      assistant("<synthetic>", { input_tokens: 0 }),
    ]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session, contextWindow: 200000 }, home)).toMatchObject({ status: "known", percentUsed: 48.6 });
  });

  test("is unknown without a usage entry, a session id or a matching file", async () => {
    await put(transcript, [{ type: "user" }, { type: "assistant", message: { model: "claude-sonnet-5-5" } }]);
    expect(await readContextMeter({ agent: "claude", agentSessionId: session }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "claude" }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "claude", agentSessionId: "other-session" }, home)).toEqual({ status: "unknown" });
  });
});

describe("Grok session updates", () => {
  const cwd = "/tmp/work-tree";
  const sessionId = "01a12f51-a1d5-7092-8591-2f5b3c981710";
  const updates = `.grok/sessions/${encodeURIComponent(cwd)}/${sessionId}/updates.jsonl`;
  const completed = (totalTokens: number) => ({
    method: "_x.ai/session/update",
    params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens } } },
  });

  test("reads the latest turn_completed usage for the exact Grok session", async () => {
    await put(updates, [completed(9000), completed(78240)]);
    expect(await readContextMeter({ agent: "grok", agentSessionId: sessionId, agentCwd: cwd, contextWindow: 256000 }, home)).toEqual({
      status: "known",
      usedTokens: 78240,
      percentUsed: 30.6,
      sourceFrame: "grok session usage: 78240/256000 tokens",
    });
  });

  test("requires an exact active Grok PID in the pane process tree and matching cwd", async () => {
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeFile(join(home, ".grok", "active_sessions.json"), JSON.stringify([
      { session_id: sessionId, pid: 102, cwd },
      { session_id: "other", pid: 203, cwd },
    ]));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command !== "ps" || args.join(" ") !== "-ax -o pid=,ppid=,command=") return failed("unexpected command");
        return ok({ stdout: "100 1 zsh\n102 100 /Users/test/.grok/bin/grok\n203 1 /Users/test/.grok/bin/grok\n300 1 zsh\n", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 1; },
    };
    expect(await resolveGrokSessionId(home, "100", cwd, process)).toBe(sessionId);
    expect(await resolveGrokSessionId(home, "300", cwd, process)).toBeUndefined();
    expect(await resolveGrokSessionId(home, "100", "/other", process)).toBeUndefined();
  });

  test("keeps Grok usage unknown without a valid completion or exact session", async () => {
    await put(updates, [{ method: "_x.ai/session/update", params: { update: { sessionUpdate: "agent_message_chunk", usage: { totalTokens: 9000 } } } }]);
    expect(await readContextMeter({ agent: "grok", agentSessionId: sessionId, agentCwd: cwd, contextWindow: 256000 }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "grok", agentSessionId: "other", agentCwd: cwd, contextWindow: 256000 }, home)).toEqual({ status: "unknown" });
  });
});

test("agy and unknown agents have no structured source and stay unknown", async () => {
  await put(transcript, [assistant("claude-sonnet-5-5", usage)]);
  expect(await readContextMeter({ agent: "agy", agentSessionId: session, agentThreadId: thread }, home)).toEqual({ status: "unknown" });
  expect(await readContextMeter({ agent: "other", agentSessionId: session }, home)).toEqual({ status: "unknown" });
});

// Shapes from Antigravity CLI 1.3.3: its --log-file names the conversation it creates, and the
// conversation's transcript_full.jsonl records token counts on each model response.
describe("Antigravity conversation", () => {
  const conversation = "f65ead73-be3a-4ff6-a3a0-1ebbce9549bc";
  const later = "0b8c1f2e-1111-4a2b-9c3d-222233334444";
  const transcriptOf = (id: string) => `.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`;
  const response = (input: number, cached: number) => ({ step_index: 9, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-12T09:57:47Z", input_tokens: input, cache_read_tokens: cached, output_tokens: 463, content: "done" });
  const log = async (lines: readonly string[]): Promise<string> => {
    const path = join(home, "agy.log");
    await writeFile(path, `${lines.join("\n")}\n`);
    return path;
  };

  test("reads the latest model response of the conversation its log created", async () => {
    await put(transcriptOf(conversation), [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "task" },
      response(1000, 20000),
      response(2510, 101889),
      { step_index: 10, source: "SYSTEM", type: "CHECKPOINT", status: "DONE" },
    ]);
    const agyLogFile = await log([
      "I1012 13:46:52.167050     462 manager.go:1410] Slash commands unchanged, skipping update",
      `I1012 13:47:54.576791     948 server.go:1278] Created conversation ${conversation}`,
      `I1012 13:47:54.579546     948 conversation_manager.go:969] Streaming conversation ${conversation}`,
    ]);
    expect(await readContextMeter({ agent: "agy", agyLogFile, contextWindow: 1000000 }, home)).toEqual({
      status: "known", usedTokens: 104399, percentUsed: 10.4, sourceFrame: "agy transcript usage: 104399/1000000 tokens",
    });
  });

  test("follows the newest conversation the session created", async () => {
    await put(transcriptOf(conversation), [response(2510, 101889)]);
    await put(transcriptOf(later), [response(300, 4700)]);
    const agyLogFile = await log([
      `I1012 13:47:54.576791     948 server.go:1278] Created conversation ${conversation}`,
      `I1012 14:02:11.000001     948 server.go:1278] Created conversation ${later}`,
    ]);
    expect(await readContextMeter({ agent: "agy", agyLogFile }, home)).toEqual({
      status: "known", usedTokens: 5000, sourceFrame: "agy transcript usage: 5000 tokens, window unknown",
    });
  });

  test("is unknown without a log, a created conversation or a model response", async () => {
    expect(await readContextMeter({ agent: "agy", agyLogFile: join(home, "missing.log") }, home)).toEqual({ status: "unknown" });
    expect(await readContextMeter({ agent: "agy", agyLogFile: await log(["I1012 nothing yet"]) }, home)).toEqual({ status: "unknown" });
    await put(transcriptOf(conversation), [{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "task" }]);
    expect(await readContextMeter({ agent: "agy", agyLogFile: await log([`I1012 server.go:1278] Created conversation ${conversation}`]) }, home)).toEqual({ status: "unknown" });
  });
});
