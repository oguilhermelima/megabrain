import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeWorktreeCreate } from "../../src/cli/commands/worktree-write.js";
import { createName, finishJson, parseCreateOptions, parseFinishOptions, parsePullRequestOptions } from "../../src/core/worktree-write.js";

function creationProcess(repo: string): ProcessAdapter {
  const result = (stdout = "", exitCode = 0): Result<ProcessOutput> =>
    ok({ stdout, stderr: "", exitCode });
  return {
    async run(command, args) {
      if (command !== "git") return result();
      if (args.includes("--show-toplevel")) return result(`${repo}\n`);
      if (args.includes("show-ref")) return failed("branch does not exist", 1);
      if (args.includes("worktree") && args.includes("add")) return result();
      if (args.includes("--verify")) return result("base-commit\n");
      return result();
    },
    async startDetached() {
      return failed("unexpected process invocation");
    },
    invocationCount() {
      return 0;
    },
  };
}

async function creationFixture() {
  const root = await mkdtemp(join(tmpdir(), "megabrain-worktree-write-unit-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  await mkdir(repo, { recursive: true });
  await mkdir(state, { recursive: true });
  return { root, repo, state };
}

describe("worktree write option contracts", () => {
  test("parses create values and rejects unknown options", () => {
    expect(parseCreateOptions(["--repo", "/repo", "--branch", "feat/x", "--from", "feat/base", "--json"])).toEqual({ kind: "ok", value: { repo: "/repo", branch: "feat/x", from: "feat/base", json: true } });
    expect(parseCreateOptions(["--repo", "/repo", "--branch", "feat/x", "--wat"])).toEqual({ kind: "failed", error: "unknown worktree create option: --wat", exitCode: 2 });
  });

  test("preserves finish refusal shape and statuses", () => {
    expect(parseFinishOptions(["/shared/x", "--delete-branch", "--force", "--json"])).toEqual({ kind: "ok", value: { target: "/shared/x", deleteBranch: true, force: true, json: true } });
    expect(finishJson({ deleted: false, refusal: { code: "unmerged-branch", message: "refusing" } })).toBe('{"deleted":false,"branch":null,"path":null,"base":null,"baseSource":null,"baseWarning":null,"branchDeleted":null,"error":null,"refusal":{"code":"unmerged-branch","message":"refusing"}}\n');
  });

  test("parses pull request flags and safe branch names", () => {
    expect(parsePullRequestOptions(["feat/x", "--base", "main", "--title", "T", "--body", "B", "--json"])).toEqual({ kind: "ok", value: { target: "feat/x", base: "main", title: "T", body: "B", json: true } });
    expect(createName("feat/x")).toBe("feat-x");
    expect(createName("../x")).toBe("..-x");
  });
});

// executeWorktreeCreate (src/cli/commands/worktree-write.ts) currently never contacts Superset at
// all: the retired shell's megabrain_worktree_create registered a Superset project and workspace
// for the new worktree whenever the caller's own session was hosted by Superset
// (megabrain_context_detect / here, resolveCaller(...).host === "superset"), and tagged the
// workspace into its parent's grouping when --parent was given. This is the gap
// tests/test-worktree-create.sh and tests/test-worktree-parent.sh's Superset scenarios document.
function supersetProcess(
  repo: string,
  options: { superset: (args: readonly string[]) => Result<ProcessOutput> | undefined; parentBranch?: string },
): { process: ProcessAdapter; calls: string[] } {
  const calls: string[] = [];
  const result = (stdout = "", exitCode = 0): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode });
  const process: ProcessAdapter = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git") {
        if (args.includes("--show-toplevel")) return result(`${repo}\n`);
        if (args.includes("show-ref")) return failed("branch does not exist", 1);
        if (args.includes("worktree") && args.includes("add")) return result();
        if (args.includes("--verify")) return result("base-commit\n");
        if (args.includes("symbolic-ref")) return options.parentBranch !== undefined ? result(`${options.parentBranch}\n`) : result();
        return result();
      }
      if (command === "superset") {
        const handled = options.superset(args);
        return handled ?? failed(`unexpected superset call: ${args.join(" ")}`, 1);
      }
      return result();
    },
    async startDetached() { return failed("unexpected process invocation"); },
    invocationCount() { return 0; },
  };
  return { process, calls };
}

