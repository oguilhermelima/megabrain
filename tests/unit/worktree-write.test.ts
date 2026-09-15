import { describe, expect, test } from "bun:test";
import { createName, finishJson, parseCreateOptions, parseFinishOptions, parsePullRequestOptions } from "../../src/core/worktree-write.js";

describe("worktree write option contracts", () => {
  test("parses create values and rejects unknown options", () => {
    expect(parseCreateOptions(["--repo", "/repo", "--branch", "feat/x", "--json"])).toEqual({ kind: "ok", value: { repo: "/repo", branch: "feat/x", json: true } });
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
