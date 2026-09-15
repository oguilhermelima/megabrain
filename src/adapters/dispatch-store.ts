import { readdir, stat } from "node:fs/promises";
import { failed, ok, type Result } from "../core/result.js";
import { resolveDispatchId } from "../core/dispatch-paths.js";

export type DispatchHandle = Readonly<{ dispatchId: string; directory: string }>;
export type DispatchFile = "meta" | "messages" | "deliveries" | "transcript" | "message-lock" | "nudge" | "nudge-lock" | "waiter";

export async function resolveDispatchDirectory(stateDirectory: string, dispatchId: string): Promise<Result<DispatchHandle>> {
  const valid = resolveDispatchId(dispatchId);
  if (valid.kind === "invalid") return failed(`invalid dispatch id: ${dispatchId}`);
  const root = `${stateDirectory}/dispatches`;
  const live = `${root}/${dispatchId}`;
  if (await exists(live)) return ok({ dispatchId, directory: live });
  const months = (await readdir(`${root}/archive`, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const month of months) {
    const archived = `${root}/archive/${month}/${dispatchId}`;
    if (await exists(archived)) return ok({ dispatchId, directory: archived });
  }
  return ok({ dispatchId, directory: live });
}

export function dispatchFile(handle: DispatchHandle, file: DispatchFile): string {
  const names: Readonly<Record<DispatchFile, string>> = {
    meta: "meta.json",
    messages: "messages",
    deliveries: "deliveries",
    transcript: "transcript",
    "message-lock": "messages/.lock",
    nudge: "nudge.log",
    "nudge-lock": ".nudge.lock",
    waiter: "waiter.json",
  };
  return `${handle.directory}/${names[file]}`;
}

export function dispatchDeliveryFile(handle: DispatchHandle, deliveryId: string): string {
  return `${dispatchFile(handle, "deliveries")}/${deliveryId}.json`;
}

export function dispatchMessageFile(handle: DispatchHandle, messageName: string): string {
  return `${dispatchFile(handle, "messages")}/${messageName}`;
}

export async function dispatchPath(stateDirectory: string, dispatchId: string, relative: string): Promise<string> {
  const resolved = await resolveDispatchDirectory(stateDirectory, dispatchId);
  if (resolved.kind !== "ok") throw new Error(resolved.error);
  return `${resolved.value.directory}/${relative}`;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
