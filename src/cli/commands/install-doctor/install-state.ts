import { existsSync, readdirSync } from "node:fs";import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";import { randomUUID } from "node:crypto";import { basename, dirname, resolve } from "node:path";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { nextBackupPath } from "../../../core/tmux.js";import { getInstallState, readOnlyStateDatabase } from "../../../adapters/state-db.js";import { callStateOwner } from "../../../db/state-owner.js";
import type { Environment } from "./diagnostics.js";
export type InstallOptions = Readonly<{ yes: boolean; browser: string }>;

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY);
}

export async function writeInstalledState(environment: Environment, module: string, installed: boolean, details: string): Promise<Result<void>> {
  const configuredAt = new Date().toISOString();
  const opened = readOnlyStateDatabase(environment);
  if (opened.kind !== "ok") return opened;
  const state = getInstallState(opened.value);
  if (state.kind !== "ok") return state;
  const current = state.value[module];
  const previous = typeof current === "object" && current !== null && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const stateDir = environment.MEGABRAIN_STATE_DIR ?? resolve(environment.HOME ?? process.cwd(), ".megabrain");
  try {
    await callStateOwner(stateDir, { operation: "install-state-write", moduleId: module, value: { ...previous, installed, configuredAt, statusSource: "megabrain install", details } });
    await callStateOwner(stateDir, { operation: "install-state-write", moduleId: "_meta", value: { kind: "installation-record", recordedAt: configuredAt, source: "megabrain install", liveStatusCommand: "megabrain doctor" } });
    return ok(undefined);
  } catch (cause: unknown) {
    return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function dateStamp(processAdapter: ProcessAdapter): Promise<string> {
  const result = await processAdapter.run("date", ["-u", "+%Y%m%dT%H%M%SZ"]);
  if (result.kind === "ok") return result.value.stdout.trim();
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function backupExistingFile(path: string, processAdapter: ProcessAdapter): Promise<Result<string | undefined>> {
  if (!existsSync(path)) return ok(undefined);
  const directory = dirname(path);
  const prefix = `${basename(path)}.megabrain-backup-`;
  let existingBackups: Set<string>;
  try {
    existingBackups = new Set(readdirSync(directory).filter((name) => name.startsWith(prefix)).map((name) => resolve(directory, name)));
  } catch {
    existingBackups = new Set();
  }
  const stamp = await dateStamp(processAdapter);
  const backup = nextBackupPath(path, true, stamp, existingBackups);
  if (backup === undefined) return ok(undefined);
  try {
    await copyFile(path, backup);
  } catch {
    return failed(`could not back up ${path}`);
  }
  return ok(backup);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

