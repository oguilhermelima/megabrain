import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";

let root = "";
let home = "";
let state = "";
let repo = "";
let env: NodeJS.ProcessEnv;

// Real git, but no host CLI (orca, superset, gh) may be reached from a test.
const real = createProcessAdapter();
const processAdapter: ProcessAdapter = {
  run: (command, args, options) => ["orca", "superset", "gh"].includes(command) || (command === "sh" && args.join(" ").includes("command -v"))
    ? Promise.resolve(failed(`${command} unavailable in tests`))
    : real.run(command, args, options),
  startDetached: (...args) => real.startDetached(...args),
  invocationCount: () => real.invocationCount(),
};

const identity = ["-c", "user.name=T", "-c", "user.email=t@example.test"];
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await real.run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value.stdout.trim();
}
async function cli(...args: string[]) {
  return route(args, { environment: env, processAdapter });
}
function parse<T>(result: { kind: string; value?: string; error?: string }): T {
  if (result.kind !== "ok" || result.value === undefined) throw new Error(result.error ?? "expected command output");
  return JSON.parse(result.value) as T;
}
const refused = (result: { kind: string; exitCode?: number }): boolean => result.kind === "failed" || (result.exitCode ?? 0) !== 0;
const message = (result: { kind: string; value?: string; error?: string }): string => `${result.error ?? ""}${result.value ?? ""}`;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-worktree-archive-")));
  home = join(root, "home");
  state = join(root, "state");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(state);
  mkdirSync(repo);
  writeFileSync(join(state, "worktree-root"), join(root, "shared"));
  env = { HOME: home, MEGABRAIN_STATE_DIR: state };
  await git(repo, "init", "-b", "main");
  await git(repo, ...identity, "commit", "--allow-empty", "-m", "initial");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function worktree(branch: string, parent?: string): Promise<string> {
  const path = join(root, "shared", branch.replaceAll("/", "-"));
  mkdirSync(join(root, "shared"), { recursive: true });
  await git(repo, "worktree", "add", path, "-b", branch, "main");
  if (parent !== undefined) await git(repo, "config", `branch.${branch}.megabrain-parent`, parent);
  return path;
}

type Archived = { repo: string; branch: string; head: string; archivedAt: string; parent: string | null; pullRequest: unknown; path: string };
const archivedFile = () => join(state, "archived-worktrees.json");

describe("worktree archive", () => {
  test("removes the folder, keeps the branch and records the branch", async () => {
    const path = await worktree("feat/one", "main");
    await git(path, ...identity, "commit", "--allow-empty", "-m", "work");
    const head = await git(path, "rev-parse", "HEAD");
    const result = await cli("worktree", "archive", "feat/one", "--repo", repo, "--force", "--json");
    expect(result.kind).toBe("ok");
    expect(existsSync(path)).toBe(false);
    expect(await git(repo, "branch", "--list", "feat/one")).toContain("feat/one");
    expect(await git(repo, "tag", "--list")).toBe("");
    const record = parse<Archived>(result);
    expect(record).toMatchObject({ repo, branch: "feat/one", head, parent: "main", pullRequest: null, path });
    expect(Date.parse(record.archivedAt)).not.toBeNaN();
    expect(statSync(archivedFile()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(archivedFile(), "utf8"))).toBeTruthy();
  });

  test("resolves a worktree path and works without --repo", async () => {
    const path = await worktree("feat/two");
    const result = await cli("worktree", "archive", path, "--force", "--json");
    expect(parse<Archived>(result)).toMatchObject({ repo, branch: "feat/two", parent: null });
  });

  test("refuses uncommitted changes and unpushed commits unless forced, naming them", async () => {
    const path = await worktree("feat/dirty");
    writeFileSync(join(path, "notes.txt"), "draft");
    const dirty = await cli("worktree", "archive", "feat/dirty", "--repo", repo, "--json");
    expect(refused(dirty)).toBe(true);
    expect(message(dirty)).toContain("notes.txt");
    expect(existsSync(path)).toBe(true);
    await git(path, "add", "notes.txt");
    await git(path, ...identity, "commit", "-m", "notes");
    const unpushed = await cli("worktree", "archive", "feat/dirty", "--repo", repo, "--json");
    expect(refused(unpushed)).toBe(true);
    expect(message(unpushed)).toContain("unpushed");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(archivedFile())).toBe(false);
    expect((await cli("worktree", "archive", "feat/dirty", "--repo", repo, "--force", "--json")).kind).toBe("ok");
    expect(existsSync(path)).toBe(false);
  });

  test("refuses the primary checkout and unknown branches", async () => {
    const primary = await cli("worktree", "archive", "main", "--repo", repo, "--json");
    expect(refused(primary)).toBe(true);
    expect(message(primary)).toContain("primary");
    expect(existsSync(repo)).toBe(true);
    const missing = await cli("worktree", "archive", "feat/none", "--repo", repo, "--json");
    expect(refused(missing)).toBe(true);
    expect(existsSync(archivedFile())).toBe(false);
  });
});

