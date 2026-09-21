import { readdir } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { decorateDispatchRecord, filterDispatchRecords, formatDispatchList, parseDispatchRecord, type DispatchCaller, type DispatchListOptions, type DispatchRecord } from "../../core/dispatch.js";
import { resolveStateDirectory } from "../../core/state.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { getTmux } from "../../hosts/tmux.js";

export type OrchestrateListEnvironment = Readonly<Record<string, string | undefined>>;

export async function callerFromEnvironment(environment: OrchestrateListEnvironment, process: ProcessAdapter): Promise<DispatchCaller> {
  if (environment.SUPERSET_TERMINAL_ID !== undefined && environment.SUPERSET_TERMINAL_ID.length > 0) {
    return { id: environment.SUPERSET_TERMINAL_ID, host: "superset" };
  }
  if (environment.ORCA_TERMINAL_HANDLE !== undefined && environment.ORCA_TERMINAL_HANDLE.length > 0) {
    return { id: environment.ORCA_TERMINAL_HANDLE, host: "orca" };
  }
  if (environment.TMUX !== undefined && environment.TMUX_PANE !== undefined && environment.TMUX.length > 0 && environment.TMUX_PANE.length > 0) {
    const session = await getTmux().sessionForPane(environment.TMUX_PANE, process);
    if (session.kind === "ok") {
      return { id: `${session.value}:${environment.TMUX_PANE}`, host: "tmux" };
    }
  }
  if (environment.MEGABRAIN_SESSION_ID !== undefined && environment.MEGABRAIN_SESSION_ID.length > 0 && environment.MEGABRAIN_SESSION_HOST !== undefined && environment.MEGABRAIN_SESSION_HOST.length > 0) {
    return { id: environment.MEGABRAIN_SESSION_ID, host: environment.MEGABRAIN_SESSION_HOST };
  }
  return { id: "", host: "unknown" };
}

async function metadataPaths(dispatchRoot: string): Promise<string[]> {
  const paths: string[] = [];
  async function add(parent: string, entries: string[]): Promise<void> {
    for (const entry of entries) {
      const path = `${parent}/${entry}`;
      const stat = await Bun.file(path).exists();
      if (stat && entry === "meta.json") paths.push(path);
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
      const parsed = parseDispatchRecord(await Bun.file(path).json());
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
  if (args.includes("-h") || args.includes("--help")) return ok("Usage: megabrain orchestrate list [--all|--orphans|--uncertain] [--json]\n");
  const root = resolveStateDirectory(environment);
  const caller = await callerFromEnvironment(environment, process);
  const records = await loadRecords(root);
  if (records.length === 0) {
    return parsedArgs.value.json ? ok("[]\n") : ok(formatDispatchList([], false));
  }
  const selected = filterDispatchRecords(records, parsedArgs.value.options, caller).map((record) => decorateDispatchRecord(record, caller));
  return ok(formatDispatchList(selected, parsedArgs.value.json));
}
