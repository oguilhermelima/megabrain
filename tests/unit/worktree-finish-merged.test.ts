import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import { executeWorktreeFinish } from "../../src/cli/commands/worktree-write.js";

const real = createProcessAdapter();
const process: ProcessAdapter = {
  async run(command, args, options) {
    if (command === "sh" && args[0] === "-c" && (args[1] === "command -v orca" || args[1] === "command -v superset")) return failed("not found", 1);
    return real.run(command, args, options);
  },
  startDetached: (command, args, options) => real.startDetached(command, args, options),
  invocationCount: () => real.invocationCount(),
};
const git = async (cwd: string, ...args: string[]) => {
  const result = await process.run("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value.stdout.trim();
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "megabrain-finish-merged-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  const shared = join(root, "worktrees");
  await mkdir(repo, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(state, "worktree-root"), `${shared}\n`);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "base.txt");
  await git(repo, "commit", "-q", "-m", "base");
  return { root, repo, state, shared };
}

async function worktree(f: Awaited<ReturnType<typeof fixture>>, branch: string, base = "main") {
  const path = join(f.shared, branch.replaceAll("/", "-"));
  await git(f.repo, "worktree", "add", "-q", path, "-b", branch, base);
  await writeFile(join(path, `${branch.split("/").at(-1)}.txt`), `${branch}\n`);
  await git(path, "add", ".");
  await git(path, "commit", "-q", "-m", branch);
  return path;
}

async function finish(f: Awaited<ReturnType<typeof fixture>>, path: string, base: string, runner = process) {
  return executeWorktreeFinish([path, "--delete-branch", "--base", base, "--json"], { MEGABRAIN_STATE_DIR: f.state }, runner);
}

describe("worktree finish recognizes merged changes", () => {
  test("allows deleting a branch whose change was squash-merged", async () => {
    const f = await fixture();
    try {
      const path = await worktree(f, "feat/squash");
      await git(f.repo, "merge", "--squash", "feat/squash");
      await git(f.repo, "commit", "-q", "-m", "squash feat/squash");
      const result = await finish(f, path, "main");
      expect(result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode).toBe(0);
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/squash")).toBe("");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 15000);

  test("allows deleting a branch whose change was rebase-merged", async () => {
    const f = await fixture();
    try {
      const path = await worktree(f, "feat/rebase");
      const commit = await git(path, "rev-parse", "HEAD");
      await writeFile(join(f.repo, "main-only.txt"), "independent base change\n");
      await git(f.repo, "add", "main-only.txt");
      await git(f.repo, "commit", "-q", "-m", "advance base independently");
      await git(f.repo, "cherry-pick", commit);
      const result = await finish(f, path, "main");
      expect(result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode).toBe(0);
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/rebase")).toBe("");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 15000);

  test("judges a squash merge against the explicitly selected epic base", async () => {
    const f = await fixture();
    try {
      await git(f.repo, "switch", "-q", "-c", "epic");
      const path = await worktree(f, "feat/epic-child", "epic");
      await git(f.repo, "merge", "--squash", "feat/epic-child");
      await git(f.repo, "commit", "-q", "-m", "squash child into epic");
      const result = await finish(f, path, "epic");
      expect(result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode).toBe(0);
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/epic-child")).toBe("");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 15000);

  test("refuses deleting a branch with changes absent from the base", async () => {
    const f = await fixture();
    try {
      const path = await worktree(f, "feat/unmerged");
      const result = await finish(f, path, "main");
      expect(result.kind === "ok" ? result.exitCode : result.exitCode).toBe(1);
      expect(result.kind === "ok" ? result.value : result.error).toContain("unmerged-branch");
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/unmerged")).toBe("feat/unmerged");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("allows deleting a branch when GitHub reports its PR merged into the base", async () => {
    const f = await fixture();
    try {
      const path = await worktree(f, "feat/remote-merge");
      const runner: ProcessAdapter = {
        ...process,
        async run(command, args, options) {
          if (command === "gh" && args[0] === "pr" && args[1] === "list") {
            const head = await git(f.repo, "rev-parse", "feat/remote-merge");
            return ok({ stdout: JSON.stringify([{ state: "MERGED", headRefOid: head }]), stderr: "", exitCode: 0 });
          }
          return process.run(command, args, options);
        },
      };
      const result = await finish(f, path, "main", runner);
      expect(result.kind === "ok" ? result.exitCode ?? 0 : result.exitCode).toBe(0);
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/remote-merge")).toBe("");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("refuses deleting a branch with commits after its merged PR tip", async () => {
    const f = await fixture();
    try {
      const path = await worktree(f, "feat/later-commit");
      const mergedHead = await git(path, "rev-parse", "HEAD");
      await writeFile(join(path, "later.txt"), "work after merge\n");
      await git(path, "add", "later.txt");
      await git(path, "commit", "-q", "-m", "work after merged PR");
      const runner: ProcessAdapter = {
        ...process,
        async run(command, args, options) {
          if (command === "gh" && args[0] === "pr" && args[1] === "list")
            return ok({ stdout: JSON.stringify([{ state: "MERGED", headRefOid: mergedHead }]), stderr: "", exitCode: 0 });
          return process.run(command, args, options);
        },
      };
      const result = await finish(f, path, "main", runner);
      expect(result.kind === "ok" ? result.exitCode : result.exitCode).toBe(1);
      expect(result.kind === "ok" ? result.value : result.error).toContain("unmerged-branch");
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/later-commit")).toBe("feat/later-commit");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("uses Git-only checks when GitHub is unavailable", async () => {
    const f = await fixture();
    try {
      const path = await worktree(f, "feat/offline");
      const runner: ProcessAdapter = {
        ...process,
        async run(command, args, options) {
          if (command === "gh" && args[0] === "pr" && args[1] === "list") return failed("gh unavailable", 1);
          return process.run(command, args, options);
        },
      };
      const result = await finish(f, path, "main", runner);
      expect(result.kind === "ok" ? result.exitCode : result.exitCode).toBe(1);
      expect(result.kind === "ok" ? result.value : result.error).toContain("unmerged-branch");
      expect(await git(f.repo, "branch", "--format=%(refname:short)", "--list", "feat/offline")).toBe("feat/offline");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