describe("worktree archived and unarchive", () => {
  test("lists archived branches per repository", async () => {
    await worktree("feat/a");
    await worktree("feat/b");
    await cli("worktree", "archive", "feat/a", "--repo", repo, "--force", "--json");
    await cli("worktree", "archive", "feat/b", "--repo", repo, "--force", "--json");
    const all = parse<{ archived: Archived[] }>(await cli("worktree", "archived", "--json")).archived;
    expect(all.map((item) => item.branch).sort()).toEqual(["feat/a", "feat/b"]);
    const other = join(root, "other");
    mkdirSync(other);
    await git(other, "init", "-b", "main");
    expect(parse<{ archived: Archived[] }>(await cli("worktree", "archived", "--repo", other, "--json")).archived).toEqual([]);
    expect(parse<{ archived: Archived[] }>(await cli("worktree", "archived", "--repo", repo, "--json")).archived).toHaveLength(2);
  });

  test("recreates the worktree at its old path and restores the parent link", async () => {
    const path = await worktree("feat/back", "main");
    await git(path, ...identity, "commit", "--allow-empty", "-m", "work");
    const head = await git(path, "rev-parse", "HEAD");
    await cli("worktree", "archive", "feat/back", "--repo", repo, "--force", "--json");
    await git(repo, "config", "--unset", "branch.feat/back.megabrain-parent");
    const result = await cli("worktree", "unarchive", "feat/back", "--repo", repo, "--json");
    expect(parse<{ branch: string; path: string; parent: string | null }>(result)).toMatchObject({ branch: "feat/back", path, parent: "main" });
    expect(await git(path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(path, "symbolic-ref", "--short", "HEAD")).toBe("feat/back");
    expect(await git(repo, "config", "--get", "branch.feat/back.megabrain-parent")).toBe("main");
    expect(parse<{ archived: Archived[] }>(await cli("worktree", "archived", "--json")).archived).toEqual([]);
  });

  test("refuses to unarchive an unknown branch or over an occupied path", async () => {
    expect((await cli("worktree", "unarchive", "feat/ghost", "--repo", repo, "--json")).kind).toBe("failed");
    const path = await worktree("feat/busy");
    await cli("worktree", "archive", "feat/busy", "--repo", repo, "--force", "--json");
    mkdirSync(path);
    const refused = await cli("worktree", "unarchive", "feat/busy", "--repo", repo, "--json");
    expect(refused.kind).toBe("failed");
    expect(parse<{ archived: Archived[] }>(await cli("worktree", "archived", "--json")).archived).toHaveLength(1);
  });
});

describe("projects and archived branches", () => {
  test("an archived branch never appears in projects worktrees and returns after unarchive", async () => {
    await worktree("feat/shown");
    await worktree("feat/hidden");
    expect((await cli("repo", "add", repo)).kind).toBe("ok");
    const branches = async () => parse<Array<{ worktrees: Array<{ branch: string | null }> }>>(await cli("projects", "--json"))[0]?.worktrees.map((tree) => tree.branch).sort();
    expect(await branches()).toEqual(["feat/hidden", "feat/shown", "main"]);
    await cli("worktree", "archive", "feat/hidden", "--repo", repo, "--force", "--json");
    expect(await branches()).toEqual(["feat/shown", "main"]);
    await cli("worktree", "unarchive", "feat/hidden", "--repo", repo, "--json");
    expect(await branches()).toEqual(["feat/hidden", "feat/shown", "main"]);
  });
});
