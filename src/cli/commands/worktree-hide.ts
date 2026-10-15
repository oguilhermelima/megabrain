import { realpath } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { setHiddenItem } from "../../db/queries/hidden-items.js";

export async function executeWorktreeHide(args: readonly string[], environment: Readonly<Record<string, string | undefined>>, hidden: boolean): Promise<Result<string>> {
  const path = args.find((argument) => !argument.startsWith("-"));
  if (path === undefined) return failed(`Usage: megabrain worktree ${hidden ? "hide" : "unhide"} <path>`, 2);
  const canonical = await realpath(path).catch(() => undefined);
  if (canonical === undefined) return failed(`worktree not found: ${path}`);
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const result = withWrite(opened.value, (db) => setHiddenItem(db, "worktree", canonical, hidden));
    return result.kind === "ok" ? ok(`${hidden ? "hidden" : "shown"} ${canonical}\n`) : failed(result.error, result.exitCode);
  } finally { opened.value.close(); }
}
