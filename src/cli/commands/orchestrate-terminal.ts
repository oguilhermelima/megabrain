import { type ProcessAdapter } from "../../adapters/proc.js";

export type RecordValue = Record<string, unknown>;
export type TerminalStatus = "proven" | "missing" | "unknown";
export type ParentStatus = "alive" | "gone" | "unknown";

const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const recordValue = (value: unknown): RecordValue | undefined => isRecord(value) ? value : undefined;

function processTreeHasIdentity(output: string, rootPid: string, marker: string): boolean {
  const parents = new Map<string, string>();
  const commands = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, parent, command] = match;
    if (pid === undefined || parent === undefined || command === undefined) continue;
    parents.set(pid, parent);
    commands.set(pid, command);
  }
  const pending = [rootPid];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const command = commands.get(pid);
    if (command?.split(/\s+/).includes(marker) === true) return true;
    for (const [candidate, parent] of parents) if (parent === pid) pending.push(candidate);
  }
  return false;
}

function parseJson(value: string): unknown | undefined {
  try { return JSON.parse(value); } catch { return undefined; }
}

function hostItems(value: unknown, host: string): readonly RecordValue[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is RecordValue => recordValue(item) !== undefined);
  const root = recordValue(value);
  if (root === undefined) return undefined;
  const result = recordValue(root.result);
  const candidates = host === "orca" ? [root.terminals, result?.terminals] : [root.sessions, result?.sessions, result?.terminals, root.terminals];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate.filter((item): item is RecordValue => recordValue(item) !== undefined);
  return undefined;
}

function hasHostTerminal(value: unknown, host: string, id: string): boolean {
  return hostItems(value, host)?.some((item) => (host === "orca" ? stringValue(item.handle) : stringValue(item.terminalId)) === id) ?? false;
}

async function hostList(meta: RecordValue, process: ProcessAdapter): Promise<{ readonly status: TerminalStatus; readonly records?: unknown }> {
  const host = stringValue(meta.childHost);
  const workspace = stringValue(meta.workspaceId);
  const command = host === "orca" ? "orca" : host === "superset" ? "megabrain_superset" : "";
  const args = host === "orca" ? ["terminal", "list", "--json"] : host === "superset" && workspace !== "" ? ["terminals", "list", "--workspace", workspace, "--json"] : [];
  if (command === "" || args.length === 0) return { status: "unknown" };
  const result = await process.run(command, args);
  if (result.kind !== "ok") return { status: "unknown" };
  const records = parseJson(result.value.stdout);
  const items = hostItems(records, host);
  if (items === undefined) return { status: "unknown", records };
  if (hasHostTerminal(records, host, stringValue(meta.terminalId))) return { status: "proven", records };
  return { status: items.length === 0 ? "missing" : "unknown", records };
}

export async function terminalStatus(meta: RecordValue, process: ProcessAdapter): Promise<TerminalStatus> {
  if (stringValue(meta.runtime) !== "tmux") return (await hostList(meta, process)).status;
  const session = stringValue(meta.tmuxSession);
  const pane = stringValue(meta.tmuxPane);
  const dispatch = stringValue(meta.dispatchId);
  if ((await process.run("tmux", ["has-session", "-t", session])).kind !== "ok") return "missing";
  const panes = await process.run("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"]);
  if (panes.kind !== "ok") return "missing";
  if (!panes.value.stdout.split("\n").includes(pane)) return "missing";
  const pid = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"]);
  if (pid.kind !== "ok" || pid.value.stdout.trim() === "") return "unknown";
  const tty = await process.run("ps", ["-p", pid.value.stdout.trim(), "-o", "tty="]);
  if (tty.kind !== "ok" || tty.value.stdout.trim() === "") return "unknown";
  const tree = await process.run("ps", ["eww", "-t", tty.value.stdout.trim(), "-o", "pid=,ppid=,command="]);
  if (tree.kind !== "ok") return "unknown";
  const marker = `MEGABRAIN_DISPATCH_ID=${dispatch}`;
  return processTreeHasIdentity(tree.value.stdout, pid.value.stdout.trim(), marker) ? "proven" : "unknown";
}

async function parentRecords(meta: RecordValue, process: ProcessAdapter): Promise<{ readonly status: ParentStatus; readonly records?: unknown }> {
  const host = stringValue(meta.parentHost);
  const parent = stringValue(meta.parentSessionId);
  if (host === "orca") {
    const result = await process.run("orca", ["terminal", "list", "--json"]);
    if (result.kind !== "ok") return { status: "unknown" };
    const records = parseJson(result.value.stdout);
    const items = hostItems(records, host);
    if (items === undefined) return { status: "unknown", records };
    return { status: hasHostTerminal(records, host, parent) ? "alive" : "gone", records };
  }
  if (host !== "superset") return { status: "unknown" };
  const workspaces = await process.run("megabrain_superset", ["workspaces", "list", "--local", "--json"]);
  if (workspaces.kind !== "ok") return { status: "unknown" };
  const workspaceValue = parseJson(workspaces.value.stdout);
  const root = recordValue(workspaceValue);
  const workspaceItems = Array.isArray(workspaceValue) ? workspaceValue : root === undefined ? undefined : root.workspaces ?? recordValue(root.result)?.workspaces ?? recordValue(root.result)?.result;
  if (!Array.isArray(workspaceItems)) return { status: "unknown" };
  let queried = false;
  for (const workspace of workspaceItems) {
    const workspaceRecord = recordValue(workspace);
    const workspaceId = workspaceRecord === undefined ? "" : stringValue(workspaceRecord.id) || stringValue(workspaceRecord.workspaceId);
    if (workspaceId === "") continue;
    queried = true;
    const terminals = await process.run("megabrain_superset", ["terminals", "list", "--workspace", workspaceId, "--json"]);
    if (terminals.kind !== "ok") return { status: "unknown" };
    const records = parseJson(terminals.value.stdout);
    const items = hostItems(records, host);
    if (items === undefined) return { status: "unknown", records };
    if (hasHostTerminal(records, host, parent)) return { status: "alive", records };
  }
  return { status: queried ? "gone" : "unknown" };
}

export async function parentStatus(meta: RecordValue, process: ProcessAdapter): Promise<ParentStatus> {
  return (await parentRecords(meta, process)).status;
}

export function interruptAffordance(agent: string): "Escape" | undefined {
  return agent === "codex" || agent === "claude" ? "Escape" : undefined;
}

export function hostReadText(value: unknown): string {
  if (typeof value === "string") return value;
  const root = recordValue(value);
  if (root === undefined) return String(value);
  const nested = [root.text, root.output, root.content, recordValue(root.result)?.text, recordValue(root.result)?.output, recordValue(root.result)?.content, recordValue(root.terminal)?.text, recordValue(root.terminal)?.output];
  for (const candidate of nested) if (typeof candidate === "string") return candidate;
  return JSON.stringify(value);
}
