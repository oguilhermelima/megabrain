import type { ProcessAdapter } from "../adapters/proc.js";
import { getHost } from "../hosts/index.js";
import { getTmux, verifyTmuxPane } from "../hosts/tmux.js";

export type CodexQueueResult = Readonly<{ kind: "queued" }> | Readonly<{ kind: "fallback"; reason: string }>;
export type CodexProcessResult = Readonly<{ pid: number }> | Readonly<{ reason: string }>;
export type CodexTerminalScope = Readonly<{
  readonly runtime?: unknown;
  readonly host?: unknown;
  readonly childHost?: unknown;
  readonly terminalId?: unknown;
  readonly workspaceId?: unknown;
  readonly tmuxPane?: unknown;
  readonly tmuxSessionId?: unknown;
}>;

function hasThreadRollout(output: string, threadId: string): boolean {
  const suffix = `-${threadId}.jsonl`;
  return output.split("\n").some((line) => line.startsWith("n") && line.endsWith(suffix));
}

function codexCommand(command: string): boolean {
  return /(?:^|\/)codex(?:\s|$)/.test(command);
}

function descendants(output: string, rootPid: number): readonly number[] {
  const children = new Map<number, number[]>();
  const commands = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    commands.set(pid, match[3] ?? "");
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const result: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    if (codexCommand(commands.get(pid) ?? "")) result.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

function hostItems(value: unknown, host: string): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  const result = typeof root.result === "object" && root.result !== null ? root.result as Record<string, unknown> : {};
  const candidates = host === "orca" ? [root.terminals, result.terminals] : [root.sessions, result.sessions, result.terminals, root.terminals];
  return candidates.find(Array.isArray)?.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) ?? [];
}

async function terminalPid(scope: CodexTerminalScope, process: ProcessAdapter): Promise<CodexProcessResult> {
  if (scope.runtime === "tmux" || (typeof scope.tmuxPane === "string" && scope.tmuxPane !== "")) {
    const pane = typeof scope.tmuxPane === "string" ? scope.tmuxPane : "";
    if (pane === "") return { reason: "Codex terminal pane is unknown" };
    const stableId = typeof scope.tmuxSessionId === "string" && scope.tmuxSessionId !== "" ? scope.tmuxSessionId : undefined;
    const verified = await verifyTmuxPane(pane, process, stableId);
    if (verified.kind !== "ok" || !verified.value) return { reason: verified.kind === "ok" ? "Codex tmux pane is not present" : `Codex tmux pane could not be verified: ${verified.kind === "failed" ? verified.error : verified.reason}` };
    const pid = await getTmux().panePid(pane, process, stableId);
    if (pid.kind !== "ok" || !/^\d+$/.test(pid.value.trim())) return { reason: "Codex tmux pane PID could not be determined" };
    return { pid: Number(pid.value.trim()) };
  }

  const host = typeof scope.host === "string" ? scope.host : typeof scope.childHost === "string" ? scope.childHost : "";
  const terminalId = typeof scope.terminalId === "string" ? scope.terminalId : "";
  if (host !== "orca" || terminalId === "") return { reason: "Codex terminal process is unavailable" };
  const provider = getHost(host);
  const call = provider?.list({ workspaceId: null });
  if (call === undefined || call.kind !== "ok") return { reason: "Orca terminal process is unavailable" };
  const listed = await process.run(call.value.command, call.value.args);
  if (listed.kind !== "ok") return { reason: `Orca terminal process could not be read: ${listed.error}` };
  let parsed: unknown;
  try { parsed = JSON.parse(listed.value.stdout) as unknown; }
  catch { return { reason: "Orca terminal list returned invalid JSON" }; }
  const record = hostItems(parsed, host).find((item) => item.handle === terminalId);
  const pid = record?.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
    ? { pid }
    : { reason: `Orca terminal ${terminalId} has no process PID` };
}

export async function findCodexProcess(threadId: string, scope: CodexTerminalScope, process: ProcessAdapter): Promise<CodexProcessResult> {
  if (threadId === "") return { reason: "Codex thread identity is unknown" };
  const terminal = await terminalPid(scope, process);
  if (!("pid" in terminal)) return terminal;
  const listed = await process.run("ps", ["-ax", "-o", "pid=,ppid=,command="]);
  if (listed.kind !== "ok") return { reason: `Codex process tree could not be read: ${listed.error}` };
  const candidates = descendants(listed.value.stdout, terminal.pid);
  if (candidates.length === 0) return { reason: "no Codex process under the dispatch terminal" };
  let lsofReason = "";
  for (const pid of candidates) {
    const openFiles = await process.run("lsof", ["-p", String(pid), "-Fn"]);
    if (openFiles.kind !== "ok") {
      lsofReason = `lsof could not verify Codex process ${pid}: ${openFiles.error}`;
      continue;
    }
    if (hasThreadRollout(openFiles.value.stdout, threadId)) return { pid };
    lsofReason = `Codex process ${pid} does not hold the rollout for thread ${threadId}`;
  }
  return { reason: lsofReason || "Codex rollout file is not open" };
}

// Resolves a Codex thread outside a megabrain-owned terminal. The rollout held open by the
// process is the identity proof; a matching command name alone is not enough to queue a message.
export async function findCodexProcessByThread(threadId: string, process: ProcessAdapter): Promise<CodexProcessResult> {
  if (threadId === "") return { reason: "Codex thread identity is unknown" };
  const listed = await process.run("ps", ["-ax", "-o", "pid=,command="]);
  if (listed.kind !== "ok") return { reason: `Codex process list could not be read: ${listed.error}` };
  const candidates = listed.value.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match !== null && codexCommand(match[2] ?? "") ? [match[1] as string] : [];
  });
  for (const candidate of candidates) {
    const pid = Number(candidate);
    const openFiles = await process.run("lsof", ["-p", candidate, "-Fn"]);
    if (openFiles.kind === "ok" && hasThreadRollout(openFiles.value.stdout, threadId)) return { pid };
  }
  return { reason: candidates.length === 0 ? "no Codex process is running" : `no Codex process holds the rollout for thread ${threadId}` };
}

export async function deliverCodexQueue(threadId: string, pid: number, message: string, process: ProcessAdapter): Promise<CodexQueueResult> {
  if (threadId === "" || !Number.isSafeInteger(pid) || pid <= 0) return { kind: "fallback", reason: "Codex process identity is unknown" };
  const openFiles = await process.run("lsof", ["-p", String(pid), "-Fn"]);
  if (openFiles.kind !== "ok") return { kind: "fallback", reason: `lsof could not verify Codex process ${pid}: ${openFiles.error}` };
  if (!hasThreadRollout(openFiles.value.stdout, threadId)) return { kind: "fallback", reason: `Codex process ${pid} does not hold the rollout for thread ${threadId}` };
  const queued = await process.run("codex", ["queue", "--thread", threadId, "--message", message]);
  return queued.kind === "ok" ? { kind: "queued" } : { kind: "fallback", reason: "Codex queue rejected the message" };
}
