import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { readLimit } from "../../src/core/chain-limits.js";
import { executeChain } from "../../src/cli/commands/chain.js";
import type { ChainConfig } from "../../src/core/chain.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput>): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) { calls.push({ command, args: [...args] }); return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "../fixtures", name), "utf8");
const live = (...providers: string[]): ChainConfig => ({ chains: {}, usageLimits: { liveProviders: providers } } as unknown as ChainConfig);

function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-limits-"));
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

// Antigravity CLI 1.3.3 answers `agy -p /usage --output-format json` with the quota groups
// (tests/fixtures/agy-usage.json, captured 2026-10-12): Gemini at 8% weekly remaining, Claude and
// GPT at 0% weekly with its 5h bucket disabled.
describe("agy usage limits", () => {
  const agy = () => fakeProcess((command) => command === "agy" ? ok({ stdout: fixture("agy-usage.json"), stderr: "", exitCode: 0 }) : failed(`unexpected ${command}`));

  test("asks the agy CLI for /usage instead of the Keychain", async () => {
    await withDirectory(async (state) => {
      const process = agy();
      const reading = await readLimit("agy", "weekly", live("agy"), {}, process, state);
      expect(reading.status).toBe("current");
      expect(process.calls.map((call) => call.command)).toEqual(["agy"]);
      expect(process.calls[0]?.args).toEqual(["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"]);
    });
  });

  test("reads the bucket of the step's model family", async () => {
    await withDirectory(async (state) => {
      const gemini = await readLimit("agy", "weekly", live("agy"), {}, agy(), state, "gemini-3.1-pro-high");
      expect(gemini).toMatchObject({ status: "current", resetsAt: "2026-10-14T04:35:51Z" });
      if (gemini.status === "current") expect(Math.round(gemini.usedPercent)).toBe(92);
    });
    await withDirectory(async (state) => {
      const claude = await readLimit("agy", "weekly", live("agy"), {}, agy(), state, "claude-opus-4-6-thinking");
      expect(claude).toMatchObject({ status: "current", usedPercent: 100, resetsAt: "2026-10-13T03:38:30Z" });
    });
    await withDirectory(async (state) => {
      expect(await readLimit("agy", "weekly", live("agy"), {}, agy(), state, "gpt-oss-120b-medium")).toMatchObject({ status: "current", usedPercent: 100 });
    });
  });

  test("parses every live quota pool and retains their names and windows", async () => {
    await withDirectory(async (state) => {
      const process = fakeProcess((command) => command === "agy" ? ok({ stdout: fixture("agy-usage-multiple-pools.json"), stderr: "", exitCode: 0 }) : failed(`unexpected ${command}`));
      const claude = await readLimit("agy", "weekly", live("agy"), {}, process, state, "claude-sonnet-5-5");
      const gemini = await readLimit("agy", "5h", live("agy"), {}, process, state, "gemini-3.1-pro-high");
      const argon = await readLimit("agy", "weekly", live("agy"), {}, process, state, "gemini-4-argon");
      expect(claude).toMatchObject({ status: "current", bucket: "Claude and GPT models", usedPercent: 40 });
      expect(gemini).toMatchObject({ status: "current", bucket: "Gemini Models", usedPercent: 10 });
      expect(argon).toMatchObject({ status: "current", bucket: "Gemini 4 Argon", usedPercent: 0 });
      expect(claude.status === "current" && claude.result.windows.map(({ bucket, name }) => [bucket, name])).toEqual([
        ["Gemini Models", "weekly"], ["Gemini Models", "5h"], ["Claude and GPT models", "weekly"], ["Claude and GPT models", "5h"], ["Gemini 4 Argon", "weekly"],
      ]);
    });
  });

  test("without a model, the most used bucket is the answer", async () => {
    await withDirectory(async (state) => {
      expect(await readLimit("agy", "weekly", live("agy"), {}, agy(), state)).toMatchObject({ status: "current", usedPercent: 100 });
    });
  });

  test("a reading names the bucket it answered for", async () => {
    await withDirectory(async (state) => {
      expect(await readLimit("agy", "weekly", live("agy"), {}, agy(), state)).toMatchObject({ bucket: "Claude and GPT models" });
      expect(await readLimit("agy", "weekly", live("agy"), {}, agy(), state, "gemini-3.1-pro-high")).toMatchObject({ bucket: "Gemini Models" });
    });
  });

  test("a disabled bucket is not a reading", async () => {
    await withDirectory(async (state) => {
      const reading = await readLimit("agy", "5h", live("agy"), {}, agy(), state, "claude-sonnet-4-6");
      expect(reading.status).toBe("unknown");
    });
  });

  test("a signed-out CLI and a failed run say so", async () => {
    await withDirectory(async (state) => {
      const signedOut = fakeProcess(() => ok({ stdout: "", stderr: 'AGY_ERROR: {"status":"UNAUTHENTICATED","error_code":401}', exitCode: 1 }));
      expect(await readLimit("agy", "5h", live("agy"), {}, signedOut, state)).toMatchObject({ status: "unknown", reason: expect.stringContaining("not signed in") });
      const missing = fakeProcess(() => failed("Executable not found in $PATH: agy"));
      expect(await readLimit("agy", "5h", live("agy"), {}, missing, state)).toMatchObject({ status: "unknown", reason: expect.stringContaining("agy CLI") });
    });
  });

  test("returns a saved quota as stale when the live provider stops returning data", async () => {
    await withDirectory(async (state) => {
      const config = { ...live("agy"), usageLimits: { liveProviders: ["agy"], cacheTtlSeconds: 0 } } as unknown as ChainConfig;
      const saved = await readLimit("agy", "weekly", config, {}, agy(), state, "claude-sonnet-5-5");
      expect(saved).toMatchObject({ status: "current", bucket: "Claude and GPT models" });
      const signedOut = fakeProcess(() => ok({ stdout: "", stderr: 'AGY_ERROR: {"status":"UNAUTHENTICATED","error_code":401}', exitCode: 1 }));
      expect(await readLimit("agy", "weekly", config, {}, signedOut, state, "claude-sonnet-5-5")).toMatchObject({
        status: "stale", stale: true, staleReason: expect.any(String), usedPercent: 100, bucket: "Claude and GPT models", fetchedAt: expect.any(Number),
      });
    });
  });
});