function jsonResult(value: unknown): Result<ProcessOutput> {
  return ok({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
}

describe("worktree creation: Superset registration", () => {
  test("registers a Superset project and workspace when the caller is inside a Superset terminal", async () => {
    const fixture = await creationFixture();
    await writeFile(join(fixture.state, "worktree-root"), `${join(fixture.root, "shared")}\n`);
    try {
      const { process, calls } = supersetProcess(fixture.repo, {
        superset: (args) => {
          const [group, verb] = args;
          if (group === "projects" && verb === "list") return jsonResult({ projects: [] });
          if (group === "projects" && verb === "create") return jsonResult({ result: { project: { id: "project-id" } } });
          if (group === "workspaces" && verb === "list") return jsonResult({ workspaces: [] });
          if (group === "workspaces" && verb === "create") return jsonResult({ result: { workspace: { id: "workspace-id" } } });
          return undefined;
        },
      });
      const result = await executeWorktreeCreate(
        ["--repo", fixture.repo, "--branch", "feat/superset", "--base", "main", "--json"],
        { MEGABRAIN_STATE_DIR: fixture.state, SUPERSET_TERMINAL_ID: "parent-terminal" },
        process,
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(JSON.parse(result.value).workspace).toBe("workspace-id");
      expect(calls.some((call) => call === `superset projects create --local --import ${fixture.repo} --name repo --json`)).toBe(true);
      expect(calls.some((call) => call.startsWith("superset workspaces create") && call.includes("--branch feat/superset"))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not contact Superset when the caller is not running inside one", async () => {
    const fixture = await creationFixture();
    await writeFile(join(fixture.state, "worktree-root"), `${join(fixture.root, "shared")}\n`);
    try {
      const { process, calls } = supersetProcess(fixture.repo, { superset: () => failed("should not be called", 1) });
      const result = await executeWorktreeCreate(
        ["--repo", fixture.repo, "--branch", "feat/plain", "--base", "main", "--json"],
        { MEGABRAIN_STATE_DIR: fixture.state },
        process,
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(JSON.parse(result.value).workspace).toBeNull();
      expect(calls.some((call) => call.startsWith("superset"))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("tags the new workspace into its parent's Superset grouping when --parent is set", async () => {
    const fixture = await creationFixture();
    await writeFile(join(fixture.state, "worktree-root"), `${join(fixture.root, "shared")}\n`);
    try {
      const { process, calls } = supersetProcess(fixture.repo, {
        parentBranch: "main",
        superset: (args) => {
          const [group, verb] = args;
          if (group === "projects" && verb === "list") return jsonResult({ projects: [] });
          if (group === "projects" && verb === "create") return jsonResult({ result: { project: { id: "project-id" } } });
          if (group === "workspaces" && verb === "list") return jsonResult({ workspaces: [] });
          if (group === "workspaces" && verb === "create") return jsonResult({ result: { workspace: { id: "workspace-id" } } });
          if (group === "workspaces" && verb === "update") return jsonResult({ ok: true });
          return undefined;
        },
      });
      const result = await executeWorktreeCreate(
        ["--repo", fixture.repo, "--branch", "feat/tagged", "--base", "main", "--parent", `path:${fixture.repo}`, "--json"],
        { MEGABRAIN_STATE_DIR: fixture.state, SUPERSET_TERMINAL_ID: "parent-terminal" },
        process,
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const parsed = JSON.parse(result.value) as { parent: { grouping: { set: boolean } } };
      expect(parsed.parent.grouping.set).toBe(true);
      expect(calls.some((call) => call === "superset workspaces update workspace-id --tag main --json")).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("worktree creation shared root", () => {
  test("creates a missing shared root and uses its resolved but unreal path", async () => {
    const fixture = await creationFixture();
    const shared = join(fixture.root, "shared");
    await writeFile(join(fixture.state, "worktree-root"), `${shared}\n`);
    try {
      const result = await executeWorktreeCreate(
        ["--repo", fixture.repo, "--branch", "feat/missing-root", "--base", "main", "--json"],
        { MEGABRAIN_STATE_DIR: fixture.state },
        creationProcess(fixture.repo),
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(JSON.parse(result.value).worktree).toBe(join(shared, "feat-missing-root"));
      expect((await stat(shared)).isDirectory()).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("creates with the canonical path when the shared root resolves", async () => {
    const fixture = await creationFixture();
    const physicalShared = join(fixture.root, "shared");
    const sharedLink = join(fixture.root, "shared-link");
    await mkdir(physicalShared);
    await symlink(physicalShared, sharedLink);
    await writeFile(join(fixture.state, "worktree-root"), `${sharedLink}\n`);
    try {
      const result = await executeWorktreeCreate(
        ["--repo", fixture.repo, "--branch", "feat/existing-root", "--base", "main", "--json"],
        { MEGABRAIN_STATE_DIR: fixture.state },
        creationProcess(fixture.repo),
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(JSON.parse(result.value).worktree).toBe(join(await realpath(sharedLink), "feat-existing-root"));
      expect((await stat(physicalShared)).isDirectory()).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
