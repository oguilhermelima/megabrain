import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { pathFor } from "../../src/cli/commands/worktree-write.js";
import { openDatabase, withWrite } from "../../src/db/db.js";
import { registerRepository } from "../../src/db/queries/repositories.js";

const process = createProcessAdapter();
const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
let root: string;
let state: string;
let environment: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await process.run("git", ["-C", cwd, ...args]);
  if (result.kind !== "ok")
    throw new Error(`git ${args.join(" ")}: ${result.error}`);
}

async function repository(name: string): Promise<string> {
  const path = join(root, "code", name);
  mkdirSync(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, ...identity, "commit", "--allow-empty", "-m", "initial");
  const handle = openDatabase(environment);
  if (handle.kind !== "ok") throw new Error(handle.error);
  const written = withWrite(handle.value, (db) =>
    registerRepository(db, {
      name,
      path,
      remote: null,
      source: "import",
      addedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  handle.value.close();
  if (written.kind !== "ok") throw new Error(written.error);
  return path;
}

const lookup = (target: string) =>
  pathFor(process, target, join(root, "shared"), environment);

beforeEach(() => {
  root = realpathSync(
    mkdtempSync(join(tmpdir(), "megabrain-worktree-lookup-")),
  );
  state = join(root, "state");
  mkdirSync(state);
  mkdirSync(join(root, "home"));
  writeFileSync(join(state, "worktree-root"), join(root, "shared"));
  environment = { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: state };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("worktree lookup by name", () => {
  test("finds a worktree under the megabrain state folder by branch and by folder name", async () => {
    const repo = await repository("alpha");
    const path = join(state, "worktrees", "alpha", "feat-one");
    await git(repo, "worktree", "add", path, "-b", "feat/one", "main");
    expect(await lookup("feat/one")).toEqual({ kind: "ok", value: path });
    expect(await lookup("feat-one")).toEqual({ kind: "ok", value: path });
  });

  test("finds a worktree inside the repository's .worktrees folder", async () => {
    const repo = await repository("alpha");
    const path = join(repo, ".worktrees", "fix-two");
    await git(repo, "worktree", "add", path, "-b", "fix/two", "main");
    expect(await lookup("fix/two")).toEqual({ kind: "ok", value: path });
  });

  test("finds a worktree in a custom root outside the shared root", async () => {
    const repo = await repository("alpha");
    const path = join(root, "elsewhere", "alpha", "docs-three");
    await git(repo, "worktree", "add", path, "-b", "docs/three", "main");
    expect(await lookup("docs/three")).toEqual({ kind: "ok", value: path });
  });

  test("still finds a worktree in the shared root", async () => {
    const repo = await repository("alpha");
    const path = join(root, "shared", "feat-four");
    await git(repo, "worktree", "add", path, "-b", "feat/four", "main");
    expect(await lookup("feat/four")).toEqual({ kind: "ok", value: path });
  });

  test("a branch in two repositories is ambiguous and lists both candidates", async () => {
    const alpha = await repository("alpha");
    const beta = await repository("beta");
    const first = join(state, "worktrees", "alpha", "feat-same");
    const second = join(beta, ".worktrees", "feat-same");
    await git(alpha, "worktree", "add", first, "-b", "feat/same", "main");
    await git(beta, "worktree", "add", second, "-b", "feat/same", "main");
    const result = await lookup("feat/same");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).toContain(first);
      expect(result.error).toContain(second);
      expect(result.error).toContain("--repo");
    }
  });

  test("the full path still works and an unknown name still fails", async () => {
    const repo = await repository("alpha");
    const path = join(repo, ".worktrees", "fix-five");
    await git(repo, "worktree", "add", path, "-b", "fix/five", "main");
    expect(await lookup(path)).toEqual({ kind: "ok", value: path });
    const missing = await lookup("nope/nothing");
    expect(missing.kind).toBe("failed");
  });
});