describe("codex rollout freshness", () => {
  test("chain limits JSON reports stale age and treats the 15-minute boundary and future mtimes as current", async () => {
    await withDirectory(async (state) => {
      const sessions = join(state, "sessions", "2026", "11", "03");
      mkdirSync(sessions, { recursive: true });
      const rollout = join(sessions, "rollout-test.jsonl");
      const writeAt = async (ageSeconds: number) => {
        const now = Math.floor(Date.now() / 1000);
        writeFileSync(rollout, JSON.stringify({ rate_limits: { primary: { window_minutes: 10080, used_percent: 70, resets_at: now + 86400 } } }));
        const timestamp = now - ageSeconds;
        utimesSync(rollout, timestamp, timestamp);
      };
      const read = async () => {
        const result = await executeChain(["limits", "--json"], { MEGABRAIN_STATE_DIR: state, MEGABRAIN_CODEX_SESSIONS_DIR: join(state, "sessions"), MEGABRAIN_ROOT: process.cwd(), HOME: state }, fakeProcess(() => failed("unused")));
        if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : result.reason);
        return JSON.parse(result.value).find((row: { provider: string; window: string }) => row.provider === "codex" && row.window === "weekly");
      };
      await writeAt(901);
      expect(await read()).toMatchObject({ status: "stale", reason: expect.stringContaining("15 minutes old") });
      await writeAt(899);
      expect(await read()).toMatchObject({ status: "current" });
      await writeAt(-60);
      expect(await read()).toMatchObject({ status: "current" });
    });
  });

  test("marks an old weekly snapshot stale and reports its age", async () => {
    await withDirectory(async (state) => {
      const sessions = join(state, "sessions", "2026", "11", "03");
      mkdirSync(sessions, { recursive: true });
      const rollout = join(sessions, "rollout-test.jsonl");
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(rollout, JSON.stringify({ rate_limits: { primary: { window_minutes: 10080, used_percent: 70, resets_at: now + 86400 } } }));
      const fetchedAt = now - 20 * 60;
      utimesSync(rollout, fetchedAt, fetchedAt);
      const reading = await readLimit("codex", "weekly", live(), { MEGABRAIN_CODEX_SESSIONS_DIR: join(state, "sessions") }, fakeProcess(() => failed("unused")), state);
      expect(reading).toMatchObject({ status: "stale", stale: true, ageSeconds: expect.any(Number) });
    });
  });
});

