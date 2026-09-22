import { describe, expect, test } from "bun:test";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed } from "../../src/core/result.js";
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

describe("CLI router", () => {
  test("routes orchestrate spawn to executeSpawn", async () => {
    const result = await route([...spawnArgs, "--help"], dependencies);

    expect(result).toEqual({
      kind: "ok",
      value: "Usage: megabrain orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <model>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]\n",
    });
  });

  test.each([
    ["--from", "ref"],
    ["--parent", "path:/parent"],
    ["--no-parent", undefined],
    ["--issue", "42"],
    ["--linear-issue", "ENG-42"],
    ["--pr", "42"],
    ["--base", "main"],
    ["--name", "spawn-name"],
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
