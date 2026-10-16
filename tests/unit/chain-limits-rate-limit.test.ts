import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { readLimit } from "../../src/core/chain-limits.js";
import type { ChainConfig } from "../../src/core/chain.js";

const config = {
  chains: {},
  usageLimits: { liveProviders: ["claude"] },
} as unknown as ChainConfig;
const USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 5, resets_at: "2099-01-01T05:00:00Z" },
  seven_day: { utilization: 24, resets_at: "2099-01-07T00:00:00Z" },
});
const CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: "token-value" },
});

type Reply = Readonly<{ status: number; retryAfter?: string }> | "timeout";

// A fake security + curl: every curl call is recorded and answered from `reply`, never the network.
function provider(
  reply: () => Reply,
  delayMs = 0,
): ProcessAdapter & { curlCalls: number } {
  const state = { curlCalls: 0 };
  return {
    get curlCalls() {
      return state.curlCalls;
    },
    async run(command): Promise<Result<ProcessOutput>> {
      if (command === "security")
        return ok({ stdout: CREDENTIALS, stderr: "", exitCode: 0 });
      if (command !== "curl") return failed(`unexpected ${command}`);
      state.curlCalls += 1;
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
      const answer = reply();
      if (answer === "timeout") return failed("timed out", 28);
      const retry =
        answer.retryAfter === undefined
          ? ""
          : `\nMEGABRAIN_RETRY_AFTER:${answer.retryAfter}`;
      const body = answer.status === 200 ? USAGE_BODY : "{}";
      return ok({
        stdout: `${body}\nMEGABRAIN_HTTP_STATUS:${answer.status}${retry}`,
        stderr: "",
        exitCode: 0,
      });
    },
    async startDetached() {
      return failed("not used");
    },
    invocationCount() {
      return state.curlCalls;
    },
  } as ProcessAdapter & { curlCalls: number };
}

function withState<T>(body: (state: string) => Promise<T>): Promise<T> {
  const state = mkdtempSync(join(tmpdir(), "megabrain-limits-429-"));
  return body(state).finally(() =>
    rmSync(state, { recursive: true, force: true }),
  );
}

const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const backoffFile = (state: string) => join(state, "usage-backoff-claude.json");
const cacheFile = (state: string) => join(state, "usage-limits-claude.json");
const now = () => Math.floor(Date.now() / 1000);

// The shared cache only counts as fresh for a minute; ageing the snapshot forces the next read to ask.
function ageSnapshot(state: string, seconds: number): number {
  const snapshot = json(cacheFile(state));
  const fetchedAt = (snapshot.fetchedAt as number) - seconds;
  writeFileSync(cacheFile(state), JSON.stringify({ ...snapshot, fetchedAt }));
  return fetchedAt;
}

function elapse(state: string): void {
  writeFileSync(
    backoffFile(state),
    JSON.stringify({ ...json(backoffFile(state)), retryAt: 0 }),
  );
}

async function seed(state: string): Promise<void> {
  expect(
    await readLimit(
      "claude",
      "5h",
      config,
      {},
      provider(() => ({ status: 200 })),
      state,
    ),
  ).toMatchObject({ status: "current", usedPercent: 5 });
}

