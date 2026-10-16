import { HISTORY_AGENTS, sessionHistory, type HistoryAgent } from "../../adapters/session-history.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";

type Environment = Readonly<Record<string, string | undefined>>;

export async function executeSessions(args: readonly string[], environment: Environment): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("sessions-history"));
  if (verb !== "history") return failed(usageText("sessions-history").trimEnd(), 2);
  let cwd: string | null = null;
  let agent: HistoryAgent | undefined;
  let limit: number | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") { json = true; continue; }
    if (arg !== "--cwd" && arg !== "--agent" && arg !== "--limit") return failed(`unknown sessions history option: ${arg}`, 2);
    const value = rest[index + 1];
    if (value === undefined || value.length === 0) return failed(`${arg} requires a value`, 2);
    index += 1;
    if (arg === "--cwd") cwd = value;
    else if (arg === "--agent") {
      const known = HISTORY_AGENTS.find((id) => id === value);
      if (known === undefined) return failed(`unknown agent: ${value}`, 2);
      agent = known;
    } else {
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1) return failed("--limit must be a positive integer", 2);
    }
  }
  if (cwd === null) return failed("--cwd is required", 2);
  const home = environment.HOME ?? process.env.HOME ?? "";
  const stateDir = environment.MEGABRAIN_STATE_DIR ?? `${home}/.megabrain`;
  const sessions = await sessionHistory(cwd, agent, { home, stateDir, ...(limit === undefined ? {} : { limit }) });
  if (json) return ok(`${JSON.stringify(sessions)}\n`);
  return ok(sessions.map((session) => `${session.agent}\t${session.id}\t${session.lastActivityAt ?? "-"}\t${session.title}\n`).join(""));
}