// Grok's CLI reports its credit usage from GET <proxy>/billing?format=credits with the token in
// <GROK_HOME>/auth.json (tests/fixtures/grok-billing.json, captured 2026-10-12: 45% of a weekly
// period).
describe("grok usage limits", () => {
  const body = `${fixture("grok-billing.json")}\nMEGABRAIN_HTTP_STATUS:200`;
  function auth(home: string, expiresAt: string): void {
    writeFileSync(join(home, "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key: "token-value", user_id: "user-1", expires_at: expiresAt } }));
  }

  test("reads the weekly credit window", async () => {
    await withDirectory(async (home) => {
      auth(home, new Date(Date.now() + 3_600_000).toISOString());
      const process = fakeProcess((command) => command === "curl" ? ok({ stdout: body, stderr: "", exitCode: 0 }) : failed(command));
      const reading = await readLimit("grok", "weekly", live("grok"), { GROK_HOME: home }, process, home);
      expect(reading).toMatchObject({ status: "current", usedPercent: 45, resetsAt: "2026-10-18T21:51:42.706674+00:00" });
      const args = process.calls[0]?.args ?? [];
      expect(args).toContain("Authorization: Bearer token-value");
      expect(args).toContain("X-XAI-Token-Auth: xai-grok-cli");
      expect(args).toContain("x-userid: user-1");
      expect(args.at(-1)).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    });
  });

  test("has no five-hour window", async () => {
    await withDirectory(async (home) => {
      auth(home, new Date(Date.now() + 3_600_000).toISOString());
      const process = fakeProcess(() => ok({ stdout: body, stderr: "", exitCode: 0 }));
      expect(await readLimit("grok", "5h", live("grok"), { GROK_HOME: home }, process, home)).toMatchObject({ status: "unknown" });
      expect(process.calls).toHaveLength(0);
    });
  });

  test("an expired or missing sign-in is unknown without a request", async () => {
    await withDirectory(async (home) => {
      const process = fakeProcess(() => ok({ stdout: body, stderr: "", exitCode: 0 }));
      expect(await readLimit("grok", "weekly", live("grok"), { GROK_HOME: home }, process, home)).toMatchObject({ status: "unknown", reason: expect.stringContaining("not signed in") });
      auth(home, new Date(Date.now() - 60_000).toISOString());
      expect(await readLimit("grok", "weekly", live("grok"), { GROK_HOME: home }, process, home)).toMatchObject({ status: "unknown", reason: expect.stringContaining("expired") });
      expect(process.calls).toHaveLength(0);
    });
  });

  test("stays off the network unless enabled", async () => {
    await withDirectory(async (home) => {
      auth(home, new Date(Date.now() + 3_600_000).toISOString());
      const process = fakeProcess(() => ok({ stdout: body, stderr: "", exitCode: 0 }));
      expect(await readLimit("grok", "weekly", live(), { GROK_HOME: home }, process, home)).toMatchObject({ status: "unknown", reason: expect.stringContaining("not enabled") });
      expect(process.calls).toHaveLength(0);
    });
  });
});
