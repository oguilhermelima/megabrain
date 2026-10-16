import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { readLimit } from "../../src/core/chain-limits.js";
import type { ChainConfig } from "../../src/core/chain.js";

const config = { chains: {}, usageLimits: { liveProviders: ["claude"] } } as unknown as ChainConfig;
const USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 5, resets_at: "2099-01-01T05:00:00Z" },
  seven_day: { utilization: 24, resets_at: "2099-01-07T00:00:00Z" },
});
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: "token-value" } });

type Reply = Readonly<{ status: number; retryAfter?: string }>;
type Fake = ProcessAdapter & { readonly curlArgs: string[][] };

// A fake security + claude + curl: curl calls are recorded and answered from `reply`, never the network.
function provider(reply: () => Reply, delayMs = 0, version = "2.1.301 (Claude Code)"): Fake {
  const curlArgs: string[][] = [];
  return {
    curlArgs,
    async run(command, args): Promise<Result<ProcessOutput>> {
      if (command === "security") return ok({ stdout: CREDENTIALS, stderr: "", exitCode: 0 });
      if (command === "claude") return ok({ stdout: `${version}\n`, stderr: "", exitCode: 0 });
      if (command !== "curl") return failed(`unexpected ${command}`);
      curlArgs.push([...(args ?? [])]);
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
      const answer = reply();
      const retry = answer.retryAfter === undefined ? "" : `\nMEGABRAIN_RETRY_AFTER:${answer.retryAfter}`;
      const body = answer.status === 200 ? USAGE_BODY : "{}";
      return ok({ stdout: `${body}\nMEGABRAIN_HTTP_STATUS:${answer.status}${retry}`, stderr: "", exitCode: 0 });
    },
    async startDetached() {
      return failed("not used");
    },
  } as unknown as Fake;
}

function withState<T>(body: (state: string) => Promise<T>): Promise<T> {
  const state = mkdtempSync(join(tmpdir(), "megabrain-limits-poll-"));
  return body(state).finally(() => rmSync(state, { recursive: true, force: true }));
}

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const backoffFile = (state: string) => join(state, "usage-backoff-claude.json");
const cacheFile = (state: string) => join(state, "usage-limits-claude.json");
const now = () => Math.floor(Date.now() / 1000);

function ageSnapshot(state: string, seconds: number): void {
  const snapshot = json(cacheFile(state));
  writeFileSync(cacheFile(state), JSON.stringify({ ...snapshot, fetchedAt: (snapshot.fetchedAt as number) - seconds }));
}

async function seed(state: string): Promise<void> {
  const fake = provider(() => ({ status: 200 }));
  expect(await readLimit("claude", "5h", config, {}, fake, state)).toMatchObject({ status: "current", usedPercent: 5 });
}

const read = (fake: Fake, state: string, window: "5h" | "weekly" = "5h") => readLimit("claude", window, config, {}, fake, state);

describe("claude usage polled like Claude Code", () => {
  test("a reading under five minutes old is served without calling", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 290);
      const fake = provider(() => ({ status: 200 }));
      expect(await read(fake, state)).toMatchObject({ status: "current", usedPercent: 5 });
      expect(fake.curlArgs).toHaveLength(0);
      ageSnapshot(state, 20);
      expect(await read(fake, state)).toMatchObject({ status: "current" });
      expect(fake.curlArgs).toHaveLength(1);
    });
  });

  test("a 429 without Retry-After waits five minutes", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 400);
      await read(provider(() => ({ status: 429 })), state);
      const wait = (json(backoffFile(state)).retryAt as number) - now();
      expect(wait).toBeGreaterThanOrEqual(299);
      expect(wait).toBeLessThanOrEqual(301);
    });
  });

  test("a 429 honours Retry-After and caps it at one hour", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 400);
      await read(provider(() => ({ status: 429, retryAfter: "900" })), state);
      expect((json(backoffFile(state)).retryAt as number) - now()).toBeGreaterThanOrEqual(899);
      writeFileSync(backoffFile(state), JSON.stringify({ ...json(backoffFile(state)), retryAt: 0 }));
      await read(provider(() => ({ status: 429, retryAfter: "99999" })), state);
      const wait = (json(backoffFile(state)).retryAt as number) - now();
      expect(wait).toBeGreaterThanOrEqual(3599);
      expect(wait).toBeLessThanOrEqual(3601);
    });
  });

  test("until retryAt the last reading is served stale and nothing is called", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 400);
      await read(provider(() => ({ status: 429 })), state);
      const waiting = provider(() => ({ status: 200 }));
      expect(await read(waiting, state)).toMatchObject({ status: "stale", usedPercent: 5 });
      expect(waiting.curlArgs).toHaveLength(0);
    });
  });

  test("two concurrent callers make one call and both read its result", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 400);
      const slow = provider(() => ({ status: 200 }), 100);
      const [first, second] = await Promise.all([read(slow, state, "5h"), read(slow, state, "weekly")]);
      expect(slow.curlArgs).toHaveLength(1);
      expect(first).toMatchObject({ status: "current" });
      expect(second).toMatchObject({ status: "current" });
    });
  });

  test("the request sends the installed Claude Code version as its User-Agent", async () => {
    await withState(async (state) => {
      const fake = provider(() => ({ status: 200 }));
      await read(fake, state);
      expect(fake.curlArgs).toHaveLength(1);
      expect(fake.curlArgs[0]).toContain("User-Agent: claude-code/2.1.301");
    });
  });
});
