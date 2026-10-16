import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { defaultRoots, discoverRepositories, headBranch, originUrl, walkRepositories } from "../../src/core/repository-discovery.js";
import { failed, ok } from "../../src/core/result.js";

let root = "";
let home = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-repository-discovery-")));
  home = join(root, "home");
  mkdirSync(home);
  env = { HOME: home, MEGABRAIN_STATE_DIR: join(root, "state") };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await createProcessAdapter().run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value.stdout.trim();
}

/** A repository at path with one commit dated at the given Unix second, on branch main. */
async function repository(path: string, seconds = 1_700_000_000, remote?: string): Promise<string> {
  mkdirSync(path, { recursive: true });
  await git(path, "init", "-b", "main");
  const date = `@${seconds} +0000`;
  const result = await createProcessAdapter().run("git", ["-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--allow-empty", "-m", "initial"], { cwd: path, env: { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  if (result.kind !== "ok") throw new Error(result.error);
  if (remote !== undefined) await git(path, "remote", "add", "origin", remote);
  return path;
}

function json<T>(result: { kind: string; value?: string; error?: string }): T {
  if (result.kind !== "ok" || result.value === undefined) throw new Error(result.error ?? "expected command output");
  return JSON.parse(result.value) as T;
}

describe("walkRepositories", () => {
  test("finds main checkouts two levels down and never descends into one", async () => {
    const workspaces = join(root, "Workspaces");
    await repository(join(workspaces, "api"));
    await repository(join(workspaces, "clients", "web"));
    await repository(join(workspaces, "api", "vendor", "nested"));
    await repository(join(workspaces, "a", "b", "too-deep"));
    expect(walkRepositories(workspaces, 2).sort()).toEqual([join(workspaces, "api"), join(workspaces, "clients", "web")]);
  });

  test("skips hidden folders, node_modules and linked worktrees", async () => {
    const workspaces = join(root, "Workspaces");
    const main = await repository(join(workspaces, "main"));
    await repository(join(workspaces, ".hidden"));
    await repository(join(workspaces, "node_modules", "pkg"));
    await git(main, "worktree", "add", "-b", "feature", join(workspaces, "feature-tree"));
    expect(walkRepositories(workspaces, 2)).toEqual([main]);
  });

  test("a missing root finds nothing", () => {
    expect(walkRepositories(join(root, "absent"), 2)).toEqual([]);
  });
});

describe("headBranch and originUrl", () => {
  test("read the branch and origin without starting git", async () => {
    const path = await repository(join(root, "repo"), 1_700_000_000, "git@github.com:operator/repo.git");
    await git(path, "remote", "add", "upstream", "https://example.test/upstream.git");
    expect(headBranch(join(path, ".git"))).toBe("main");
    expect(originUrl(join(path, ".git"))).toBe("git@github.com:operator/repo.git");
  });

  test("are null for a detached HEAD and a repository without origin", async () => {
    const path = await repository(join(root, "repo"));
    await git(path, "checkout", "--detach");
    expect(headBranch(join(path, ".git"))).toBeNull();
    expect(originUrl(join(path, ".git"))).toBeNull();
  });
});

describe("defaultRoots", () => {
  test("are the common folders, then each registered repository's parent, once each", () => {
    expect(defaultRoots("/home/op", ["/home/op/Workspaces/api", "/srv/work/one", "/srv/work/two"])).toEqual([
      "/home/op/Workspaces", "/home/op/Developer", "/home/op/Projects", "/home/op/code", "/home/op/src", "/srv/work",
    ]);
  });
});

describe("discoverRepositories", () => {
  test("leaves out registered repositories and lists the rest newest commit first", async () => {
    const workspaces = join(root, "Workspaces");
    const old = await repository(join(workspaces, "old"), 1_600_000_000);
    const recent = await repository(join(workspaces, "recent"), 1_700_000_000, "https://github.com/operator/recent");
    const registered = await repository(join(workspaces, "registered"));
    const found = await discoverRepositories({ roots: [workspaces], registered: [registered] }, createProcessAdapter());
    expect(found.map((repository) => repository.path)).toEqual([recent, old]);
    expect(found[0]).toEqual({ name: "recent", path: recent, branch: "main", remote: "https://github.com/operator/recent", lastCommitAt: "2023-11-14T22:13:20.000Z", root: workspaces });
  });

  test("lists a repository two roots reach once, under the first", async () => {
    const workspaces = join(root, "Workspaces");
    const nested = join(workspaces, "group");
    const path = await repository(join(nested, "app"));
    const found = await discoverRepositories({ roots: [workspaces, nested, workspaces], registered: [] }, createProcessAdapter());
    expect(found.map((repository) => [repository.path, repository.root])).toEqual([[path, workspaces]]);
  });

  test("a repository whose git log fails keeps a null commit time", async () => {
    const path = await repository(join(root, "Workspaces", "app"));
    const broken: ProcessAdapter = { run: async () => failed("git failed"), startDetached: async () => ok({ pid: 0 }), invocationCount: () => 0 };
    const found = await discoverRepositories({ roots: [join(root, "Workspaces")], registered: [] }, broken);
    expect(found).toEqual([{ name: "app", path, branch: "main", remote: null, lastCommitAt: null, root: join(root, "Workspaces") }]);
  });
});

describe("repo discover", () => {
  test("defaults to the common folders under HOME and skips what repo add registered", async () => {
    const one = await repository(join(home, "Workspaces", "one"));
    const two = await repository(join(home, "code", "two"));
    await repository(join(root, "elsewhere", "three"));
    expect((await route(["repo", "add", two, "--json"], { environment: env, processAdapter: createProcessAdapter() })).kind).toBe("ok");
    const found = json<{ path: string }[]>(await route(["repo", "discover", "--json"], { environment: env, processAdapter: createProcessAdapter() }));
    expect(found.map((repository) => repository.path)).toEqual([one]);
  });

  test("searches the parent folder of a registered repository by default", async () => {
    const registered = await repository(join(root, "work", "registered"));
    const sibling = await repository(join(root, "work", "sibling"));
    await route(["repo", "add", registered, "--json"], { environment: env, processAdapter: createProcessAdapter() });
    const found = json<{ path: string }[]>(await route(["repo", "discover", "--json"], { environment: env, processAdapter: createProcessAdapter() }));
    expect(found.map((repository) => repository.path)).toEqual([sibling]);
  });

  test("--roots replaces the defaults, expands ~ and takes a comma-separated list", async () => {
    await repository(join(home, "Workspaces", "default"));
    const custom = await repository(join(home, "custom", "app"));
    const other = await repository(join(root, "other", "lib"));
    const found = json<{ path: string }[]>(await route(["repo", "discover", "--roots", `~/custom, ${join(root, "other")}`, "--json"], { environment: env, processAdapter: createProcessAdapter() }));
    expect(found.map((repository) => repository.path).sort()).toEqual([custom, other].sort());
  });

  test("--roots without a value is a usage error", async () => {
    const result = await route(["repo", "discover", "--roots", "--json"], { environment: env, processAdapter: createProcessAdapter() });
    expect(result).toMatchObject({ kind: "failed", exitCode: 2 });
  });

  test("an empty machine answers an empty list", async () => {
    expect(json<unknown[]>(await route(["repo", "discover", "--json"], { environment: env, processAdapter: createProcessAdapter() }))).toEqual([]);
  });
});
