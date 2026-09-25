import { failed, ok, type Result } from "./result.js";
import { usageMessage } from "./usage.js";

export type AdoptOptions = { readonly target: string; readonly json: boolean };
export type AdoptResult = { readonly worktree: string; readonly branch: string; readonly workspace: string };

export function parseAdoptOptions(args: readonly string[]): Result<AdoptOptions> {
  let target: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok({ target: "", json });
    else if (target === undefined) target = arg;
    else return failed(`unknown worktree adopt option: ${arg}`, 2);
  }
  return target === undefined ? failed(usageMessage("worktree-adopt"), 2) : ok({ target, json });
}

export function formatAdopt(result: AdoptResult, json: boolean): string {
  return json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `worktree: ${result.worktree}\nbranch: ${result.branch}\nworkspace: ${result.workspace}\n`;
}
