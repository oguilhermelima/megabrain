import { createConnection } from "node:net";
import { unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function chatSocket(stateDir: string): string { return join(stateDir, "chatd", "s"); }
export function chatPid(stateDir: string): string { return join(stateDir, "chatd", "chatd.pid"); }
export function chatLock(stateDir: string): string { return join(stateDir, "chatd", "start.lock"); }
/** Chats whose queued messages a drained chatd left for its successor to send. */
export function chatResumes(stateDir: string): string { return join(stateDir, "chatd", "resume.json"); }
export function chatChildRecord(stateDir: string, chatId: string): string { return join(stateDir, "chatd", "children", `${chatId}.json`); }

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export async function filePid(path: string): Promise<number> {
  try { return Number((await readFile(path, "utf8")).trim()); } catch { return 0; }
}
/** A dead chatd leaves its socket file behind; only a refused or missing socket counts as stale, a slow one is alive. */
export async function socketAccepts(stateDir: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(chatSocket(stateDir));
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT" && error.code !== "ENOTSOCK"); });
  });
}
export async function discardStaleState(stateDir: string, options: { pid: boolean }): Promise<void> {
  try { await unlink(chatSocket(stateDir)); } catch { /* no stale socket */ }
  if (options.pid) { try { await unlink(chatPid(stateDir)); } catch { /* no stale pid */ } }
}
/** Stops an agent this daemon ran and waits (bounded) until it is gone, so nothing checks for holders while it still runs. */
export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = () => new Promise<void>((resolve) => child.once("close", () => resolve()));
  let exited = gone();
  child.kill("SIGTERM");
  const timeout = new Promise<false>((resolve) => { const timer = setTimeout(() => resolve(false), 2000); timer.unref?.(); });
  if (await Promise.race([exited.then(() => true), timeout])) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  exited = gone();
  child.kill("SIGKILL");
  await exited;
}
