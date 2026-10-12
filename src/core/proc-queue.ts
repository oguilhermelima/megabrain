import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { readAdmissionPolicy } from "../adapters/state/resources.js";
import { resolveCaller } from "../cli/commands/queue-write.js";
import { decideAdmission } from "./admission.js";
import { acquireHold, liveHolds } from "./proc-holds.js";
import { readMachineResources } from "./resources.js";
import { failed, ok, type Result } from "./result.js";
import { resolveStateDirectory } from "./state.js";

type Environment = Readonly<Record<string, string | undefined>>;

// A process waiting for admission. The waiting megabrain command owns the entry: it holds the
// queue position while alive, and an entry whose waiter died is dropped by the next reader.
export type ProcQueueEntry = Readonly<{
  id: string;
  name: string;
  worktree: string;
  owner: string;
  pid: number;
  createdAt: string;
  reason: string;
  cancelledReason?: string;
}>;

const POLL_MS = 1000;

// The same caller identity every dispatch verb uses, so a process belongs to the session that
// started it, not to the transient shell that ran one command.
export async function procOwner(environment: Environment, processAdapter: ProcessAdapter): Promise<string> {
  const caller = await resolveCaller(environment, processAdapter);
  return `${caller.host}/${caller.id || caller.terminalId || ""}`;
}

function queueDirectory(environment: Environment): string {
  return join(resolveStateDirectory(environment), "procs", "queue");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function writeEntry(environment: Environment, entry: ProcQueueEntry): Promise<void> {
  const directory = queueDirectory(environment);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${entry.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, `${entry.id}.json`));
}

async function readEntry(environment: Environment, id: string): Promise<ProcQueueEntry | undefined> {
  try { return JSON.parse(await readFile(join(queueDirectory(environment), `${id}.json`), "utf8")) as ProcQueueEntry; } catch { return undefined; }
}

async function removeEntry(environment: Environment, id: string): Promise<void> {
  await rm(join(queueDirectory(environment), `${id}.json`), { force: true });
}

// Live entries in queue order. Entries left by a dead waiter are removed on the way.
export async function listProcQueue(environment: Environment): Promise<ProcQueueEntry[]> {
  const files = (await readdir(queueDirectory(environment)).catch(() => [])).filter((file) => file.endsWith(".json") && !file.startsWith("."));
  const entries: ProcQueueEntry[] = [];
  for (const file of files) {
    const entry = await readEntry(environment, file.slice(0, -".json".length));
    if (entry === undefined) continue;
    if (!alive(entry.pid)) { await removeEntry(environment, entry.id); continue; }
    entries.push(entry);
  }
  return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function cancelProcQueueEntry(environment: Environment, id: string, owner: string, reason: string): Promise<Result<ProcQueueEntry> | undefined> {
  const entry = (await listProcQueue(environment)).find((item) => item.id === id);
  if (entry === undefined) return undefined;
  if (entry.owner !== owner) return failed(`queued item ${id} is not owned by this caller`);
  // The waiter reads the mark, removes its entry and exits without starting anything.
  await writeEntry(environment, { ...entry, cancelledReason: reason });
  return ok(entry);
}

export const PROC_SLOTS = ["container-suite"] as const;
export type ProcSlot = (typeof PROC_SLOTS)[number];

// Blocks until the admission policy admits the process. Without a policy it returns at once,
// so nothing changes for anyone who has not opted in. Only the head of the queue is judged, so
// processes start in the order they asked. A process that takes a slot gets the slot's hold,
// held by this command, before it leaves the queue; the result is that hold's id.
export async function awaitProcAdmission(
  request: Readonly<{ name: string; worktree: string; mode: "wait" | "fail"; slot?: ProcSlot }>,
  environment: Environment,
  processAdapter: ProcessAdapter,
): Promise<Result<string | undefined>> {
  const admit = async (): Promise<Result<string | undefined>> =>
    ok(request.slot === undefined ? undefined : await acquireHold(environment, `slot-${request.slot}`, process.pid));
  let entry: ProcQueueEntry | undefined;
  let announced = false;
  try {
    for (;;) {
      const policy = await readAdmissionPolicy(environment);
      if (policy === undefined) return admit();
      if (entry !== undefined) {
        const current = await readEntry(environment, entry.id);
        if (current?.cancelledReason !== undefined) return failed(`proc ${request.name} cancelled while queued: ${current.cancelledReason}`);
      }
      const queue = (await listProcQueue(environment)).filter((item) => item.cancelledReason === undefined);
      const ahead = entry === undefined ? queue.length : queue.findIndex((item) => item.id === entry?.id);
      let reason: string;
      if (ahead === 0) {
        const decision = decideAdmission({ kind: request.slot ?? "process", agent: "proc", estimatedCostBytes: 0 }, policy, {
          machine: await readMachineResources(processAdapter), runningAgents: 0,
          runningContainerSuites: await liveHolds(environment, "slot-container-suite"),
        });
        if (decision.status === "admitted") return admit();
        if (decision.status === "refused") return failed(`proc ${request.name} refused: ${decision.reason}`);
        reason = decision.reason;
      } else {
        reason = `${ahead} earlier process${ahead === 1 ? "" : "es"} waiting`;
      }
      if (request.mode === "fail") return failed(`proc ${request.name} refused: ${reason}`);
      entry = {
        ...(entry ?? {
          id: `proc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, name: request.name, worktree: request.worktree,
          owner: await procOwner(environment, processAdapter), pid: process.pid, createdAt: new Date().toISOString(),
        }),
        reason,
      };
      await writeEntry(environment, entry);
      if (!announced) {
        process.stderr.write(`queued ${entry.id} (position ${ahead + 1}): ${reason}\n`);
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    if (entry !== undefined) await removeEntry(environment, entry.id);
  }
}
