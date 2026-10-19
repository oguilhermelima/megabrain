import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyStateDatabase, stateDatabase } from "../../src/adapters/state-db.js";
import { write } from "../../src/adapters/state/shared.js";
import { usageStats } from "../../src/adapters/usage-logs.js";
import { executeUsage } from "../../src/cli/commands/usage.js";
import { costOf, priceOf, PRICES_AS_OF } from "../../src/core/usage-prices.js";
import { parseClaudeLog, parseCodexRollout, parseGrokUsage } from "../../src/core/usage-stats.js";

// The fixtures are real log shapes from Claude Code, Codex and Grok with every prompt and answer
// redacted. All dates are read in UTC here, so a day is the same day on any machine.
const fixtureHome = join(import.meta.dir, "../fixtures/usage/home");
const claudeLog = join(fixtureHome, ".claude/projects/-work-api/5f1c-session.jsonl");
const codexLog = join(fixtureHome, ".codex/sessions/2026/10/15/rollout-2026-10-15T12-00-00-01a0cccc.jsonl");
const grokUsage = join(fixtureHome, ".grok/sessions/%2Fwork%2Fcli/01a1306c-gggg/usage.json");
const now = new Date("2026-10-16T12:00:00Z");
const timeZone = "UTC";

const roots: string[] = [];
function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A copy of the fixture home, so a test may change a log, and an empty state directory. */
function sandbox(): { home: string; stateDir: string; environment: Record<string, string> } {
  const home = temporary("megabrain-usage-home-");
  cpSync(fixtureHome, home, { recursive: true });
  const stateDir = temporary("megabrain-usage-state-");
  return { home, stateDir, environment: { HOME: home, MEGABRAIN_STATE_DIR: stateDir } };
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

describe("parsing one log", () => {
  test("Claude: a message split over several lines counts once, thinking is reasoning, synthetic and meta lines are not usage or turns", () => {
    const usage = parseClaudeLog(readFileSync(claudeLog, "utf8"), timeZone);
    expect(usage.session).toBe("5f1c-session");
    expect(usage.project).toBe("/work/api");
    expect(usage.days).toEqual({
      "2026-10-14": { turns: 1, models: { "claude-opus-5-5": { input: 15, output: 250, cacheRead: 11000, cacheWrite: 1000, reasoning: 50 } } },
      "2026-10-15": { turns: 1, models: { "claude-haiku-4-5": { ...zero, input: 100, output: 10 } } },
    });
    expect(usage.lastModel).toBe("claude-haiku-4-5");
    expect(usage.firstAt).toBe("2026-10-14T10:00:00.000Z");
    expect(usage.lastAt).toBe("2026-10-15T09:00:01.000Z");
  });

  test("Codex: each token_count adds what the running total grew by, cached input is a cache read, reasoning comes out of output", () => {
    const usage = parseCodexRollout(readFileSync(codexLog, "utf8"), timeZone);
    expect(usage.session).toBe("01a0cccc");
    expect(usage.project).toBe("/work/web");
    expect(usage.days).toEqual({
      "2026-10-15": { turns: 1, models: { "gpt-5.5": { ...zero, input: 7000, output: 140, cacheRead: 13000, reasoning: 60 } } },
      "2026-10-16": { turns: 1, models: { "gpt-6-luna": { ...zero, input: 1000, output: 100 } } },
    });
    expect(usage.lastModel).toBe("gpt-6-luna");
  });

  test("Grok: each turn lands on the day it ended, per model", () => {
    const usage = parseGrokUsage(readFileSync(grokUsage, "utf8"), "/work/cli", timeZone);
    expect(usage.session).toBe("01a1306c-gggg");
    expect(usage.project).toBe("/work/cli");
    expect(usage.days).toEqual({
      "2026-10-16": { turns: 2, models: { "grok-4.7-build": { ...zero, input: 600, output: 50, cacheRead: 1000, reasoning: 30 } } },
    });
  });

  test("a day follows the time zone it is read in", () => {
    const usage = parseCodexRollout(readFileSync(codexLog, "utf8"), "America/Sao_Paulo");
    // 01:00 UTC on the 16th is 22:00 on the 15th in São Paulo.
    expect(Object.keys(usage.days)).toEqual(["2026-10-15"]);
  });
});

describe("the price table", () => {
  test("names its date and prices a model by its family, a context suffix included", () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(priceOf("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(priceOf("claude-opus-5-5[1m]")).toEqual(priceOf("claude-opus-5-5"));
    expect(priceOf("claude-haiku-4-5")).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(priceOf("a-model-nobody-priced")).toBeNull();
  });

  test("cost is per million tokens, reasoning at the output price; an unpriced model has no cost", () => {
    expect(costOf("claude-opus-5-5", { input: 15, output: 250, cacheRead: 11000, cacheWrite: 1000, reasoning: 50 })).toBeCloseTo(0.01326, 10);
    expect(costOf("a-model-nobody-priced", { ...zero, input: 1_000_000 })).toBeNull();
  });
});

describe("usage stats across providers", () => {
  test("totals per day and per provider, best day, active days, cache share, top models and projects", async () => {
    const { environment } = sandbox();
    const report = await usageStats(environment, { days: null, provider: null, now, timeZone });
    expect(report.totals).toEqual({ input: 8715, output: 550, cacheRead: 25000, cacheWrite: 1000, reasoning: 140, total: 35405, sessions: 3, turns: 6, cost: expect.closeTo(0.01341, 10), unpricedTokens: 22980 });
    expect(report.daily).toEqual([
      { date: "2026-10-14", total: 12315, byProvider: { claude: 12315 } },
      { date: "2026-10-15", total: 20310, byProvider: { claude: 110, codex: 20200 } },
      { date: "2026-10-16", total: 2780, byProvider: { codex: 1100, grok: 1680 } },
    ]);
    expect(report.activeDays).toBe(3);
    expect(report.bestDay).toEqual({ date: "2026-10-15", total: 20310 });
    expect(report.cacheShare).toBeCloseTo(25000 / 34715, 10);
    expect(report.trackingSince).toBe("2026-10-14");
    expect(report.models.map((entry) => [entry.provider, entry.model, entry.total])).toEqual([
      ["codex", "gpt-5.5", 20200],
      ["claude", "claude-opus-5-5", 12315],
      ["grok", "grok-4.7-build", 1680],
      ["codex", "gpt-6-luna", 1100],
      ["claude", "claude-haiku-4-5", 110],
    ]);
    expect(report.projects).toEqual([
      { project: "/work/web", total: 21300 },
      { project: "/work/api", total: 12425 },
      { project: "/work/cli", total: 1680 },
    ]);
    const providers = Object.fromEntries(report.providers.map((entry) => [entry.provider, entry]));
    expect(Object.keys(providers)).toEqual(["claude", "codex", "grok", "agy"]);
    expect(providers.claude).toMatchObject({ total: 12425, sessions: 1, turns: 2, cost: expect.closeTo(0.01341, 10), unpricedTokens: 0, lastModel: "claude-haiku-4-5", lastProject: "/work/api", tracked: true });
    expect(providers.codex).toMatchObject({ total: 21300, sessions: 1, turns: 2, cost: null, unpricedTokens: 21300, lastModel: "gpt-6-luna", lastProject: "/work/web", tracked: true });
    expect(providers.codex?.share).toBeCloseTo(21300 / 35405, 10);
    // agy records no token usage anywhere, so it is listed and says so instead of showing zeros as data.
    expect(providers.agy).toMatchObject({ total: 0, sessions: 0, turns: 0, cost: null, share: 0, lastModel: null, tracked: false });
    expect(report.prices.asOf).toBe(PRICES_AS_OF);
    expect(report.prices.note).toContain("estimate");
  });

  test("--days keeps the last n days, today included, and --provider keeps one provider", async () => {
    const { environment } = sandbox();
    const recent = await usageStats(environment, { days: 2, provider: null, now, timeZone });
    expect(recent.totals.total).toBe(23090);
    expect(recent.daily.map((day) => day.date)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(recent.range).toEqual({ days: 2, from: "2026-10-15", to: "2026-10-16" });
    const claude = await usageStats(environment, { days: 2, provider: "claude", now, timeZone });
    expect(claude.totals).toMatchObject({ total: 110, sessions: 1, turns: 1 });
    expect(claude.providers.map((entry) => entry.provider)).toEqual(["claude"]);
  });

  test("a provider filter inventories only that provider's logs", async () => {
    const { environment } = sandbox();
    const report = await usageStats(environment, { days: 2, provider: "codex", now, timeZone });
    expect(report.scan.files).toBe(1);
    expect(report.scan.parsed).toBe(1);
  });

  test("no logs at all is an empty report, not an error", async () => {
    const stateDir = temporary("megabrain-usage-state-");
    const report = await usageStats({ HOME: temporary("megabrain-usage-empty-"), MEGABRAIN_STATE_DIR: stateDir }, { days: 30, provider: null, now, timeZone });
    expect(report.totals.total).toBe(0);
    expect(report.daily).toEqual([]);
    expect(report.bestDay).toBeNull();
    expect(report.cacheShare).toBeNull();
    expect(report.trackingSince).toBeNull();
    expect(report.providers.every((entry) => entry.total === 0)).toBe(true);
  });

  test("reports unreadable provider logs instead of omitting them", async () => {
    const { home, environment } = sandbox();
    const unreadable = join(home, ".claude", "projects", "-work-api", "broken.jsonl");
    mkdirSync(unreadable);
    await expect(usageStats(environment, { days: null, provider: "claude", now, timeZone })).rejects.toThrow("broken.jsonl");
  });

  test("dispatches, the time their agents worked and native chats come from megabrain's own state", async () => {
    const { environment, stateDir } = sandbox();
    const opened = stateDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    const seeded = write(opened.value, ({ db }) => {
      db.run("INSERT INTO dispatches (id, state, agent, created_at, updated_at) VALUES (?, 'done', 'codex', ?, ?)", ["dispatch-a", "2026-10-15T10:00:00Z", "2026-10-15T12:00:00Z"]);
      db.run("INSERT INTO dispatches (id, state, agent, created_at, updated_at) VALUES (?, 'running', 'claude', ?, ?)", ["dispatch-b", "2026-10-16T00:00:00Z", "2026-10-16T00:00:00Z"]);
      db.run(`INSERT INTO messages (dispatch_id, seq, "from", type, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`, ["dispatch-a", 1, "parent", "prompt", "[redacted]", "2026-10-15T10:00:00Z"]);
      db.run(`INSERT INTO messages (dispatch_id, seq, "from", type, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`, ["dispatch-a", 2, "child", "done", "[redacted]", "2026-10-15T10:30:00Z"]);
      db.run(`INSERT INTO messages (dispatch_id, seq, "from", type, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`, ["dispatch-b", 1, "parent", "prompt", "[redacted]", "2026-10-16T00:00:00Z"]);
      return null;
    });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    const chat = join(stateDir, "chats", "2c494457-5505-473a-b6a5-d1b5579c107e");
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, "chat.json"), JSON.stringify({ id: "2c494457-5505-473a-b6a5-d1b5579c107e", agent: "claude", createdAt: "2026-10-16T09:00:00.000Z" }));

    const all = await usageStats(environment, { days: null, provider: null, now, timeZone });
    expect(all.megabrain).toEqual({ dispatches: 2, agentSeconds: 1800, chats: 1, since: "2026-10-15" });
    const today = await usageStats(environment, { days: 1, provider: null, now, timeZone });
    expect(today.megabrain).toEqual({ dispatches: 1, agentSeconds: 0, chats: 1, since: "2026-10-15" });
  });
});

describe("the parse cache", () => {
  test("a second run reads every file from the cache; a file that changed is parsed again", async () => {
    const { home, environment } = sandbox();
    const cold = await usageStats(environment, { days: null, provider: null, now, timeZone });
    expect(cold.scan).toMatchObject({ files: 3, parsed: 3, cached: 0 });
    const warm = await usageStats(environment, { days: null, provider: null, now, timeZone });
    expect(warm.scan).toMatchObject({ files: 3, parsed: 0, cached: 3 });
    expect(warm.totals).toEqual(cold.totals);

    appendFileSync(join(home, ".codex/sessions/2026/10/15/rollout-2026-10-15T12-00-00-01a0cccc.jsonl"), `${JSON.stringify({ timestamp: "2026-10-16T03:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 21500, cached_input_tokens: 13000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 60, total_tokens: 21800 } } } })}\n`);
    const changed = await usageStats(environment, { days: null, provider: null, now, timeZone });
    expect(changed.scan).toMatchObject({ files: 3, parsed: 1, cached: 2 });
    expect(changed.totals.total).toBe(35905);
  });

  test("a cache written in another time zone is not reused", async () => {
    const { environment } = sandbox();
    await usageStats(environment, { days: null, provider: null, now, timeZone });
    const elsewhere = await usageStats(environment, { days: null, provider: null, now, timeZone: "America/Sao_Paulo" });
    expect(elsewhere.scan).toMatchObject({ parsed: 3, cached: 0 });
  });
});

describe("megabrain usage stats", () => {
  test("bounds dispatch reads to the requested date range in SQLite", async () => {
    const { environment } = sandbox();
    const writable = stateDatabase(environment);
    if (writable.kind !== "ok") throw new Error(writable.error);
    const seeded = write(writable.value, ({ db }) => {
      db.run("INSERT INTO dispatches (id, state, agent, created_at, updated_at) VALUES (?, 'done', 'codex', ?, ?)", ["old-dispatch", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z"]);
    });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    const readOnly = readOnlyStateDatabase(environment);
    if (readOnly.kind !== "ok") throw new Error(readOnly.error);
    const database = readOnly.value.db;
    const query = database.query.bind(database);
    let usageQuery = "";
    Object.defineProperty(database, "query", {
      value: <T>(sql: string) => {
        if (sql.includes("FROM dispatches d")) usageQuery = sql;
        return query<T>(sql);
      },
    });
    try {
      await usageStats(environment, { days: 1, provider: null, now, timeZone });
      expect(usageQuery).toContain("d.created_at >= ?");
      expect(usageQuery).toContain("d.created_at < ?");
    } finally { Object.defineProperty(database, "query", { value: query }); }
  });

  test("--json prints the report", async () => {
    const { environment } = sandbox();
    const result = await executeUsage(["stats", "--days", "2", "--provider", "codex", "--json"], { ...environment, TZ: timeZone }, { now });
    if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : "unexpected result");
    const report = JSON.parse(result.value) as { totals: { total: number }; range: { days: number } };
    expect(report.totals.total).toBe(21300);
    expect(report.range.days).toBe(2);
  });

  test("the text form names the totals and each provider", async () => {
    const { environment } = sandbox();
    const result = await executeUsage(["stats"], { ...environment, TZ: timeZone }, { now });
    if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : "unexpected result");
    expect(result.value).toContain("35,405 tokens");
    expect(result.value).toMatch(/codex\s+21,300 tokens/);
  });

  test("refuses a bad --days, an unknown provider and an unknown option", async () => {
    const { environment } = sandbox();
    for (const args of [["stats", "--days", "0"], ["stats", "--days", "x"], ["stats", "--provider", "gemini"], ["stats", "--bogus"], ["totals"]]) {
      const result = await executeUsage(args, environment, { now });
      expect(result.kind).toBe("failed");
    }
  });

  test("--help prints the usage line", async () => {
    const result = await executeUsage(["stats", "--help"], {}, { now });
    if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : "unexpected result");
    expect(result.value).toContain("Usage: megabrain usage stats [--days <n>] [--provider <claude|codex|grok|agy>] [--json]");
  });
});
