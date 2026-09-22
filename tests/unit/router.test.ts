import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessOutput } from "../../src/adapters/proc.js";
import { route, type RouterDependencies } from "../../src/cli/router.js";

const process: ProcessAdapter = {
  run: async () => failed("unexpected process invocation"),
  startDetached: async () => failed("unexpected process invocation"),
  invocationCount: () => 0,
};

const dependencies: RouterDependencies = {
  environment: { MEGABRAIN_STATE_DIR: "/tmp/megabrain-router-test" },
  processAdapter: process,
};

const spawnArgs = [
  "orchestrate",
  "spawn",
  "--worktree",
  "/worktree",
  "--agent",
  "codex",
  "--prompt",
  "prompt",
];

type Call = Readonly<{ command: string; args: readonly string[] }>;

function creationProcess(): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  const result = (stdout = "", exitCode = 0): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode });
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command !== "git") return result();
      if (args.includes("worktree") && args.includes("list")) return failed("not available", 1);
      if (args.includes("--show-toplevel")) return result(".\n");
      if (args.includes("--verify")) return result("commit\n");
      if (args.includes("show-ref")) return failed("branch does not exist", 1);
      if (args.includes("worktree") && args.includes("add")) return result();
      if (args.includes("refs/remotes/origin/HEAD")) return failed("origin/HEAD is unset", 1);
      if (args.includes("get-url")) return failed("origin is unset", 1);
      if (args.includes("init.defaultBranch")) return result("main\n");
      return result();
    },
    startDetached: async () => failed("unexpected process invocation"),
    invocationCount: () => calls.length,
  };
}

async function routeAcceptedSpawn(flag: "--base" | "--name", value: string) {
  const root = await mkdtemp(`${tmpdir()}/megabrain-router-`);
  const shared = `${root}/shared`;
  await mkdir(shared);
  const resolvedShared = await realpath(shared);
  await writeFile(`${root}/worktree-root`, `${shared}\n`);
  const processAdapter = creationProcess();
  try {
    const result = await route([
      ...spawnArgs,
      "--repo",
      ".",
      "--branch",
      "feat/spawn",
      flag,
      value,
      "--tmux",
      "false",
    ], {
      environment: { MEGABRAIN_STATE_DIR: root },
      processAdapter,
    });
    return { result, calls: processAdapter.calls, shared: resolvedShared };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("CLI router", () => {
  test("routes orchestrate spawn to executeSpawn", async () => {
    const result = await route([...spawnArgs, "--help"], dependencies);

    expect(result).toEqual({
      kind: "ok",
      value: "Usage: megabrain orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <model>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]\n",
    });
  });

  test("accepts --base and forwards it to worktree creation", async () => {
    const { result, calls } = await routeAcceptedSpawn("--base", "release/next");

    expect(result).toEqual({
      kind: "failed",
      error: "cannot launch agent from unknown orchestration host: unknown",
      exitCode: 1,
    });
    expect(calls).toContainEqual({
      command: "git",
      args: ["-C", ".", "worktree", "add", expect.any(String), "-b", "feat/spawn", "release/next"],
    });
  });

  test("accepts --name and forwards it to worktree creation", async () => {
    const { result, calls, shared } = await routeAcceptedSpawn("--name", "operator-name");

    expect(result).toEqual({
      kind: "failed",
      error: "cannot launch agent from unknown orchestration host: unknown",
      exitCode: 1,
    });
    expect(calls).toContainEqual({
      command: "git",
      args: ["-C", ".", "worktree", "add", `${shared}/operator-name`, "-b", "feat/spawn", "main"],
    });
  });

  test.each([
    ["--from", "ref"],
    ["--parent", "path:/parent"],
    ["--no-parent", undefined],
    ["--issue", "42"],
    ["--linear-issue", "ENG-42"],
    ["--pr", "42"],
    ["--chain", "default"],
    ["--orchestrate", undefined],
  ] as const)("refuses unsupported spawn flag %s by name", async (flag, value) => {
    const result = await route([...spawnArgs, flag, ...(value === undefined ? [] : [value])], dependencies);

    expect(result).toEqual({
      kind: "failed",
      error: `unsupported orchestrate spawn option: ${flag}`,
      exitCode: 2,
    });
  });
});
