import { existsSync, readdirSync } from "node:fs";import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";import { randomUUID } from "node:crypto";import { basename, dirname, resolve } from "node:path";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { nextBackupPath } from "../../../core/tmux.js";import { mutateInstallModule, putInstallModule, stateDatabase } from "../../../adapters/state-db.js";
import type { Environment } from "./diagnostics.js";
export type InstallOptions = Readonly<{ yes: boolean; browser: string }>;

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY);
}

export function writeInstalledState(environment: Environment, module: string, installed: boolean, details: string): void {
  const configuredAt = new Date().toISOString();
  const opened = stateDatabase(environment);
  if (opened.kind !== "ok") return;
  const updated = mutateInstallModule(opened.value, module, (value) => {
    const previous = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return { ...previous, installed, configuredAt, statusSource: "megabrain install", details };
  });
  if (updated.kind !== "ok") return;
  putInstallModule(opened.value, "_meta", { kind: "installation-record", recordedAt: configuredAt, source: "megabrain install", liveStatusCommand: "megabrain doctor" });
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

