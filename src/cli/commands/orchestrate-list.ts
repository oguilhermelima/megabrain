import { failed, ok, type Result } from "../../core/result.js";
import { decorateDispatchRecord, filterDispatchRecords, formatDispatchList, parseDispatchRecord, type DispatchCaller, type DispatchListOptions, type DispatchRecord } from "../../core/dispatch.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveCaller } from "./queue-write.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, listDispatchEntries } from "../../adapters/state-db.js";

export type OrchestrateListEnvironment = Readonly<Record<string, string | undefined>>;

// Use the shared caller identity intact so list ownership also recognizes a matching legacy
// terminal handle, exactly as the dispatch ownership checks do elsewhere.
export async function callerFromEnvironment(environment: OrchestrateListEnvironment, process: ProcessAdapter): Promise<DispatchCaller> {
  const identity = await resolveCaller(environment, process);
  return {
    id: identity.id,
    host: identity.host,
    ...(identity.terminalId !== null && identity.terminalId !== identity.id ? { terminalId: identity.terminalId } : {}),
  };
}

function parseArgs(args: readonly string[]): Result<{ options: DispatchListOptions; json: boolean }> {
  let json = false;
  let all = false;
  let mine = false;
  let orphans = false;
  let uncertain = false;
  let archived = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--all") all = true;
    else if (arg === "--mine") mine = true;
    else if (arg === "--orphans") orphans = true;
    else if (arg === "--uncertain") uncertain = true;
    else if (arg === "--archived") archived = true;
    else if (arg === "-h" || arg === "--help") return ok({ options: { all, orphans, uncertain, archived }, json });
    else return failed(`unknown orchestrate list option: ${arg}`, 2);
  }
  if (all && mine) return failed("orchestrate list options --all and --mine cannot be combined", 2);
  return ok({ options: { all, orphans, uncertain, archived }, json });
}

export async function executeOrchestrateList(args: readonly string[], environment: OrchestrateListEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  const parsedArgs = parseArgs(args);
  if (parsedArgs.kind !== "ok") return parsedArgs;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("orchestrate-list"));
  const caller = await callerFromEnvironment(environment, process);
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const entries = listDispatchEntries(database.value, { includeArchived: true });
  if (entries.kind !== "ok") return failed(entries.error, entries.exitCode);
  const records: DispatchRecord[] = entries.value.map(({ record, archived }) => {
    const parsed = parseDispatchRecord(record);
    return parsed.kind === "ok" ? { ...parsed.value, raw: { ...parsed.value.raw, archived } } : { raw: {} };
  });
  if (records.length === 0) {
    return parsedArgs.value.json ? ok("[]\n") : ok(formatDispatchList([], false));
  }
  const selected = filterDispatchRecords(records, parsedArgs.value.options, caller).map((record) => decorateDispatchRecord(record, caller));
  return ok(formatDispatchList(selected, parsedArgs.value.json));
}
