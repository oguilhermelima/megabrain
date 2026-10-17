import { join } from "node:path";
import { ok, type Result } from "../../core/result.js";
import { summariesContext } from "../../chat/summary-library.js";

type Environment = Readonly<Record<string, string | undefined>>;

// SessionStart hook of the opt-in summaries-context module. Claude and Codex pass the session's
// cwd on stdin and take hookSpecificOutput.additionalContext back. A hook never fails: bad input,
// a missing cwd or no summaries all print nothing.
export async function executeHookSessionStart(_args: readonly string[], environment: Environment, readStdin: () => Promise<string>): Promise<Result<string>> {
  let cwd: unknown;
  try { cwd = (JSON.parse(await readStdin()) as { cwd?: unknown }).cwd; } catch { return ok(""); }
  if (typeof cwd !== "string" || cwd === "") return ok("");
  try {
    const dir = environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain");
    const context = await summariesContext(dir, cwd, 3);
    if (context === "") return ok("");
    return ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`);
  } catch { return ok(""); }
}
