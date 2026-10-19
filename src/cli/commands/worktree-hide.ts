import { realpath } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { callStateOwner } from "../../db/state-owner.js";

export async function executeWorktreeHide(args: readonly string[], environment: Readonly<Record<string, string | undefined>>, hidden: boolean): Promise<Result<string>> {
  const path = args.find((argument) => !argument.startsWith("-"));
  if (path === undefined) return failed(`Usage: megabrain worktree ${hidden ? "hide" : "unhide"} <path>`, 2);
  const canonical = await realpath(path).catch(() => undefined);
  if (canonical === undefined) return failed(`worktree not found: ${path}`);
  try {
    await callStateOwner(resolveStateDirectory(environment), { operation: "hidden-item-write", kind: "worktree", path: canonical, hidden });
    return ok(`${hidden ? "hidden" : "shown"} ${canonical}\n`);
  } catch (cause: unknown) { return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
