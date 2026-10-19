import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/cli/router.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

let root = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-repo-github-")));
  env = { HOME: root, MEGABRAIN_STATE_DIR: join(root, "state") };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

type Call = readonly string[];

/** A gh that answers by its first arguments; git and anything else fail, as no repository is involved. */
function fakeGh(answers: Readonly<Record<string, string>>, calls: Call[], timeouts: Array<number | undefined> = []): ProcessAdapter {
  return {
    run: async (command, args, options) => {
      if (command !== "gh") return failed(`${command} unavailable`);
      calls.push(args);
      timeouts.push(options?.timeoutMs);
      if (args[0] === "auth") return ok({ stdout: "", stderr: "Logged in", exitCode: 0 });
      const key = args.slice(0, 2).join(" ");
      const answer = answers[key];
      return answer === undefined ? failed(`unexpected gh ${args.join(" ")}`) : ok({ stdout: answer, stderr: "", exitCode: 0 });
    },
    startDetached: async () => ok({ pid: 0 }),
    invocationCount: () => calls.length,
  };
}

function json<T>(result: { kind: string; value?: string; error?: string }): T {
  if (result.kind !== "ok" || result.value === undefined) throw new Error(result.error ?? "expected command output");
  return JSON.parse(result.value) as T;
}

describe("repo github", () => {
  test("asks gh for the language and star count beside the existing fields", async () => {
    const calls: Call[] = [];
    const listed = [{ nameWithOwner: "operator/canto", url: "https://github.com/operator/canto", description: null, isPrivate: false, updatedAt: "2026-10-01T00:00:00Z", primaryLanguage: { name: "TypeScript" }, stargazerCount: 12 }];
    const result = json<unknown[]>(await route(["repo", "github", "--owner", "operator", "--json"], { environment: env, processAdapter: fakeGh({ "repo list": JSON.stringify(listed) }, calls) }));
    expect(result).toEqual(listed);
    const list = calls.find((args) => args[0] === "repo");
    expect(list?.[2]).toBe("operator");
    expect(list?.[list.indexOf("--json") + 1]?.split(",")).toEqual(["nameWithOwner", "url", "description", "isPrivate", "updatedAt", "primaryLanguage", "stargazerCount"]);
  });

  test("--orgs lists the signed-in account first, then its organisations", async () => {
    const calls: Call[] = [];
    const answers = {
      "api user": JSON.stringify({ login: "operator", avatar_url: "https://avatars.example/operator" }),
      "api user/orgs": JSON.stringify([{ login: "acme", avatar_url: "https://avatars.example/acme" }, { login: "labs" }]),
    };
    const owners = json<unknown[]>(await route(["repo", "github", "--orgs", "--json"], { environment: env, processAdapter: fakeGh(answers, calls) }));
    expect(owners).toEqual([
      { login: "operator", kind: "user", avatarUrl: "https://avatars.example/operator" },
      { login: "acme", kind: "organization", avatarUrl: "https://avatars.example/acme" },
      { login: "labs", kind: "organization", avatarUrl: null },
    ]);
    expect(calls.some((args) => args[0] === "repo")).toBe(false);
  });

  test("--orgs reports a failing organisations call instead of listing only the account", async () => {
    const result = await route(["repo", "github", "--orgs", "--json"], { environment: env, processAdapter: fakeGh({ "api user": JSON.stringify({ login: "operator" }) }, []) });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("could not list GitHub organisations");
  });

  test("--orgs with invalid JSON from gh is an error", async () => {
    const result = await route(["repo", "github", "--orgs", "--json"], { environment: env, processAdapter: fakeGh({ "api user": "not json", "api user/orgs": "[]" }, []) });
    expect(result).toMatchObject({ kind: "failed", error: "gh api returned invalid JSON" });
  });

  test("bounds GitHub requests and fetches account and organisations concurrently", async () => {
    const calls: Call[] = [];
    const timeouts: Array<number | undefined> = [];
    let active = 0;
    let maximum = 0;
    const process: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command !== "gh") return failed(`${command} unavailable`);
        calls.push(args);
        timeouts.push(options?.timeoutMs);
        if (args[0] === "auth") return ok({ stdout: "", stderr: "Logged in", exitCode: 0 });
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        const value = args[1] === "user"
          ? { login: "operator" }
          : [{ login: "acme" }];
        return ok({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
      },
      startDetached: async () => failed("unexpected detached process"),
      invocationCount: () => calls.length,
    };

    const result = json<unknown[]>(await route(["repo", "github", "--orgs", "--json"], { environment: env, processAdapter: process }));

    expect(result).toHaveLength(2);
    expect(maximum).toBe(2);
    expect(timeouts).toEqual([2_000, 2_000, 2_000]);
  });

  test("requests the maximum paginated GitHub repository listing", async () => {
    const calls: Call[] = [];
    const repos = Array.from({ length: 205 }, (_, index) => ({ nameWithOwner: `operator/repo-${index}`, url: `https://github.com/operator/repo-${index}` }));

    const result = json<unknown[]>(await route(["repo", "github", "--json"], { environment: env, processAdapter: fakeGh({ "repo list": JSON.stringify(repos) }, calls) }));

    const list = calls.find((args) => args[0] === "repo");
    expect(result).toHaveLength(205);
    expect(list?.[list.indexOf("--limit") + 1]).toBe("1000");
  });
});
