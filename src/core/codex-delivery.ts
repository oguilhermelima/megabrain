import type { ProcessAdapter } from "../adapters/proc.js";

export type CodexQueueResult = Readonly<{ kind: "queued" }> | Readonly<{ kind: "fallback"; reason: string }>;

function hasThreadEnvironment(output: string, threadId: string): boolean {
  return output.split(/\s+/).some((value) => value === `CODEX_THREAD_ID=${threadId}`);
}

export async function findCodexProcessId(threadId: string, process: ProcessAdapter): Promise<number | undefined> {
  if (threadId === "") return undefined;
  const listed = await process.run("ps", ["eww", "-ax", "-o", "pid=,command="]);
  if (listed.kind !== "ok") return undefined;
  for (const line of listed.value.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null || !hasThreadEnvironment(match[2] ?? "", threadId)) continue;
    const command = match[2] ?? "";
    if (/(?:^|\/)codex(?:\s|$)/.test(command)) return Number(match[1]);
  }
  return undefined;
}

export async function deliverCodexQueue(threadId: string, pid: number, message: string, process: ProcessAdapter): Promise<CodexQueueResult> {
  if (threadId === "" || !Number.isSafeInteger(pid) || pid <= 0) return { kind: "fallback", reason: "Codex process identity is unknown" };
  const inspected = await process.run("ps", ["eww", "-p", String(pid), "-o", "command="]);
  if (inspected.kind !== "ok" || !hasThreadEnvironment(inspected.value.stdout, threadId)) {
    return { kind: "fallback", reason: "Codex process is not alive" };
  }
  const queued = await process.run("codex", ["queue", "--thread", threadId, "--message", message]);
  return queued.kind === "ok" ? { kind: "queued" } : { kind: "fallback", reason: "Codex queue rejected the message" };
}
