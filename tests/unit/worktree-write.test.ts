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
