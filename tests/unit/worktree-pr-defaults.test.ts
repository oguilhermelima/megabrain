import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { executeWorktreePr } from "../../src/cli/commands/worktree-write.js";
import { ok } from "../../src/core/result.js";

const real = createProcessAdapter();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "megabrain-worktree-pr-defaults-"));
  const repo = join(root, "repo");
  const path = join(root, "worktree");
  const state = join(root, "state");
  await mkdir(repo, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "worktree-root"), `${root}\n`);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await real.run("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
    if (result.kind !== "ok") throw new Error(result.error);
  };
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", path, "-b", "feat/pr");
  await writeFile(join(path, "feature.txt"), "feature\n");
  await git(path, "add", ".");
  await git(path, "commit", "-q", "-m", "feature");
  await writeFile(join(state, "pr-defaults.json"), '{"draft":true}\n');
  return { root, path, state };
}

async function open(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const calls: string[][] = [];
  const process: ProcessAdapter = {
    async run(command, argv, options) {
      if (command === "gh") {
        calls.push([...argv]);
        return argv[0] === "auth" ? ok({ stdout: "", stderr: "", exitCode: 0 }) : ok({ stdout: "https://github.example/pull/1\n", stderr: "", exitCode: 0 });
      }
      return real.run(command, argv, options);
    },
    startDetached: (command, argv, options) => real.startDetached(command, argv, options),
    invocationCount: () => real.invocationCount(),
  };
  const result = await executeWorktreePr([f.path, "--base", "main", "--json", ...args], { MEGABRAIN_STATE_DIR: f.state }, process);
  return { result, calls };
}

describe("worktree PR draft preference", () => {
  test("creates draft by saved default and --ready overrides it", async () => {
    const f = await fixture();
    try {
      const draft = await open(f, []);
      expect(draft.result.kind).toBe("ok");
      expect(draft.calls.find((args) => args[0] === "pr" && args[1] === "create")).toContain("--draft");
      const ready = await open(f, ["--ready"]);
      expect(ready.result.kind).toBe("ok");
      expect(ready.calls.find((args) => args[0] === "pr" && args[1] === "create")).not.toContain("--draft");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("rejects conflicting draft flags and falls back to ready for malformed defaults", async () => {
    const f = await fixture();
    try {
      const conflicting = await open(f, ["--draft", "--ready"]);
      expect(conflicting.result).toMatchObject({ kind: "failed", exitCode: 2 });
      expect(conflicting.calls).toEqual([]);
      await writeFile(join(f.state, "pr-defaults.json"), "{ malformed");
      const fallback = await open(f, []);
      expect(fallback.result.kind).toBe("ok");
      expect(fallback.calls.find((args) => args[0] === "pr" && args[1] === "create")).not.toContain("--draft");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
