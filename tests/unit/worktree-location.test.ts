import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { executeWorktreeCreate } from "../../src/cli/commands/worktree-write.js";
import { executeSettings } from "../../src/cli/commands/settings.js";
import { failed, ok, type Result } from "../../src/core/result.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "megabrain-worktree-location-"));
  directories.push(base);
  const home = join(base, "home");
  const state = join(base, "state");
  const repo = join(base, "code", "alpha");
  const legacy = join(base, "legacy-root");
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "worktree-root"), `${legacy}\n`);
  return { base, home, state, repo, legacy, environment: { HOME: home, MEGABRAIN_STATE_DIR: state } };
}

function recorder(repo: string): { process: ProcessAdapter; added: string[] } {
  const added: string[] = [];
  const result = (stdout = ""): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode: 0 });
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command !== "git") return result();
      if (args.includes("--show-toplevel")) return result(`${repo}\n`);
      if (args.includes("--git-common-dir")) return result(`${join(repo, ".git")}\n`);
      if (args.includes("show-ref")) return failed("branch does not exist", 1);
      if (args.includes("worktree") && args.includes("add")) { added.push(args[args.indexOf("add") + 1] as string); return result(); }
      if (args.includes("--verify")) return result("base-commit\n");
      return result();
    },
    async startDetached() { return failed("unexpected process invocation"); },
    invocationCount() { return 0; },
  };
  return { process, added };
}

async function create(f: ReturnType<typeof fixture>, branch = "feat/x"): Promise<string> {
  const { process, added } = recorder(f.repo);
  const result = await executeWorktreeCreate(["--repo", f.repo, "--branch", branch, "--base", "main", "--json"], f.environment, process);
  expect(result.kind).toBe("ok");
  return added[0] as string;
}

const set = (f: ReturnType<typeof fixture>, value: unknown) => executeSettings(["set", "worktree-location", JSON.stringify(value)], f.environment, {} as ProcessAdapter);
const exclude = (f: ReturnType<typeof fixture>) => join(f.repo, ".git", "info", "exclude");

describe("worktree location", () => {
  test("default keeps today's flat layout under the configured root", async () => {
    const f = fixture();
    expect(await create(f)).toBe(join(f.legacy, "feat-x"));
    expect(existsSync(exclude(f))).toBe(false);
  });

  test("settings get returns the default when nothing is stored", async () => {
    const f = fixture();
    const got = await executeSettings(["get", "worktree-location"], f.environment, {} as ProcessAdapter);
    expect(got.kind).toBe("ok");
    if (got.kind !== "ok") return;
    expect(JSON.parse(got.value)).toEqual({ version: 1, mode: "custom", customRoot: null, layout: "flat", projects: {} });
  });

  test("megabrain mode nests under the state-dir worktrees folder by repo", async () => {
    const f = fixture();
    expect((await set(f, { version: 1, mode: "megabrain", customRoot: null, layout: "nested", projects: {} })).kind).toBe("ok");
    expect(await create(f)).toBe(join(f.state, "worktrees", "alpha", "feat-x"));
  });

  test("repo mode lands inside the repository and ignores it through info/exclude only", async () => {
    const f = fixture();
    writeFileSync(join(f.repo, ".gitignore"), "node_modules\n");
    await set(f, { version: 1, mode: "repo", customRoot: null, layout: "nested", projects: {} });
    expect(await create(f)).toBe(join(f.repo, ".worktrees", "feat-x"));
    expect(readFileSync(exclude(f), "utf8").split("\n")).toContain(".worktrees/");
    expect(readFileSync(join(f.repo, ".gitignore"), "utf8")).toBe("node_modules\n");
    await create(f, "feat/y");
    expect(readFileSync(exclude(f), "utf8").split("\n").filter((line) => line === ".worktrees/")).toHaveLength(1);
  });

  test("custom mode nests by repo, or stays flat when asked", async () => {
    const f = fixture();
    const custom = join(f.base, "elsewhere");
    await set(f, { version: 1, mode: "custom", customRoot: custom, layout: "nested", projects: {} });
    expect(await create(f)).toBe(join(custom, "alpha", "feat-x"));
    await set(f, { version: 1, mode: "custom", customRoot: custom, layout: "flat", projects: {} });
    expect(await create(f)).toBe(join(custom, "feat-x"));
  });

  test("a per-project override beats the global mode, other projects keep it", async () => {
    const f = fixture();
    await set(f, { version: 1, mode: "megabrain", customRoot: null, layout: "nested", projects: { [f.repo]: { mode: "repo", customRoot: null, layout: "nested" } } });
    expect(await create(f)).toBe(join(f.repo, ".worktrees", "feat-x"));
  });

  test("set refuses an unknown mode or a custom mode with no root and no legacy root", async () => {
    const f = fixture();
    expect((await set(f, { version: 1, mode: "nowhere", customRoot: null, layout: "flat", projects: {} })).kind).toBe("failed");
    expect((await set(f, { version: 1, mode: "custom", customRoot: "relative/path", layout: "flat", projects: {} })).kind).toBe("failed");
  });
});
