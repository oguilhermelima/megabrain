import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProcessAdapter, type ProcessAdapter, type ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeWorktreeFinish } from "../../src/cli/commands/worktree-write.js";

const real = createProcessAdapter();
const git = (cwd: string, ...args: readonly string[]) => real.run("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);

async function gitOut(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await git(cwd, ...args);
  return result.kind === "ok" ? result.value.stdout.trim() : `ERR ${result.error}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "megabrain-finish-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  const shared = join(root, "shared");
  await mkdir(repo, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(state, "worktree-root"), `${shared}\n`);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const path = join(shared, "feat-x");
  await git(repo, "worktree", "add", "-q", path, "-b", "feat/x", "main");
  return { root, repo, state, path };
}

// The host remover (Orca) deletes the folder but leaves git's worktree record behind and answers
// with a failure, which is what every lane cleanup on 2026-10-16 looked like.
function hostProcess(path: string, remover: (run: () => Promise<void>) => Promise<Result<ProcessOutput>>): ProcessAdapter {
  return {
    async run(command, args, options) {
      if (command === "sh" && args[1] === "command -v superset") return failed("not found", 1);
      if (command === "sh" && args[1] === "command -v orca") return ok({ stdout: "/bin/orca\n", stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "worktree" && args[1] === "rm") return remover(() => rm(path, { recursive: true, force: true }));
      return real.run(command, args, options);
    },
    startDetached: (command, args, options) => real.startDetached(command, args, options),
    invocationCount: () => real.invocationCount(),
  };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("worktree finish waits for the host removal", () => {
  test("a host remover that deletes the folder but exits 1 still ends in exit 0 with the branch gone", async () => {
    const f = await fixture();
    try {
      const process = hostProcess(f.path, async (removeFolder) => { await removeFolder(); return failed(JSON.stringify({ error: "cascade failed late" }), 1); });
      const result = await executeWorktreeFinish([f.path, "--delete-branch", "--base", "main", "--json"], { MEGABRAIN_STATE_DIR: f.state }, process);
      expect(result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode).toBe(0);
      expect(await exists(f.path)).toBe(false);
      expect(await gitOut(f.repo, "branch", "--list", "feat/x")).toBe("");
      expect(await gitOut(f.repo, "worktree", "list", "--porcelain")).not.toContain("feat-x");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("a host remover that returns before the folder is gone is waited for", async () => {
    const f = await fixture();
    try {
      const process = hostProcess(f.path, async (removeFolder) => { setTimeout(() => { void removeFolder(); }, 400); return ok({ stdout: "{}", stderr: "", exitCode: 0 }); });
      const result = await executeWorktreeFinish([f.path, "--delete-branch", "--base", "main", "--json"], { MEGABRAIN_STATE_DIR: f.state }, process);
      expect(result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode).toBe(0);
      expect(await gitOut(f.repo, "branch", "--list", "feat/x")).toBe("");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("a folder that never goes away exits non-zero and names what is left", async () => {
    const f = await fixture();
    try {
      const process = hostProcess(f.path, async () => failed(JSON.stringify({ error: "host refused" }), 1));
      const result = await executeWorktreeFinish([f.path, "--delete-branch", "--base", "main", "--json"], { MEGABRAIN_STATE_DIR: f.state }, process);
      const exitCode = result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode;
      expect(exitCode).not.toBe(0);
      expect(result.kind === "ok" ? result.stderr ?? "" : result.error).toContain(f.path);
      expect(await exists(f.path)).toBe(true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
