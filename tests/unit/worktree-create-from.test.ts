import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { executeWorktreeCreate } from "../../src/cli/commands/worktree-write.js";

const real = createProcessAdapter();
const git = (cwd: string, ...args: readonly string[]) => real.run("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);

async function gitOut(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await git(cwd, ...args);
  return result.kind === "ok" ? result.value.stdout.trim() : `ERR ${result.error}`;
}

// Local main two commits ahead of origin/main, like the machine the issue came from.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "megabrain-create-from-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const state = join(root, "state");
  const shared = join(root, "shared");
  for (const directory of [origin, repo, state, shared]) await mkdir(directory, { recursive: true });
  await writeFile(join(state, "worktree-root"), `${shared}\n`);
  await git(origin, "init", "-q", "--bare", "-b", "main");
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "a");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-q", "origin", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "b");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "c");
  await git(repo, "fetch", "-q", "origin");
  return { root, repo, state, shared };
}

describe("worktree create --from", () => {
  test("the new worktree starts at the sha the ref had at call time, and the JSON reports it", async () => {
    const f = await fixture();
    try {
      const expected = await gitOut(f.repo, "rev-parse", "main");
      const result = await executeWorktreeCreate(["--repo", f.repo, "--branch", "feat/x", "--from", "main", "--json"], { MEGABRAIN_STATE_DIR: f.state }, real);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const created = JSON.parse(result.value) as { worktree: string; resolvedSha: string; baseCommit: string };
      expect(created.resolvedSha).toBe(expected);
      expect(created.baseCommit).toBe(expected);
      expect(await gitOut(created.worktree, "rev-parse", "HEAD")).toBe(expected);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("git is handed the resolved sha, so a ref that moves after resolution cannot change the base", async () => {
    const f = await fixture();
    try {
      const expected = await gitOut(f.repo, "rev-parse", "main");
      let handedOver: string | undefined;
      const spy: ProcessAdapter = {
        async run(command, args, options) {
          const add = command === "git" ? args.indexOf("add") : -1;
          if (add >= 0 && args[add - 1] === "worktree") handedOver = args.at(-1);
          return real.run(command, args, options);
        },
        startDetached: (command, args, options) => real.startDetached(command, args, options),
        invocationCount: () => real.invocationCount(),
      };
      const result = await executeWorktreeCreate(["--repo", f.repo, "--branch", "feat/y", "--from", "main", "--json"], { MEGABRAIN_STATE_DIR: f.state }, spy);
      expect(result.kind).toBe("ok");
      expect(handedOver).toBe(expected);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("a ref that does not exist refuses before anything is created", async () => {
    const f = await fixture();
    try {
      const result = await executeWorktreeCreate(["--repo", f.repo, "--branch", "feat/z", "--from", "nope", "--json"], { MEGABRAIN_STATE_DIR: f.state }, real);
      expect(result.kind).toBe("failed");
      expect(await gitOut(f.repo, "branch", "--list", "feat/z")).toBe("");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
