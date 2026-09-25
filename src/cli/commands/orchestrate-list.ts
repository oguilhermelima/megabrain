import { access, readFile, readdir } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { decorateDispatchRecord, filterDispatchRecords, formatDispatchList, parseDispatchRecord, type DispatchCaller, type DispatchListOptions, type DispatchRecord } from "../../core/dispatch.js";
import { resolveStateDirectory } from "../../core/state.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveCaller } from "./queue-write.js";
import { usageText } from "../../core/usage.js";

export type OrchestrateListEnvironment = Readonly<Record<string, string | undefined>>;

// The one caller-identity resolver (core/context.js, via queue-write.js resolveCaller). Narrowed
// to {id, host} — DispatchCaller's own shape — since ownership here is compared by id/host only;
// see core/dispatch.js decorateDispatchRecord for where that comparison itself now goes through
// ownsDispatch. Without this, a structured Orca session (no terminal handle) resolved to
// {id:"", host:"unknown"} and `orchestrate list` showed none of its own dispatches.
export async function callerFromEnvironment(environment: OrchestrateListEnvironment, process: ProcessAdapter): Promise<DispatchCaller> {
  const identity = await resolveCaller(environment, process);
  return { id: identity.id, host: identity.host };
}

async function metadataPaths(dispatchRoot: string): Promise<string[]> {
  const paths: string[] = [];
  async function add(parent: string, entries: string[]): Promise<void> {
    for (const entry of entries) {
      const path = `${parent}/${entry}`;
      const exists = await access(path).then(() => true, () => false);
      if (exists && entry === "meta.json") paths.push(path);
    }
  }
  const direct = (await readdir(dispatchRoot, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of direct) {
    if (entry.isDirectory() && entry.name !== "archive") await add(`${dispatchRoot}/${entry.name}`, ["meta.json"]);
  }
  const archive = (await readdir(`${dispatchRoot}/archive`, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const date of archive) {
    if (!date.isDirectory()) continue;
    const archived = (await readdir(`${dispatchRoot}/archive/${date.name}`, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const dispatch of archived) {
      if (dispatch.isDirectory()) await add(`${dispatchRoot}/archive/${date.name}/${dispatch.name}`, ["meta.json"]);
    }
  }
  return paths;
}

async function loadRecords(root: string): Promise<DispatchRecord[]> {
  const records: DispatchRecord[] = [];
  for (const path of await metadataPaths(`${root}/dispatches`)) {
    try {
      const parsed = parseDispatchRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (parsed.kind === "ok") records.push(parsed.value);
      else console.error(`skipping unreadable dispatch metadata: ${path}`);
    } catch {
      console.error(`skipping unreadable dispatch metadata: ${path}`);
    }
  }
  return records;
}

function parseArgs(args: readonly string[]): Result<{ options: DispatchListOptions; json: boolean }> {
  let json = false;
  let all = false;
  let orphans = false;
  let uncertain = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--all") all = true;
    else if (arg === "--orphans") orphans = true;
    else if (arg === "--uncertain") uncertain = true;
    else if (arg === "-h" || arg === "--help") return ok({ options: { all, orphans, uncertain }, json });
    else return failed(`unknown orchestrate list option: ${arg}`, 2);
  }
  return ok({ options: { all, orphans, uncertain }, json });
}

export async function executeOrchestrateList(args: readonly string[], environment: OrchestrateListEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  const parsedArgs = parseArgs(args);
  if (parsedArgs.kind !== "ok") return parsedArgs;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("orchestrate-list"));
  const root = resolveStateDirectory(environment);
  const caller = await callerFromEnvironment(environment, process);
  const records = await loadRecords(root);
  if (records.length === 0) {
    return parsedArgs.value.json ? ok("[]\n") : ok(formatDispatchList([], false));
  }
  const selected = filterDispatchRecords(records, parsedArgs.value.options, caller).map((record) => decorateDispatchRecord(record, caller));
  return ok(formatDispatchList(selected, parsedArgs.value.json));
}
