import type { ProcessAdapter } from "../adapters/proc.js";

/** True only when the recorded receiver is alive and belongs to the terminal's foreground group. */
export async function agentOwnsForegroundProcess(agent: string, pid: number, process: ProcessAdapter): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !["claude", "codex", "grok", "agy"].includes(agent)) return false;
  const result = await process.run("ps", ["-ww", "-p", String(pid), "-o", "pid=,pgid=,tpgid=,args="]);
  if (result.kind !== "ok") return false;
  const line = result.value.stdout.trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (match === null || Number(match[1]) !== pid || match[2] !== match[3]) return false;
  const command = match[4]!.trim();
  if (/^(?:-?(?:zsh|bash|sh|fish))(?:\s|$)/i.test(command)) return false;
  const escaped = agent === "agy" ? /(?:^|[\s/])agy(?:\s|$)/i : new RegExp(`(?:^|[\\s/])${agent}(?:\\s|$)`, "i");
  return escaped.test(command);
}