describe("claude usage through rate limits", () => {
  test("a 429 returns the last good snapshot as stale, with its age and the reason", async () => {
    await withState(async (state) => {
      await seed(state);
      const fetchedAt = ageSnapshot(state, 120);
      const reading = await readLimit(
        "claude",
        "weekly",
        config,
        {},
        provider(() => ({ status: 429 })),
        state,
      );
      expect(reading).toMatchObject({
        status: "stale",
        usedPercent: 24,
        fetchedAt,
        resetsAt: "2099-01-07T00:00:00Z",
      });
      expect(reading.reason).toContain("HTTP 429");
    });
  });

  test("without any snapshot a 429 is still unknown", async () => {
    await withState(async (state) => {
      const reading = await readLimit(
        "claude",
        "5h",
        config,
        {},
        provider(() => ({ status: 429 })),
        state,
      );
      expect(reading).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("HTTP 429"),
      });
    });
  });

  test("other transient failures keep the snapshot too", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 120);
      expect(
        await readLimit(
          "claude",
          "5h",
          config,
          {},
          provider(() => "timeout"),
          state,
        ),
      ).toMatchObject({ status: "stale", usedPercent: 5 });
      elapse(state);
      expect(
        await readLimit(
          "claude",
          "5h",
          config,
          {},
          provider(() => ({ status: 503 })),
          state,
        ),
      ).toMatchObject({ status: "stale", usedPercent: 5 });
    });
  });

  test("Retry-After sets when the next live call may happen, and nothing is asked before it", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 120);
      await readLimit(
        "claude",
        "5h",
        config,
        {},
        provider(() => ({ status: 429, retryAfter: "300" })),
        state,
      );
      const retryAt = json(backoffFile(state)).retryAt as number;
      expect(retryAt).toBeGreaterThanOrEqual(now() + 299);
      expect(retryAt).toBeLessThanOrEqual(now() + 301);
      const waiting = provider(() => ({ status: 200 }));
      const reading = await readLimit(
        "claude",
        "5h",
        config,
        {},
        waiting,
        state,
      );
      expect(waiting.curlCalls).toBe(0);
      expect(reading).toMatchObject({
        status: "stale",
        usedPercent: 5,
        retryAt,
      });
    });
  });

  test("without Retry-After the wait doubles from 60 seconds to a 15 minute cap, and a success resets it", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 120);
      const waits: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await readLimit(
          "claude",
          "5h",
          config,
          {},
          provider(() => ({ status: 429 })),
          state,
        );
        waits.push(
          Math.round((json(backoffFile(state)).retryAt as number) - now()),
        );
        elapse(state);
      }
      expect(waits.map((wait) => Math.round(wait / 5) * 5)).toEqual([
        60, 120, 240, 480, 900, 900, 900,
      ]);
      expect(json(backoffFile(state)).failures).toBe(7);
      expect(
        await readLimit(
          "claude",
          "5h",
          config,
          {},
          provider(() => ({ status: 200 })),
          state,
        ),
      ).toMatchObject({ status: "current" });
      expect(json(backoffFile(state))).toMatchObject({
        failures: 0,
        retryAt: 0,
      });
      await readLimit(
        "claude",
        "5h",
        config,
        {},
        provider(() => ({ status: 429 })),
        state,
      );
      expect(
        Math.round((json(backoffFile(state)).retryAt as number) - now()),
      ).toBeLessThanOrEqual(61);
    });
  });

  test("two concurrent callers share one live request", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 120);
      const slow = provider(() => ({ status: 200 }), 50);
      const [first, second] = await Promise.all([
        readLimit("claude", "5h", config, {}, slow, state),
        readLimit("claude", "weekly", config, {}, slow, state),
      ]);
      expect(slow.curlCalls).toBe(1);
      expect([first.status, second.status].sort()).toEqual([
        "current",
        "stale",
      ]);
    });
  });

  test("a restart keeps the snapshot", async () => {
    await withState(async (state) => {
      await seed(state);
      const fetchedAt = ageSnapshot(state, 3600);
      // A new process: nothing in memory, only the files in the state directory.
      const reading = await readLimit(
        "claude",
        "5h",
        config,
        {},
        provider(() => "timeout"),
        state,
      );
      expect(reading).toMatchObject({
        status: "stale",
        usedPercent: 5,
        fetchedAt,
      });
    });
  });

  test("every live request is logged with its time", async () => {
    await withState(async (state) => {
      await seed(state);
      ageSnapshot(state, 120);
      await readLimit(
        "claude",
        "5h",
        config,
        {},
        provider(() => ({ status: 429 })),
        state,
      );
      const calls = json(backoffFile(state)).calls as number[];
      expect(calls).toHaveLength(2);
      for (const call of calls)
        expect(Math.abs(call - now())).toBeLessThanOrEqual(5);
    });
  });
});
