import { failed, ok, type Result } from "./result.js";

export type CreateOptions = { readonly repo?: string; readonly branch?: string; readonly base?: string; readonly name?: string; readonly issue?: string; readonly linearIssue?: string; readonly pr?: string; readonly json: boolean };
export type FinishOptions = { readonly target?: string; readonly deleteBranch: boolean; readonly force: boolean; readonly base?: string; readonly json: boolean };
export type PullRequestOptions = { readonly target?: string; readonly base?: string; readonly title?: string; readonly body?: string; readonly json: boolean };
export function parseCreateOptions(args: readonly string[]): Result<CreateOptions> {
  const value: { repo?: string; branch?: string; base?: string; name?: string; issue?: string; linearIssue?: string; pr?: string; json: boolean } = { json: false };
  for (let index = 0; index < args.length; index += 1) { const arg = args[index];
    if (arg === "--json") value.json = true;
    else if (["--repo", "--branch", "--base", "--name", "--issue", "--linear-issue", "--pr"].includes(arg)) { const next = args[index + 1]; if (!next) return failed(`${arg} requires a non-empty value`, 2); const key = ({ "--repo": "repo", "--branch": "branch", "--base": "base", "--name": "name", "--issue": "issue", "--linear-issue": "linearIssue", "--pr": "pr" } as const)[arg as "--repo"]; value[key] = next; index += 1; }
    else if (arg === "-h" || arg === "--help") return ok(value);
    else return failed(`unknown worktree create option: ${arg}`, 2);
  }
  if (value.repo === undefined) return failed("--repo is required", 2); if (value.branch === undefined) return failed("--branch is required", 2); return ok(value);
}
function parseCommon(args: readonly string[], command: string): Result<{ target?: string; base?: string; json: boolean }> {
  let target: string | undefined; let base: string | undefined; let json = false;
  for (let index = 0; index < args.length; index += 1) { const arg = args[index];
    if (arg === "--json") json = true; else if (arg === "--base") { const next = args[index + 1]; if (!next) return failed("--base requires a non-empty ref", 2); base = next; index += 1; }
    else if (arg === "--delete-branch" || arg === "--force") continue; else if (arg === "-h" || arg === "--help") return ok({ target, base, json });
    else if (target === undefined && !arg.startsWith("-")) target = arg; else return failed(`unknown worktree ${command} option: ${arg}`, 2);
  } return ok({ target, base, json });
}
export function parseFinishOptions(args: readonly string[]): Result<FinishOptions> { const common = parseCommon(args, "finish"); return common.kind === "ok" ? ok({ ...common.value, deleteBranch: args.includes("--delete-branch"), force: args.includes("--force") }) : common; }
export function parsePullRequestOptions(args: readonly string[]): Result<PullRequestOptions> {
  let title: string | undefined; let body: string | undefined; const commonArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) { const arg = args[index]; if (arg === "--title" || arg === "--body") { const next = args[index + 1]; if (next === undefined) return failed(`${arg} requires a non-empty value`, 2); if (arg === "--title") title = next; else body = next; index += 1; } else commonArgs.push(arg); }
  const common = parseCommon(commonArgs, "pr"); return common.kind === "ok" ? ok({ ...common.value, title, body }) : common;
}
export function createName(branch: string): string | undefined { const name = branch.replaceAll("/", "-"); return name.length === 0 || name === "." || name === ".." || name.includes("\n") ? undefined : name; }
export function finishJson(value: { deleted: boolean; branch?: string; path?: string; base?: string; baseSource?: string; baseWarning?: string; branchDeleted?: boolean; error?: string; refusal?: { code: string; message: string } }): string { return `${JSON.stringify({ deleted: value.deleted, branch: value.branch ?? null, path: value.path ?? null, base: value.base ?? null, baseSource: value.baseSource ?? null, baseWarning: value.baseWarning ?? null, branchDeleted: value.branchDeleted ?? null, error: value.error ?? null, refusal: value.refusal ?? null })}\n`; }
