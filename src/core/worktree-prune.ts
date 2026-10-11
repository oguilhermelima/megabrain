import { failed, ok, type Result } from "./result.js";

export type WorktreePruneOptions = Readonly<{ olderThan: number; repo?: string; dryRun: boolean; yes: boolean; json: boolean }>;

export function parseWorktreePruneArgs(args: readonly string[]): Result<WorktreePruneOptions> {
  let olderThan = 30;
  let repo: string | undefined;
  let explicitDryRun = false;
  let yes = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--older-than") {
      const value = args[++index];
      if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return failed("--older-than must be a non-negative number of days", 2);
      olderThan = Number(value);
    } else if (arg === "--repo") {
      const value = args[++index];
      if (value === undefined || value.trim() === "") return failed("--repo requires a name or path", 2);
      repo = value;
    } else if (arg === "--dry-run") explicitDryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok({ olderThan, repo, dryRun: !yes || explicitDryRun, yes, json });
    else return failed(`unknown worktree prune option: ${arg}`, 2);
  }
  return ok({ olderThan, repo, dryRun: !yes || explicitDryRun, yes, json });
}
